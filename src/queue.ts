import { createSilentLogger, type Logger } from "./logger.ts";

/** 入队任务：一个无参数异步函数，队列负责串行调用它。 */
export type QueuedTask = () => Promise<void>;

/** 内存串行任务队列。 */
export interface TaskQueue {
  /** 入队一个任务，按到达顺序串行执行，永不并发。 */
  push(task: QueuedTask): void;
  /** 当前排队中（含执行中）的任务数。 */
  readonly pending: number;
}

/**
 * 创建内存串行任务队列。
 *
 * 有意延后的简化：队列不持久化、不重试——进程重启丢任务、任务失败只记日志。
 * 这是已确认的边界（proposal Out of Scope），升级触发条件是出现「重启丢评审」的
 * 实际投诉，升级方向是持久化队列。
 */
export function createTaskQueue(logger: Logger = createSilentLogger()): TaskQueue {
  // promise 链尾巴：新任务挂在 tail 之后，天然保证串行与顺序。
  let tail: Promise<void> = Promise.resolve();
  let pendingCount = 0;

  return {
    push(task) {
      pendingCount += 1;
      tail = tail.then(task).catch((error: unknown) => {
        logger.error("队列任务执行失败", {
          message: error instanceof Error ? error.message : String(error),
        });
      }).finally(() => {
        pendingCount -= 1;
      });
    },
    get pending() {
      return pendingCount;
    },
  };
}
