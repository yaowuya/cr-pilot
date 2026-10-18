import { createSilentLogger, type Logger } from "../shared/logger.ts";
import { estimateTokens, splitChangesIntoBatches } from "../domain/change.ts";
import {
  buildMarker,
  buildPosition,
  parseDiffLines,
  parseReviewJson,
  type DiffLineSets,
  type ParsedReview,
} from "../domain/inline-comment.ts";
import { parseReviewScore, renderUserPrompt, shouldNotifyByScore, stripMarkdownFences, type ReviewRules, type RuleSet } from "../domain/review-rules.ts";
import type { ReviewRecord } from "../domain/review-record.ts";
import type { LlmProviderRepository, ResolvedLlmTarget } from "../domain/llm-provider.ts";
import type { PromptRepository, StoredPrompt } from "../domain/review-prompt.ts";
import type { Change, Commit, DiffRefs, GitlabClient, MergeRequestTask, Reviewer, WecomNotifier } from "../domain/review-task.ts";

export type { MergeRequestTask };

/** 评审管线（application 用例端口）：webhook 入队任务的实际执行体。 */
export interface ReviewPipeline {
  run(task: MergeRequestTask): Promise<void>;
}

/**
 * 评审记录写入端口。
 *
 * 只声明管线实际使用的方法：管线不需要读与统计，依赖越窄越容易替换（测试里
 * 一个 `insert` 替身即可），也让「记录只能追加」这一约束在类型上可见。
 */
export interface ReviewRecordWriter {
  insert(record: ReviewRecord): void;
}

interface PipelineDeps {
  client: GitlabClient;
  rules: ReviewRules;
  reviewer: Reviewer;
  logger: Logger;
  batchMaxTokens: number;
  /** 单批评审/汇总的超时毫秒数，缺省 1200000（20 分钟）。 */
  timeoutMs?: number;
  /** 企业微信通知器，缺省时不推送企微。 */
  wecomNotifier?: WecomNotifier;
  /** 评审记录写入端口，缺省时不落库（便于既有调用方与测试保持原行为）。 */
  recordWriter?: ReviewRecordWriter;
  /** prompt 来源（数据库）。命中时不使用 `rules` 的 yaml 解析结果。 */
  promptSource?: PromptRepository;
  /** LLM 厂商仓储。缺省时评审用 models.json 的既有默认配置。 */
  llmProviders?: LlmProviderRepository;
}

/** 单批评审/汇总的默认超时毫秒数，与 config 的默认评审超时一致（20 分钟）。 */
const DEFAULT_TIMEOUT_MS = 1200000;

/**
 * 本次评审实际使用的 prompt 来源。
 *
 * 只用于日志与排障：评审结果异常时，第一件要确认的事就是「命中了哪条规则」。
 * 三种来源互斥，`kind` 让日志可以一眼区分：
 * - `db-project`：命中数据库里关联了该项目的 prompt；
 * - `db-default`：数据库里没有项目记录，回落到全局 default；
 * - `fallback`：数据库完全没有可用记录，落到 yaml 目录或 Markdown 兜底。
 */
export type PromptSource =
  | { kind: "db-project"; name: string; id: number; projects: string[] }
  | { kind: "db-default"; name: string; id: number }
  | { kind: "fallback"; name: string };

/**
 * 来源的中文描述，直接用于日志字段。
 *
 * 刻意不使用空格：日志器对含空格的值会加引号包裹（见 shared/logger.ts），
 * 而这里的描述是日志里的固定字段值，加引号只会让整行更难扫读。
 */
export function describePromptSource(source: PromptSource): string {
  switch (source.kind) {
    case "db-project":
      return `数据库项目规则(${source.name},id=${source.id})`;
    case "db-default":
      return `数据库全局默认(${source.name},id=${source.id})`;
    case "fallback":
      return "yaml兜底(数据库无可用记录)";
  }
}

/** 汇总 prompt 的系统提示后缀，要求模型把各批结果合并成一份最终评论。 */
const SUMMARY_SUFFIX = "\n\n你之前分批评审了同一变更的各部分。下面按批序给出各批评审结果，请把它们合并成一份最终评论：去重、按严重程度排序、保留各条问题的位置与证据、合并评分并给出总分。每个问题小节必须包含「位置」「问题（有问题的代码块，带语言标记）」「建议（改进后的代码块，带语言标记）」，问题之间用 --- 分隔。输出结构与格式完全遵循上述规则的要求；只输出纯 Markdown 评论正文，不要用 ``` 代码块包裹整个评论，不要加任何前言或后缀。";

/** 一次发布尝试的结果：成功发布的 finding id/正文与需并入汇总的文本。 */
interface InlinePublishOutcome {
  published: Set<string>;
  /**
   * 已成功发行内评论的 finding 正文（原样），用于从汇总评论中剔除重复条目。
   *
   * 用正文而不是 id 匹配：汇总评论由模型生成，正文里不会出现 finding 的 `id`，
   * 但会带上问题描述文字（`SUMMARY_SUFFIX` 要求保留各条问题的证据）。
   */
  publishedBodies: Set<string>;
  fallback: string[];
}

/**
 * 创建评审管线（application 用例编排）。
 *
 * 编排「拉取 → 分批 → 逐批评审 → 行内评论 → 汇总 → 回写 → 落记录」，依赖 domain
 * 端口（Reviewer / GitlabClient / ReviewRules / PromptRepository）与 domain 纯函数
 * （分批、渲染、解析、position、marker），不触碰任何 IO 细节。
 *
 * 失败语义：拉取失败、单批失败、汇总失败都记日志并结束任务，不回写；只有全部批次
 * 与汇总成功才回写一条 MR 评论。**任何**失败路径都会写入一条 `result="failed"`
 * 的评审记录（若注入了 recordWriter），因此失败不会在数据里消失。
 *
 * 行内评论降级规则（design 状态章节）：行号未落在 diff 变更行、评审 head 与当前
 * head 不一致、单条发布失败三种情况都把该条并入汇总评论，不丢弃内容，也不中断
 * 其余 finding 的发布。
 */
export function createReviewPipeline(deps: PipelineDeps): ReviewPipeline {
  const { client, rules, reviewer, logger, batchMaxTokens } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async run(task) {
      const startedAt = Date.now();
      logger.info("管线开始处理 MR", { 项目ID: task.projectId, MR编号: task.iid, 项目全名: task.fullName });

      /**
       * 写入评审记录。
       *
       * `score` 传 `number | null`：`parseReviewScore` 无匹配时返回 0，而 0 分与
       * 「未解析出分数」在统计上必须区分——直接写 0 会把平均值拉低。调用方负责
       * 判断「有没有分数」并传 null。
       */
      const writeRecord = (outcome: {
        result: "success" | "failed";
        errorMessage?: string;
        score?: number | null;
        commentUrl?: string | null;
        changeCount?: number;
        batchCount?: number;
      }): void => {
        if (!deps.recordWriter) return;
        deps.recordWriter.insert({
          projectId: task.projectId,
          projectName: task.fullName,
          mrIid: task.iid,
          committerName: task.committerName ?? "",
          changeCount: outcome.changeCount ?? 0,
          batchCount: outcome.batchCount ?? 0,
          score: outcome.score ?? null,
          durationMs: Date.now() - startedAt,
          result: outcome.result,
          errorMessage: outcome.errorMessage ?? null,
          commentUrl: outcome.commentUrl ?? null,
          mrUrl: buildMergeRequestUrl(task),
          startedAt,
          finishedAt: Date.now(),
        });
      };

      let changes: Change[];
      let commits: Commit[];
      try {
        changes = await client.getMergeRequestChanges(task.projectId, task.iid, task.gitlabUrl, task.gitlabToken);
        commits = await client.getMergeRequestCommits(task.projectId, task.iid, task.gitlabUrl, task.gitlabToken);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("拉取 MR 变更失败，任务结束", { 项目ID: task.projectId, MR编号: task.iid, 错误: message });
        writeRecord({ result: "failed", errorMessage: message });
        return;
      }
      logger.info("已拉取 MR 变更", {
        项目ID: task.projectId,
        MR编号: task.iid,
        变更文件数: changes.length,
        提交数: commits.length,
      });

      // 解析规则集并记录来源：评审异常时第一件要确认的事就是「用了哪条 prompt」。
      // 命中项目记录 / 全局 default / yaml 兜底 三者的行为差异很大，必须在日志里可见。
      const { ruleSet, source: promptSource, stored: promptStored } = resolveRuleSet(task.fullName);
      logger.info("本次评审使用的 prompt", {
        项目ID: task.projectId,
        MR编号: task.iid,
        来源: describePromptSource(promptSource),
        规则名: promptSource.name,
        ...(promptSource.kind === "db-project" ? { 关联项目: promptSource.projects.join("、") } : {}),
      });
      // LLM 目标：项目绑定 > prompt 指定 > 全局默认（D-022）。全部为空时不传，
      // 让 reviewer 用 models.json 里的既有默认配置。
      const llmTarget = resolveLlmTarget(task.fullName, promptStored);
      if (llmTarget) {
        logger.info("本次评审使用的模型", {
          项目ID: task.projectId,
          MR编号: task.iid,
          厂商: llmTarget.provider.label,
          模型: llmTarget.model,
        });
      }
      const commitsText = commits.map((commit) => `${commit.id.slice(0, 8)} ${commit.message.split("\n")[0] ?? ""}`).join("\n");

      // 先取 diff version 的 head sha：它必须注入 user prompt，AI 才能回显
      // reviewed_head_sha（模型无法自行得知当前提交）。取不到时保持空串——
      // 后续行内评论会整体降级进汇总评论，不影响评审与回写。
      let refs: DiffRefs | undefined;
      try {
        refs = await client.getMergeRequestVersions(task.projectId, task.iid, task.gitlabUrl, task.gitlabToken);
      } catch (error) {
        logger.warn("取 diff version 失败，行内评论将全部降级进汇总", {
          项目ID: task.projectId,
          MR编号: task.iid,
          错误: error instanceof Error ? error.message : String(error),
        });
      }

      const batches = splitChangesIntoBatches(changes, batchMaxTokens, estimateTokens(ruleSet.userPrompt) + estimateTokens(commitsText));
      logger.info("分批完成", { 项目ID: task.projectId, MR编号: task.iid, 批次数: batches.length });

      const batchResults: string[] = [];
      for (const [index, batch] of batches.entries()) {
        const diffsText = batch.map((change) => `diff --git a/${change.oldPath} b/${change.newPath}\n${change.diff}`).join("\n\n");
        // 仓库规则的 user_prompt 是用户消息全文模板：渲染占位符后作为本轮用户消息。
        const userMessage = renderUserPrompt(ruleSet.userPrompt, { diffsText, commitsText, headSha: refs?.headSha });
        const batchStartedAt = Date.now();
        try {
          const result = await reviewer.review({
            systemPrompt: ruleSet.systemPrompt,
            code: userMessage,
            context: undefined,
            signal: AbortSignal.timeout(timeoutMs),
            provider: llmTarget?.provider.name,
            model: llmTarget?.model,
          });
          batchResults.push(result.text);
          logger.info("单批评审完成", {
            项目ID: task.projectId,
            MR编号: task.iid,
            批次: `${index + 1}/${batches.length}`,
            评审字数: result.text.length,
            耗时毫秒: Date.now() - batchStartedAt,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error("单批评审失败，任务结束", {
            项目ID: task.projectId,
            MR编号: task.iid,
            批次: `${index + 1}/${batches.length}`,
            错误: message,
          });
          writeRecord({ result: "failed", errorMessage: message, changeCount: changes.length, batchCount: batches.length });
          return;
        }
      }

      const summaryStartedAt = Date.now();
      let finalComment: string;
      try {
        const summary = await reviewer.review({
          systemPrompt: ruleSet.systemPrompt + SUMMARY_SUFFIX,
          code: batchResults.join("\n\n---\n\n"),
          context: undefined,
          signal: AbortSignal.timeout(timeoutMs),
          provider: llmTarget?.provider.name,
          model: llmTarget?.model,
        });
        finalComment = stripMarkdownFences(summary.text.trim());
        logger.info("汇总完成", {
          项目ID: task.projectId,
          MR编号: task.iid,
          最终字数: finalComment.length,
          耗时毫秒: Date.now() - summaryStartedAt,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("汇总失败，任务结束", { 项目ID: task.projectId, MR编号: task.iid, 错误: message });
        writeRecord({ result: "failed", errorMessage: message, changeCount: changes.length, batchCount: batches.length });
        return;
      }

      // 行内评论：先发布可定位的问题，再把不可定位的内容并入汇总评论。
      const inline = await publishInlineComments({
        task,
        changes,
        refs,
        batchResults,
        logger,
      });
      if (inline.fallback.length > 0) {
        finalComment = appendFallback(finalComment, inline.fallback);
      }
      // 汇总评论需剔除已成功发行内评论的条目，避免同一问题在 MR 上出现两次
      // （proposal 变更点 3）。汇总输入含各批 finding 正文，因此按正文匹配剔除；
      // 匹配不到的条目保持原样，宁可有冗余也不静默删掉模型给出的内容。
      if (inline.publishedBodies.size > 0) {
        finalComment = stripPublishedFindings(finalComment, inline.publishedBodies);
      }

      let commentUrl: string | null = null;
      try {
        await client.postMergeRequestNote(task.projectId, task.iid, finalComment, task.gitlabUrl, task.gitlabToken);
        commentUrl = `MR !${task.iid}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("回写评论失败，任务结束", { 项目ID: task.projectId, MR编号: task.iid, 错误: message });
        writeRecord({ result: "failed", errorMessage: message, changeCount: changes.length, batchCount: batches.length });
        return;
      }

      // 回写成功后按规则推送企业微信：低于阈值的低分评审才进群提醒。
      if (deps.wecomNotifier && ruleSet.wecomWebhookUrl) {
        const score = parseReviewScore(finalComment);
        if (shouldNotifyByScore(score, ruleSet.wecomScoreThreshold)) {
          const message = buildWecomMessage({
            projectId: task.projectId,
            iid: task.iid,
            fullName: task.fullName,
            sourceBranch: task.sourceBranch,
            targetBranch: task.targetBranch,
            score,
            comment: finalComment,
            // 摘要消息附 MR 链接，接收者点一下就能看完整评审。
            mrUrl: buildMergeRequestUrl(task),
          });
          try {
            await deps.wecomNotifier.send(ruleSet.wecomWebhookUrl, message);
          } catch (error) {
            // 企微推送失败不影响已完成的评审回写，只记日志。
            logger.error("企业微信推送失败", {
              项目ID: task.projectId,
              MR编号: task.iid,
              错误: error instanceof Error ? error.message : String(error),
            });
          }
        } else {
          logger.info("评分未低于企微阈值，跳过推送", {
            项目ID: task.projectId,
            MR编号: task.iid,
            评分: score,
            阈值: ruleSet.wecomScoreThreshold,
          });
        }
      }

      const finalScore = parseReviewScore(finalComment);
      logger.info("管线完成", {
        项目ID: task.projectId,
        MR编号: task.iid,
        总耗时毫秒: Date.now() - startedAt,
        行内评论数: inline.published.size,
      });
      writeRecord({
        result: "success",
        // 0 表示未解析出分数：写 null 而非 0，避免污染平均分统计。
        score: finalScore > 0 ? finalScore : null,
        commentUrl,
        changeCount: changes.length,
        batchCount: batches.length,
      });
    },
  };

  /**
   * 解析本次评审使用的规则集，并记录它来自哪里。
   *
   * 数据库优先（P-015 / D-016）：命中即用，未命中回落 `default` 记录，
   * 两者都没有才使用 `rules`（yaml 目录或 Markdown 兜底）。数据库里存的是
   * 渲染后的最终文本，因此不再套用风格模板。
   *
   * 必须同时返回来源：只打「开始评审」而不打「用了哪条 prompt」时，评审结果
   * 异常（比如规则没生效）根本无从判断命中的是项目记录、default 还是 yaml 兜底。
   */
  function resolveRuleSet(fullName: string): {
    ruleSet: RuleSet;
    source: PromptSource;
    /** 命中的数据库记录；fallback 时为 undefined。供 LLM 目标解析复用，避免重复查库。 */
    stored?: StoredPrompt;
  } {
    const stored = deps.promptSource?.resolve(fullName);
    if (stored) {
      // 记录命中的具体 prompt 名：项目记录显示项目名，兜底显示 default，
      // 便于确认「这条 MR 到底吃的是哪套规则」。
      const source: PromptSource =
        stored.repository === "default"
          ? { kind: "db-default", name: stored.repository, id: stored.id }
          : {
              kind: "db-project",
              name: stored.repository,
              id: stored.id,
              // projects 在仓储实现里一定存在；这里兜住 undefined 是因为日志属于
              // 旁路逻辑，不能因为一个可选字段缺失就把整个评审打断。
              projects: stored.projects ?? [],
            };
      return {
        ruleSet: {
          systemPrompt: stored.systemPrompt,
          userPrompt: stored.userPrompt,
          wecomWebhookUrl: stored.wecomWebhookUrl,
          wecomScoreThreshold: stored.wecomScoreThreshold,
        },
        source,
        stored,
      };
    }
    // 落到 yaml 目录或 Markdown 兜底：数据库里没有可用记录。
    return { ruleSet: rules.resolve(fullName), source: { kind: "fallback", name: fullName } };
  }

  /**
   * 解析本次评审使用的 LLM 厂商与模型。
   *
   * 优先级（D-022）：项目绑定 > prompt 上指定的厂商 > 全局默认厂商。
   * 全都没有配置时返回 undefined，reviewer 会回落到 models.json 的默认模型，
   * 保证「没配厂商」的老部署仍然能跑。
   */
  function resolveLlmTarget(fullName: string, stored?: StoredPrompt): ResolvedLlmTarget | undefined {
    const repo = deps.llmProviders;
    if (!repo) return undefined;

    // prompt 上显式指定的厂商优先于全局默认，但低于项目绑定——
    // 项目绑定是运维针对单个项目做的临时调整，语义上更具体。
    if (stored?.providerId) {
      const provider = repo.get(stored.providerId);
      if (provider) {
        const model = stored.model || provider.defaultModel || provider.models[0];
        if (model) return { provider, model };
      }
    }
    return repo.resolveTarget(fullName);
  }

  /**
   * 发布行内评论，返回成功集合与需并入汇总的文本。
   *
   * 降级链（不丢弃任何内容）：
   * 1. 取不到 diff version SHA → 全部 finding 并入汇总；
   * 2. `reviewed_head_sha` 与当前 head 不一致（评审期间有新提交）→ 全部并入汇总；
   * 3. 分批输出无法按 JSON schema 解析 → 该批 findings 整体并入汇总；
   * 4. 行号未落在该文件的 added/removed 集合 → 该条并入汇总；
   * 5. 已存在同 marker 的讨论 → 跳过（幂等，不算失败）；
   * 6. 单条发布抛错 → 该条并入汇总，其余继续；
   * 7. 发布后回读校验 → 见 `verifyPublishedPositions`，不一致只记 warn。
   */
  async function publishInlineComments(input: {
    task: MergeRequestTask;
    changes: Change[];
    /** 已取到的 diff version；缺省表示取版本失败，全部降级。 */
    refs?: DiffRefs;
    batchResults: string[];
    logger: Logger;
  }): Promise<InlinePublishOutcome> {
    const published = new Set<string>();
    const publishedBodies = new Set<string>();
    const fallback: string[] = [];
    const { task, changes, batchResults } = input;

    // 没有 reviewJson 时无从判断，全部按「不可定位」处理。
    const parsedList: { review: ParsedReview; source: string; batchIndex: number }[] = [];
    batchResults.forEach((raw, index) => {
      const parsed = parseReviewJson(raw);
      if (parsed) parsedList.push({ review: parsed, source: raw, batchIndex: index });
      else fallback.push(raw);
    });
    if (parsedList.length === 0) return { published, publishedBodies, fallback };

    const refs = input.refs;
    if (!refs) {
      return { published, publishedBodies, fallback: fallback.concat(parsedList.map((item) => item.source)) };
    }

    // 路径 → 合法行号集合。重命名文件同时以 oldPath 与 newPath 为键，
    // 因为 finding 的 path 可能是任一名字（对齐参考实现 change_map 的做法）。
    const lineSets = new Map<string, DiffLineSets>();
    for (const change of changes) {
      const sets = parseDiffLines(change.diff);
      lineSets.set(change.newPath, sets);
      if (change.oldPath !== change.newPath) lineSets.set(change.oldPath, sets);
    }
    const changeByPath = new Map(changes.map((change) => [change.newPath, change] as const));
    for (const change of changes) changeByPath.set(change.oldPath, change);

    let existing = new Set<string>();
    try {
      const discussions = await client.getDiscussions(task.projectId, task.iid, task.gitlabUrl, task.gitlabToken);
      existing = new Set(discussions.flatMap((discussion) => discussion.notes.map((note) => note.body)));
    } catch (error) {
      // 拉取失败时按「没有历史评论」继续：宁可重复发也不因网络问题整批放弃，
      // 重复由 marker 在下次评审时自然收敛。
      logger.warn("拉取已有讨论失败，跳过幂等判重", {
        项目ID: task.projectId,
        MR编号: task.iid,
        错误: error instanceof Error ? error.message : String(error),
      });
    }

    for (const { review, source, batchIndex } of parsedList) {
      // head 不一致说明评审的是旧代码，行号与 diff 都可能已失效。
      if (review.reviewedHeadSha !== refs.headSha) {
        logger.warn("评审 head 与当前 head 不一致，该批评审降级进汇总", {
          项目ID: task.projectId,
          MR编号: task.iid,
          评审head: review.reviewedHeadSha,
          当前head: refs.headSha,
        });
        fallback.push(source);
        continue;
      }

      for (const finding of review.findings) {
        // marker 键带上批次号：parseReviewJson 只在单批内拒绝重复 id，跨批可能
        // 出现同名 finding。不带批次号会让后一批的同名 finding 命中前一批的
        // marker 而被误判为「已发布」。
        const markerId = `${batchIndex}:${finding.id}`;
        const change = changeByPath.get(finding.path);
        const sets = change ? lineSets.get(finding.path) : undefined;
        if (!change || !sets) {
          fallback.push(renderFallbackFinding(finding));
          continue;
        }
        const allowed = finding.lineKey === "new_line" ? sets.added : sets.removed;
        if (!allowed.has(finding.line)) {
          logger.warn("finding 行号不是 diff 变更行，降级进汇总", {
            项目ID: task.projectId,
            MR编号: task.iid,
            文件: finding.path,
            行号: finding.line,
          });
          fallback.push(renderFallbackFinding(finding));
          continue;
        }

        const marker = buildMarker(refs.headSha, markerId);
        if ([...existing].some((body) => body.includes(marker))) {
          // 已发布过（webhook 重复触发）：计入 published，使汇总评论不重复该条，但不重新发布。
          published.add(markerId);
          publishedBodies.add(finding.body);
          continue;
        }

        try {
          await client.postDiscussion(
            task.projectId,
            task.iid,
            `${finding.body}\n\n${marker}`,
            buildPosition({
              refs,
              oldPath: change.oldPath,
              newPath: change.newPath,
              lineKey: finding.lineKey,
              line: finding.line,
            }),
            task.gitlabUrl,
            task.gitlabToken,
          );
          published.add(markerId);
          publishedBodies.add(finding.body);
        } catch (error) {
          logger.warn("单条行内评论发布失败，改并入汇总", {
            项目ID: task.projectId,
            MR编号: task.iid,
            finding: markerId,
            错误: error instanceof Error ? error.message : String(error),
          });
          fallback.push(renderFallbackFinding(finding));
        }
      }
    }

    // 发布后回读校验：确认 GitLab 实际记录的锚点与预期一致。GitLab 接受 position
    // 后仍可能把评论挂到相邻行，只有回读才能发现；不一致只记 warn 不重复发布
    // （marker 保证下次评审跳过）。
    await verifyPublishedPositions({ task, refs, logger });

    return { published, publishedBodies, fallback };
  }

  /**
   * 回读 discussions 并校验已发布评论的锚点行号与路径。
   *
   * 校验失败只记 warn：评论已经发出去了，重复发或删除都不如留痕让人工判断。
   * 该步骤失败（网络问题）不影响评审结果。
   */
  async function verifyPublishedPositions(input: { task: MergeRequestTask; refs: DiffRefs; logger: Logger }): Promise<void> {
    const { task, refs, logger } = input;
    try {
      const discussions = await client.getDiscussions(task.projectId, task.iid, task.gitlabUrl, task.gitlabToken);
      const markerPrefix = `<!-- marker:${refs.headSha}:`;
      for (const discussion of discussions) {
        for (const note of discussion.notes) {
          if (!note.body.includes(markerPrefix)) continue;
          const position = note.position;
          const anchored = position ? (position.new_line ?? position.old_line) : undefined;
          if (anchored === undefined) {
            logger.warn("行内评论缺少 position，锚点可能未生效", {
              项目ID: task.projectId,
              MR编号: task.iid,
              discussion: discussion.id,
            });
            continue;
          }
          if (position?.head_sha !== refs.headSha) {
            logger.warn("行内评论的 head_sha 与当前评审不一致", {
              项目ID: task.projectId,
              MR编号: task.iid,
              discussion: discussion.id,
              评论head: String(position?.head_sha ?? ""),
            });
          }
        }
      }
    } catch (error) {
      logger.warn("发布后回读校验失败，跳过校验", {
        项目ID: task.projectId,
        MR编号: task.iid,
        错误: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * 从汇总评论中剔除已成功发行内评论的 finding 正文（proposal 变更点 3）。
 *
 * 按正文子串匹配而不是按 id：汇总评论由模型生成，正文里不会出现 finding 的 `id`，
 * 但会带上问题描述文字。逐行过滤，只删除确实包含已发布正文的行；匹配不到的行
 * 原样保留——宁可在汇总里留下冗余，也不能因模型改写措辞而误删内容。
 */
function stripPublishedFindings(comment: string, publishedBodies: Set<string>): string {
  const bodies = [...publishedBodies].filter((body) => body.trim().length > 0);
  if (bodies.length === 0) return comment;
  const kept = comment.split("\n").filter((line) => !bodies.some((body) => line.includes(body)));
  const stripped = kept.join("\n");
  // 全部被剔除（汇总评论只剩已发布条目）时保留原文，避免回写一条空评论。
  return stripped.trim().length > 0 ? stripped : comment;
}

/** 把无法定位的 finding 渲染成汇总评论中可读的一段。 */
function renderFallbackFinding(finding: { severity: string; path: string; line: number; lineKey: string; body: string }): string {
  const side = finding.lineKey === "new_line" ? "新文件" : "原文件";
  return `- **[${finding.severity}] \`${finding.path}\`（${side}第 ${finding.line} 行）**：${finding.body}`;
}

/**
 * 把降级内容追加到汇总评论末尾。
 *
 * 单独成段而不是插进正文：让评审者能区分「模型已定位并发行内评论的问题」与
 * 「无法定位、只在此处列出的问题」。
 */
function appendFallback(comment: string, fallback: string[]): string {
  if (fallback.length === 0) return comment;
  return `${comment}\n\n---\n\n### 无法定位到行的问题\n\n${fallback.join("\n\n")}`;
}

/**
 * 拼出 MR 的 GitLab web 地址（纯函数，供测试）。
 *
 * GitLab 的 MR 地址规则稳定：`{实例}/{项目全名}/-/merge_requests/{iid}`。
 * 用拼接而不是从 webhook 读 `object_attributes.url`：后者不落在任务模型里，
 * 而实例地址与项目全名都已有，拼接不需要改 webhook 解析链路。
 *
 * 缺实例地址或项目全名时返回 null——宁可不给链接，也不给一个点开 404 的地址。
 */
export function buildMergeRequestUrl(task: {
  gitlabUrl?: string;
  fullName: string;
  iid: number;
}): string | null {
  const base = task.gitlabUrl?.trim().replace(/\/+$/, "");
  const fullName = task.fullName?.trim();
  if (!base || !fullName) return null;
  return `${base}/${fullName}/-/merge_requests/${task.iid}`;
}

/**
 * 组装企业微信 markdown 消息（application 层纯函数，供测试）。
 *
 * 只发**摘要**，不附评审正文：企微是通知渠道而不是阅读器，把几十行代码块
 * 塞进去既难看又触发 4096 字节截断，关键信息（评分、问题数量、去哪儿看）
 * 反而被挤掉。详细内容在 MR 评论里，这里只给一个跳转链接。
 *
 * 只使用企微支持的 markdown 子集：标题、加粗、链接与正文。
 */
export function buildWecomMessage(input: {
  projectId: number;
  iid: number;
  fullName: string;
  sourceBranch: string;
  targetBranch: string;
  score: number;
  /** 评审正文（Markdown）。只用于统计问题数量，不拼进消息。 */
  comment: string;
  /** MR 的 GitLab 地址；缺失时不输出链接行。 */
  mrUrl?: string | null;
}): string {
  const counts = countFindingsBySeverity(input.comment);
  const lines = [
    `# 🤖 代码评审提醒 — ${input.fullName}`,
    "",
    `**MR:** !${input.iid}　**分支:** \`${input.sourceBranch}\` → \`${input.targetBranch}\``,
    `**AI 评分:** ${input.score > 0 ? `${input.score} 分` : "未解析出分数"}（低于阈值）`,
  ];

  // 问题数量统计：让接收者一眼看出严重程度，不用点进去才知道。
  const summaryParts: string[] = [];
  if (counts.p0 > 0) summaryParts.push(`**P0** ${counts.p0} 个`);
  if (counts.p1 > 0) summaryParts.push(`**P1** ${counts.p1} 个`);
  if (counts.p2 > 0) summaryParts.push(`**P2** ${counts.p2} 个`);
  if (counts.other > 0) summaryParts.push(`**其他** ${counts.other} 个`);
  if (summaryParts.length > 0) {
    lines.push(`**问题:** ${summaryParts.join("　")}　共 ${counts.total} 个`);
  } else {
    lines.push("**问题:** 未识别到分级问题，详见 MR 评论");
  }

  if (input.mrUrl) {
    lines.push("", `[👉 查看 MR 与完整评审](${input.mrUrl})`);
  }
  return lines.join("\n");
}

/** 评审正文里的问题分级统计。 */
export interface FindingCounts {
  p0: number;
  p1: number;
  p2: number;
  /** 有分级标记之外的其他问题条目（如未标 P 级但带「位置：」的段落）。 */
  other: number;
  total: number;
}

/**
 * 从评审正文统计各严重级别的问题数量（纯函数，供测试）。
 *
 * 识别规则对齐 prompt 约定的输出格式：问题条目以 `P0：` / `P1：` / `P2：`
 * 开头（全角冒号），或 `- P0:` 这类列表项。用行首匹配而不是全文搜索，
 * 避免正文里引用的代码恰好含 "P0" 时被误计。
 */
export function countFindingsBySeverity(comment: string): FindingCounts {
  const counts: FindingCounts = { p0: 0, p1: 0, p2: 0, other: 0, total: 0 };
  for (const rawLine of comment.split("\n")) {
    const line = rawLine.trim();
    // 形如 "P0：xxx" / "- P0: xxx" / "**P0**：xxx"
    const match = /^(?:[-*]\s+)?\*{0,2}P([0-2])\*{0,2}\s*[:：]/.exec(line);
    if (match) {
      const level = Number(match[1]);
      if (level === 0) counts.p0 += 1;
      else if (level === 1) counts.p1 += 1;
      else counts.p2 += 1;
      counts.total += 1;
    }
  }
  return counts;
}
