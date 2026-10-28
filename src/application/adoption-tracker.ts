/**
 * 采纳追踪用例：判定已发布的评审建议在后续提交中是否真的改了代码。
 *
 * 判定主线（design/backend.md#状态并发与执行流程）：
 * 1. 取待追踪建议，按 MR 分组；
 * 2. 读取 MR 最新 head 与生命周期；opened 且版本未变继续等待，merged/closed 收口 pending；
 * 3. 拉取讨论，建立 marker → 是否已解决 的映射；
 * 4. 按固定 head 读取文件内容，并在原行附近重新定位指纹；
 * 5. 按「是否变化 + 是否已解决」写入判定态，同时记录本轮跳过原因。
 *
 * 失败一律降级：任何单条异常只记日志并保留原状态，下一轮重试；
 * 追踪属于从属能力，不能影响评审主流程。
 */
import type { Discussion, GitlabClient, MergeRequestTask } from "../domain/review-task.ts";
import { fingerprintLine, locateFingerprintLine, type FindingOutcome, type ReviewFinding } from "../domain/review-finding.ts";
import type { ReviewFindingRepository } from "../domain/review-finding.ts";
import type { Logger } from "../shared/logger.ts";
import { openSecret, sealSecret } from "../shared/secret-box.ts";

/** 单轮最多处理的建议数：避免一轮扫描过久，剩余的下一轮继续。 */
const DEFAULT_BATCH_SIZE = 200;

/** 只读取公开状态码元数据；错误正文可能含敏感信息，不能用于分支或日志补充。 */
function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = Number((error as { status?: unknown }).status);
  return Number.isInteger(status) ? status : undefined;
}

/** 追踪用例依赖。 */
export interface AdoptionTrackerDeps {
  findings: ReviewFindingRepository;
  client: Pick<GitlabClient, "getLatestHeadSha" | "getMergeRequestTrackingState" | "getFileRaw" | "getDiscussions">;
  logger: Logger;
  /** 单轮处理上限，缺省 200。 */
  batchSize?: number;
  /**
   * 解密任务级令牌的部署盐。
   *
   * 追踪在请求之外运行，凭据只能从建议记录里取密文再解密；缺少时可解的密文
   * 为空串，追踪按「无凭据」跳过，绝不发起未鉴权请求。
   */
  secretKey?: string;
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

/**
 * 把定时器与 webhook 触发合并成 single-flight：一个繁忙周期最多当前轮加一次补跑。
 * 这样既能尽快响应新提交，也不会因事件风暴与定时器重叠并发请求同一批 MR。
 */
export function createAdoptionTrackingTrigger(tracker: AdoptionTracker, logger: Logger): () => Promise<void> {
  let active: Promise<void> | undefined;
  let rerunRequested = false;
  let rerunStarted = false;

  const runSafely = async (): Promise<void> => {
    try {
      await tracker.runOnce();
    } catch (error) {
      logger.warn("采纳追踪轮次异常", {
        错误类型: error instanceof Error ? error.name : typeof error,
        状态码: errorStatus(error),
      });
    }
  };

  return (): Promise<void> => {
    if (active) {
      if (!rerunStarted) rerunRequested = true;
      return active;
    }
    rerunRequested = false;
    rerunStarted = false;
    active = (async () => {
      await runSafely();
      if (rerunRequested) {
        rerunRequested = false;
        rerunStarted = true;
        await runSafely();
      }
    })().finally(() => {
      active = undefined;
      rerunRequested = false;
      rerunStarted = false;
    });
    return active;
  };
}

/**
 * 处理一条采纳追踪 webhook：先刷新该 MR 的 pending 凭据，再触发 single-flight。
 * 凭据刷新失败不应阻塞追踪；日志只保留任务标识与数量，不记录令牌或原始异常。
 */
export function createAdoptionTrackingEventHandler(deps: {
  findings: Pick<ReviewFindingRepository, "refreshTrackingCredentials">;
  secretKey: string;
  enabled: boolean;
  trigger: () => Promise<void>;
  logger: Logger;
}): (task: MergeRequestTask) => void {
  return (task): void => {
    if (!deps.enabled) {
      deps.logger.info("MR 事件未触发采纳追踪：功能已关闭", { 项目ID: task.projectId, MR编号: task.iid });
      return;
    }
    let refreshed = 0;
    try {
      if (task.gitlabToken) {
        refreshed = deps.findings.refreshTrackingCredentials(
          task.projectId,
          task.iid,
          task.gitlabUrl ?? "",
          sealSecret(task.gitlabToken, deps.secretKey),
        );
      }
    } catch {
      deps.logger.warn("刷新采纳追踪凭据失败，保留原凭据", { 项目ID: task.projectId, MR编号: task.iid });
    }
    void deps.trigger();
    deps.logger.info("MR 事件已触发采纳追踪", {
      项目ID: task.projectId,
      MR编号: task.iid,
      已刷新建议凭据数: refreshed,
      已启用: true,
    });
  };
}

/** 创建追踪用例。 */
export function createAdoptionTracker(deps: AdoptionTrackerDeps): AdoptionTracker {
  const { findings, client, logger } = deps;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;

  /**
   * 判定单条建议；`headSha` 是该 MR 的最新 head，`token` 是解密后的任务级令牌。
   *
   * 必须同时用任务级实例与令牌：该服务的访问令牌随 webhook 请求头下发，
   * 没有全局令牌可用；漏传会以未鉴权身份请求并返回 401。
   */
  async function trackOne(
    finding: ReviewFinding,
    headSha: string,
    gitlabUrl: string,
    token: string,
    resolution: Map<string, boolean>,
  ): Promise<FindingOutcome> {
    let content: string;
    try {
      // 必须读**最新** head 的文件：用评审时的旧 head 会读到旧内容，
      // 每次都判成「未变化」，采纳率永远是 0。
      content = await client.getFileRaw(finding.projectId, finding.mrIid, finding.path, headSha, gitlabUrl, token);
    } catch (error) {
      // MR 状态已用同一凭据读取成功，因此这里的明确 404 可解释为原路径在新版本消失；
      // 限流、超时和 5xx 只是暂时不可读，继续抛出以保留原状态并在下一轮重试。
      if (errorStatus(error) === 404) return "adopted";
      throw error;
    }

    // 文件读到了但窗口内找不到原指纹，说明目标行已被改写或删除——这本身就是
    // 「代码已变化」的强信号，不能记 unknown，否则会把真正改掉的部分漏统计。
    const located = locateFingerprintLine(content, finding.line, finding.codeFingerprint);
    const resolved = resolution.get(finding.marker) === true;
    if (located) return decideOutcome(false, resolved);

    // 文件已成功读取但原指纹消失，说明目标代码被改写或删除；整体重写/截断同样
    // 属于代码发生变化，按已确认口径记为 adopted，而不是永久降级为 unknown。
    return decideOutcome(true, resolved);
  }

  /**
   * 选择能读取该 MR 的任务级凭据：优先 pending 的新凭据，再回退历史判定行。
   * 认证失败时尝试下一份去重凭据；服务端/网络错误不轮换，避免掩盖真实故障。
   */
  async function readTrackingState(list: ReviewFinding[]): Promise<{
    headSha: string;
    state: "opened" | "closed" | "merged";
    gitlabUrl: string;
    token: string;
  } | undefined> {
    const ordered = [...list].sort((left, right) => {
      const pendingOrder = Number(right.outcome === "pending") - Number(left.outcome === "pending");
      return pendingOrder || right.createdAt - left.createdAt;
    });
    const seen = new Set<string>();
    let lastAuthError: unknown;
    for (const finding of ordered) {
      const token = deps.secretKey ? openSecret(finding.gitlabTokenSealed, deps.secretKey) : "";
      if (!token) continue;
      const key = `${finding.gitlabUrl}\u0000${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const state = client.getMergeRequestTrackingState
          ? await client.getMergeRequestTrackingState(finding.projectId, finding.mrIid, finding.gitlabUrl, token)
          : {
              headSha: await client.getLatestHeadSha(finding.projectId, finding.mrIid, finding.gitlabUrl, token),
              state: "opened" as const,
            };
        return { ...state, gitlabUrl: finding.gitlabUrl, token };
      } catch (error) {
        if ([401, 403, 404].includes(errorStatus(error) ?? 0)) {
          lastAuthError = error;
          continue;
        }
        throw error;
      }
    }
    if (lastAuthError) throw lastAuthError;
    return undefined;
  }

  return {
    async runOnce() {
      const candidates = findings.listPendingTracking(batchSize);
      // 按 MR 分组：同一 MR 只需读取一次生命周期、最新 head 与讨论列表。
      const byMr = new Map<string, ReviewFinding[]>();
      for (const finding of candidates) {
        // projectId/MR iid 只在单个 GitLab 实例内唯一；实例地址必须参与隔离键。
        const key = `${finding.gitlabUrl}\u0000${finding.projectId}:${finding.mrIid}`;
        const list = byMr.get(key);
        if (list) list.push(finding);
        else byMr.set(key, [finding]);
      }

      let evaluated = 0;
      let terminalFinalized = 0;
      let waitingSameHead = 0;
      let alreadyCurrent = 0;
      let missingCredentials = 0;
      let unavailableHead = 0;
      let failedSuggestions = 0;
      let failedMrs = 0;

      for (const list of byMr.values()) {
        const first = list[0];
        // 状态读取失败影响整组；讨论读取失败只影响真正需要判定的子集。
        let affectedByMrFailure = list.length;
        try {
          const credential = await readTrackingState(list);
          if (!credential) {
            missingCredentials += list.length;
            logger.debug("追踪：缺少任务级凭据，跳过该 MR", { 项目ID: first.projectId, MR编号: first.mrIid });
            continue;
          }
          const { gitlabUrl: mrGitlabUrl, token: mrToken, ...trackingState } = credential;
          if (!trackingState.headSha) {
            unavailableHead += list.length;
            continue;
          }
          const terminal = trackingState.state === "merged" || trackingState.state === "closed";
          const terminalPending = new Set<number>();
          const needsTrack: ReviewFinding[] = [];
          for (const finding of list) {
            if (terminal && finding.outcome === "pending") terminalPending.add(finding.id);
            if (finding.headSha !== trackingState.headSha) {
              needsTrack.push(finding);
            } else if (terminal && finding.outcome === "pending") {
              needsTrack.push(finding);
            } else if (finding.outcome === "pending") {
              waitingSameHead += 1;
            } else {
              alreadyCurrent += 1;
            }
          }
          if (needsTrack.length === 0) continue;
          affectedByMrFailure = needsTrack.length;

          const discussions = await client.getDiscussions(first.projectId, first.mrIid, mrGitlabUrl, mrToken);
          const resolution = buildResolutionMap(discussions);
          for (const finding of needsTrack) {
            try {
              // 状态、讨论和文件必须使用同一份已验证凭据；否则历史 token 的权限型 404
              // 可能被误判为文件删除并错误计为 adopted。
              const outcome = await trackOne(finding, trackingState.headSha, mrGitlabUrl, mrToken, resolution);
              findings.updateOutcome(finding.id, outcome, Date.now(), trackingState.headSha);
              evaluated += 1;
              if (terminalPending.has(finding.id)) terminalFinalized += 1;
            } catch (error) {
              failedSuggestions += 1;
              logger.warn("追踪单条建议失败，保留原状态", {
                项目ID: finding.projectId,
                MR编号: finding.mrIid,
                建议: finding.findingId,
                错误类型: error instanceof Error ? error.name : typeof error,
                状态码: errorStatus(error),
              });
            }
          }
        } catch (error) {
          failedMrs += 1;
          failedSuggestions += affectedByMrFailure;
          logger.warn("追踪 MR 失败，跳过本轮", {
            项目ID: first.projectId,
            MR编号: first.mrIid,
            错误类型: error instanceof Error ? error.name : typeof error,
            状态码: errorStatus(error),
          });
        }
      }

      const untrackable = findings.countUntrackable();
      logger.info(candidates.length === 0 ? "采纳追踪无扫描候选" : "采纳追踪完成一轮", {
        扫描候选建议数: candidates.length,
        已判定建议数: evaluated,
        其中终态收口: terminalFinalized,
        等待新提交建议数: waitingSameHead,
        已是最新判定建议数: alreadyCurrent,
        缺少凭据建议数: missingCredentials,
        最新版本不可用建议数: unavailableHead,
        失败MR数: failedMrs,
        失败建议数: failedSuggestions,
        不可追踪建议数: untrackable.total,
        其中降级并入汇总: untrackable.fallback,
        其中有行锚点但无法定位: untrackable.unknown,
      });
    },
  };
}
