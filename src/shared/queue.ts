import { createSilentLogger, type Logger } from "./logger.ts";

/** 入队任务：一个无参数异步函数，队列负责按并发上限调度它。 */
export type QueuedTask = () => Promise<void>;

/** 并发任务队列。 */
export interface TaskQueue {
  /** 入队一个任务，按到达顺序启动，最多 `concurrency` 个同时执行。 */
  push(task: QueuedTask): void;
  /** 当前排队中（含执行中）的任务数。 */
  readonly pending: number;
  /** 当前正在执行的任务数。 */
  readonly running: number;
}

/**
 * 创建有并发上限的内存任务队列。
 *
 * 调度语义：新任务挂在每个执行槽的 promise 链尾，按到达顺序串行启动，同一时刻
 * 最多 `concurrency` 个任务在跑。之前是全局串行（并发 1），多 MR 排队时一个慢
 * 评审会挡住后面全部任务；改为可配置并发后，慢任务不再拖垮整个队列。
 *
 * 有意延后的简化：队列不持久化、不重试——进程重启丢任务、任务失败只记日志。
 * 这是已确认的边界（proposal Out of Scope），升级触发条件是出现「重启丢评审」的
 * 实际投诉，升级方向是持久化队列。
 */
export function createTaskQueue(concurrency: number, logger: Logger = createSilentLogger()): TaskQueue {
  // 每个槽位一条 promise 链：新任务轮询挂到当前最短的链尾。
  const tails: Promise<void>[] = Array.from({ length: concurrency }, () => Promise.resolve());
  let nextSlot = 0;
  let pendingCount = 0;
  let runningCount = 0;

  return {
    push(task) {
      pendingCount += 1;
      const slot = nextSlot;
      nextSlot = (nextSlot + 1) % tails.length;
      tails[slot] = tails[slot].then(async () => {
        runningCount += 1;
        try {
          await task();
        } catch (error: unknown) {
          logger.error("队列任务执行失败", {
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          runningCount -= 1;
          pendingCount -= 1;
        }
      });
    },
    get pending() {
      return pendingCount;
    },
    get running() {
      return runningCount;
    },
  };
}
