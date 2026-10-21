/**
 * 采纳追踪用例：判定已发布的评审建议在后续提交中是否真的改了代码。
 *
 * 判定主线（design/backend.md#状态并发与执行流程）：
 * 1. 取待追踪建议，按 MR 分组；
 * 2. 若 MR 最新 head 与该建议的 head 相同，说明还没有新提交，跳过；
 * 3. 拉取讨论，建立 marker → 是否已解决 的映射；
 * 4. 对每个「MR + 文件」只取一次文件内容，按指纹在原行附近重新定位；
 * 5. 按「是否变化 + 是否已解决」写入四态。
 *
 * 失败一律降级：任何单条异常只记日志并保留原状态，下一轮重试；
 * 追踪属于从属能力，不能影响评审主流程。
 */
import type { Discussion, GitlabClient } from "../domain/review-task.ts";
import { fingerprintLine, locateFingerprintLine, type FindingOutcome, type ReviewFinding } from "../domain/review-finding.ts";
import type { ReviewFindingRepository } from "../domain/review-finding.ts";
import type { Logger } from "../shared/logger.ts";

/** 单轮最多处理的建议数：避免一轮扫描过久，剩余的下一轮继续。 */
const DEFAULT_BATCH_SIZE = 200;

/**
 * 文件行数允许的收缩容差（行）。
 *
 * 目标行号远大于当前文件行数时（差额超过该容差），说明文件被整体重写或截断，
 * 已无法把「指纹消失」归因为这一行被改，只能记 unknown。容差取 3 与定位窗口
 * 一致：窗口内的正常增删不会触发降级。
 */
const LINE_SHRINK_TOLERANCE = 3;

/** 追踪用例依赖。 */
export interface AdoptionTrackerDeps {
  findings: ReviewFindingRepository;
  client: Pick<GitlabClient, "getLatestHeadSha" | "getFileRaw" | "getDiscussions">;
  logger: Logger;
  /** 单轮处理上限，缺省 200。 */
  batchSize?: number;
}

/** 追踪用例端口。 */
export interface AdoptionTracker {
  /** 执行一轮追踪；内部消化异常，不向外抛。 */
  runOnce(): Promise<void>;
}

/** 从讨论里建立 marker → 是否已解决 的映射。 */
function buildResolutionMap(discussions: Discussion[]): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const discussion of discussions) {
    for (const note of discussion.notes) {
      const match = note.body.match(/<!-- marker:[^>]*-->/);
      if (match) map.set(match[0], note.resolved === true);
    }
  }
  return map;
}

/**
 * 按「是否变化 + 是否已解决」决定判定结果。
 *
 * 变化即视为采纳：指纹只能证明目标行变了，不能证明改得对，因此指标口径是
 * 「代码变化率」。已解决但未变化单独成一态，供人工复核是否存在误点。
 */
export function decideOutcome(changed: boolean, resolved: boolean): FindingOutcome {
  if (changed) return "adopted";
  return resolved ? "resolved-without-change" : "ignored";
}

/** 创建追踪用例。 */
export function createAdoptionTracker(deps: AdoptionTrackerDeps): AdoptionTracker {
  const { findings, client, logger } = deps;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;

  /** 判定单条建议；`headSha` 是该 MR 的最新 head，读文件必须用它。 */
  async function trackOne(finding: ReviewFinding, headSha: string, resolution: Map<string, boolean>): Promise<FindingOutcome> {
    let content: string;
    try {
      // 必须读**最新** head 的文件：用评审时的旧 head 会读到旧内容，
      // 每次都判成「未变化」，采纳率永远是 0。
      content = await client.getFileRaw(finding.projectId, finding.mrIid, finding.path, headSha);
    } catch (error) {
      // 文件在该版本不存在（被删或路径变化）时无法判定，如实记 unknown。
      logger.debug("追踪：读取文件失败，记为 unknown", {
        项目ID: finding.projectId,
        MR编号: finding.mrIid,
        文件: finding.path,
        错误: error instanceof Error ? error.message : String(error),
      });
      return "unknown";
    }

    // 文件读到了但窗口内找不到原指纹，说明目标行已被改写或删除——这本身就是
    // 「代码已变化」的强信号，不能记 unknown，否则会把真正改掉的部分漏统计。
    const located = locateFingerprintLine(content, finding.line, finding.codeFingerprint);
    const resolved = resolution.get(finding.marker) === true;
    if (located) return decideOutcome(false, resolved);

    // 文件行数远少于原行号，说明文件被整体重写或截断，属于无法可靠定位，
    // 如实记 unknown 而不是猜成「已采纳」。
    const lineCount = content.split(/\r?\n/).length;
    if (finding.line > lineCount + LINE_SHRINK_TOLERANCE) return "unknown";
    return decideOutcome(true, resolved);
  }

  return {
    async runOnce() {
      const pending = findings.listPendingTracking(batchSize);
      if (pending.length === 0) return;

      // 按 MR 分组：同一 MR 只需查一次最新 head 与一次讨论列表。
      const byMr = new Map<string, ReviewFinding[]>();
      for (const finding of pending) {
        const key = `${finding.projectId}:${finding.mrIid}`;
        const list = byMr.get(key);
        if (list) list.push(finding);
        else byMr.set(key, [finding]);
      }

      let tracked = 0;
      for (const list of byMr.values()) {
        const first = list[0];
        try {
          const latestHead = await client.getLatestHeadSha(first.projectId, first.mrIid);
          // head 未变说明评审后没有新提交，目标行不可能变化，直接留待下一轮。
          if (!latestHead || latestHead === first.headSha) continue;

          const discussions = await client.getDiscussions(first.projectId, first.mrIid);
          const resolution = buildResolutionMap(discussions);

          for (const finding of list) {
            try {
              const outcome = await trackOne(finding, latestHead, resolution);
              findings.updateOutcome(finding.id, outcome, Date.now());
              tracked += 1;
            } catch (error) {
              logger.warn("追踪单条建议失败，保留原状态", {
                项目ID: finding.projectId,
                MR编号: finding.mrIid,
                建议: finding.findingId,
                错误: error instanceof Error ? error.message : String(error),
              });
            }
          }
        } catch (error) {
          // 单 MR 失败不影响其他 MR；下一轮定时器会重试。
          logger.warn("追踪 MR 失败，跳过本轮", {
            项目ID: first.projectId,
            MR编号: first.mrIid,
            错误: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (tracked > 0) {
        logger.info("采纳追踪完成一轮", { 已判定建议数: tracked, 待处理建议数: pending.length });
      }
    },
  };
}
