import { createSilentLogger, type Logger } from "../shared/logger.ts";
import { estimateTokens, splitChangesIntoBatches } from "../domain/change.ts";
import { renderUserPrompt, stripMarkdownFences, type ReviewRules, type RuleSet } from "../domain/review-rules.ts";
import type { Change, Commit, GitlabClient, MergeRequestTask, Reviewer } from "../domain/review-task.ts";

export type { MergeRequestTask };

/** 评审管线（application 用例端口）：webhook 入队任务的实际执行体。 */
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
const SUMMARY_SUFFIX = "\n\n你之前分批评审了同一变更的各部分。下面按批序给出各批评审结果，请把它们合并成一份最终评论：去重、按严重程度排序、保留各条问题的位置与证据、合并评分并给出总分。输出结构与格式完全遵循上述规则的要求；只输出纯 Markdown 评论正文，不要用 ``` 代码块包裹，不要加任何前言或后缀。";

/**
 * 创建评审管线（application 用例编排）。
 *
 * 编排「拉取 → 分批 → 逐批评审 → 汇总 → 回写」，依赖 domain 端口（Reviewer /
 * GitlabClient / ReviewRules）与 domain 纯函数（分批、渲染、围栏清理），不触碰
 * 任何 IO 细节。每个批次与最后的汇总各建一个独立 pi 会话（复用 `createPiReviewer`
 * 的单会话语义）。失败语义：拉取失败、单批失败、汇总失败都记日志并结束任务，
 * 不回写；只有全部批次与汇总成功才回写一条 MR 评论。日志不记录正文与 token。
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

      const ruleSet: RuleSet = rules.resolve(task.fullName);
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
        finalComment = stripMarkdownFences(summary.text.trim());
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
