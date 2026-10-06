import type { Change, Commit, GitlabClient } from "./gitlab-client.ts";
import { createSilentLogger, type Logger } from "./logger.ts";
import { renderUserPrompt, type ReviewRules, type RuleSet } from "./rules.ts";
import type { Reviewer } from "./reviewer.ts";

/** 一个待处理的 MR 任务：webhook 分派后进入队列。 */
export interface MergeRequestTask {
  projectId: number;
  iid: number;
  fullName: string;
  sourceBranch: string;
  targetBranch: string;
}

/** 评审管线：编排「拉取 → 分批 → 逐批评审 → 汇总 → 回写」。 */
export interface ReviewPipeline {
  run(task: MergeRequestTask): Promise<void>;
}

interface PipelineDeps {
  client: GitlabClient;
  rules: ReviewRules;
  reviewer: Reviewer;
  logger: Logger;
  batchMaxTokens: number;
  /** 单批评审/汇总的超时毫秒数，缺省 120000。 */
  timeoutMs?: number;
}

/** 单批评审/汇总的默认超时毫秒数，与 config 的默认评审超时一致。 */
const DEFAULT_TIMEOUT_MS = 120000;

/** 汇总 prompt 的系统提示后缀，要求模型把各批结果合并成一份最终评论。 */
const SUMMARY_SUFFIX = "\n\n你之前分批评审了同一变更的各部分。下面按批序给出各批评审结果，请把它们合并成一份最终评论：去重、分级、保留各条问题的位置信息，并给出总体结论。";

/**
 * 创建评审管线。
 *
 * 每个批次与最后的汇总各建一个独立 pi 会话（复用 `createPiReviewer` 的单会话
 * 语义）。失败语义：拉取失败、单批失败、汇总失败都记日志并结束任务，不回写；
 * 只有全部批次与汇总成功才回写一条 MR 评论。日志不记录正文与 token。
 */
export function createReviewPipeline(deps: PipelineDeps): ReviewPipeline {
  const { client, rules, reviewer, logger, batchMaxTokens } = deps;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async run(task) {
      logger.info("管线开始处理 MR", { projectId: task.projectId, iid: task.iid, fullName: task.fullName });
      const startedAt = Date.now();

      let changes: Change[];
      let commits: Commit[];
      try {
        changes = await client.getMergeRequestChanges(task.projectId, task.iid);
        commits = await client.getMergeRequestCommits(task.projectId, task.iid);
      } catch (error) {
        logger.error("拉取 MR 变更失败，任务结束", {
          projectId: task.projectId,
          iid: task.iid,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      logger.info("已拉取 MR 变更", {
        projectId: task.projectId,
        iid: task.iid,
        changeCount: changes.length,
        commitCount: commits.length,
      });

      const ruleSet = rules.resolve(task.fullName);
      const commitsText = commits.map((commit) => `${commit.id.slice(0, 8)} ${commit.message.split("\n")[0] ?? ""}`).join("\n");
      const batches = splitChangesIntoBatches(changes, batchMaxTokens, estimateTokens(ruleSet.userPrompt) + estimateTokens(commitsText));
      logger.info("分批完成", { projectId: task.projectId, iid: task.iid, batchCount: batches.length });

      const batchResults: string[] = [];
      for (const [index, batch] of batches.entries()) {
        const diffsText = batch.map((change) => `diff --git a/${change.oldPath} b/${change.newPath}\n${change.diff}`).join("\n\n");
        // 仓库规则的 user_prompt 是用户消息全文模板：渲染占位符后作为本轮用户消息。
        const userMessage = renderUserPrompt(ruleSet.userPrompt, { diffsText, commitsText });
        const batchStartedAt = Date.now();
        try {
          const result = await reviewer.review({
            systemPrompt: ruleSet.systemPrompt,
            code: userMessage,
            context: undefined,
            signal: AbortSignal.timeout(timeoutMs),
          });
          batchResults.push(result.text);
          logger.info("单批评审完成", {
            projectId: task.projectId,
            iid: task.iid,
            batch: `${index + 1}/${batches.length}`,
            reviewChars: result.text.length,
            durationMs: Date.now() - batchStartedAt,
          });
        } catch (error) {
          logger.error("单批评审失败，任务结束", {
            projectId: task.projectId,
            iid: task.iid,
            batch: `${index + 1}/${batches.length}`,
            message: error instanceof Error ? error.message : String(error),
          });
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
        });
        finalComment = summary.text.trim();
        logger.info("汇总完成", {
          projectId: task.projectId,
          iid: task.iid,
          finalChars: finalComment.length,
          durationMs: Date.now() - summaryStartedAt,
        });
      } catch (error) {
        logger.error("汇总失败，任务结束", {
          projectId: task.projectId,
          iid: task.iid,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      try {
        await client.postMergeRequestNote(task.projectId, task.iid, finalComment);
      } catch (error) {
        logger.error("回写评论失败，任务结束", {
          projectId: task.projectId,
          iid: task.iid,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      logger.info("管线完成", {
        projectId: task.projectId,
        iid: task.iid,
        totalMs: Date.now() - startedAt,
      });
    },
  };
}

/**
 * 估算文本 token 数：按字符数/4 向上取整。
 *
 * 有意偏保守：代码约 3-4 字符/token，按 4 估算会让批次偏小而不是偏大，
 * 保证任何单批都不会超过模型上下文。内网模型词表未知，精确 tokenizer 收益
 * 有限，见 design 决策 D-005。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 单批 token 预算的安全系数：只使用预算的 85%，为估算误差与 prompt 开销留余量。 */
const BATCH_THRESHOLD_RATIO = 0.85;

/**
 * 把变更列表按 token 预算拆成多批。
 *
 * 规则：整文件塞得下就整文件装箱；单个文件超预算时按 diff 行拆（保留文件路径
 * 元信息）；单行仍超预算时按字符切。`promptOverheadTokens` 是 system/user prompt
 * 与提交信息占用的预算，先扣除再装箱。
 */
export function splitChangesIntoBatches(
  changes: Change[],
  maxTokens: number,
  promptOverheadTokens: number,
): Change[][] {
  const threshold = Math.floor(maxTokens * BATCH_THRESHOLD_RATIO) - promptOverheadTokens;
  if (threshold <= 0) {
    // 预算连 prompt 都装不下：每个文件单列一批，由调用方在评审时暴露问题。
    return changes.map((change) => [change]);
  }

  const units: Change[] = [];
  for (const change of changes) {
    if (estimateTokens(change.diff) <= threshold) {
      units.push(change);
      continue;
    }
    for (const part of splitByDiffLines(change, threshold)) {
      units.push(part);
    }
  }

  const batches: Change[][] = [];
  let current: Change[] = [];
  let currentTokens = 0;
  for (const unit of units) {
    const unitTokens = estimateTokens(unit.diff);
    if (current.length > 0 && currentTokens + unitTokens > threshold) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(unit);
    currentTokens += unitTokens;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

/** 把单个超预算文件按 diff 行拆成多个保留元信息的 Change。 */
function splitByDiffLines(change: Change, threshold: number): Change[] {
  const lines = change.diff.split("\n");
  const parts: Change[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  const flush = (): void => {
    if (current.length === 0) return;
    parts.push({ ...change, diff: current.join("\n") });
    current = [];
    currentTokens = 0;
  };
  for (const line of lines) {
    const lineTokens = estimateTokens(line);
    if (lineTokens > threshold) {
      flush();
      for (const chunk of splitByCharacters(line, threshold)) {
        parts.push({ ...change, diff: chunk });
      }
      continue;
    }
    if (currentTokens + lineTokens > threshold) {
      flush();
    }
    current.push(line);
    currentTokens += lineTokens;
  }
  flush();
  return parts.length > 0 ? parts : [{ ...change }];
}

/** 把单行超预算的文本按字符切块，每块不超过阈值。 */
function splitByCharacters(line: string, threshold: number): string[] {
  const chunks: string[] = [];
  let remaining = line;
  while (remaining.length > 0) {
    const take = Math.max(threshold * 4, 1);
    chunks.push(remaining.slice(0, take));
    remaining = remaining.slice(take);
  }
  return chunks;
}
