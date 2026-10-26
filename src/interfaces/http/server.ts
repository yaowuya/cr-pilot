import { createServer, type Server } from "node:http";
import type { Express } from "express";
import { createApp } from "./app.ts";
import type { AppConfig } from "../../shared/config.ts";
import type { Logger } from "../../shared/logger.ts";
import type { TaskQueue } from "../../shared/queue.ts";
import type { ReviewPipeline } from "../../application/review-pipeline.ts";
import type { AppDeps } from "./app.ts";

/** `startServer` 的装配依赖：webhook 路由所需的队列、入队与管线，以及管理 API。 */
export interface ServerDeps extends Partial<Pick<AppDeps, "apiRoutes" | "publicApiRoutes" | "authMiddleware" | "staticAssets" | "isProjectAllowed">> {
  queue: TaskQueue;
  pipeline: ReviewPipeline;
  logger: Logger;
  /**
   * 采纳追踪登记入口：MR 有新提交时调用，不走评审队列。
   *
   * 必须由组合根注入。缺省时 `createApp` 会把追踪事件降级成完整评审，
   * 因此这属于装配必填项，不是可选优化。
   */
  enqueueTracking: AppDeps["enqueueTracking"] & {};
  /**
   * 立即执行一轮采纳追踪（可选）。
   *
   * 有新提交时先跑一轮，让统计尽量及时；跑不起来也不影响事件登记，
   * 周期性定时器会兜底。
   */
  runAdoptionTracking?: () => void;
}

/** 监听结果：主端口服务器，以及可选的第二端口服务器。 */
export interface StartedServers {
  /** 主端口（PORT，默认 5001）：webhook 与全部 API。 */
  primary: Server;
  /**
   * 第二端口（UI_PORT，默认 5002）：与主端口提供完全相同的服务。
   *
   * 未启用（UI_PORT=0、与 PORT 相同，或监听失败）时为 undefined。
   */
  secondary?: Server;
}

/**
 * 装配应用并监听端口（HTTP 表现层的组合入口）。
 *
 * 显式创建 http server 并在 `listen()` 之前挂好事件监听：`app.listen(port, host, cb)`
 * 的回调并不对应 `listening` 事件，端口被占用时它会先于 `error` 触发，导致启动失败
 * 被当成成功。这里只认 `listening` 与 `error` 两个事件，启动错误以 reject 抛出。
 *
 * 双端口（`uiPort`）：同一个 Express 实例监听两个端口，两个端口提供完全相同的
 * 服务。这是为兼容团队既有「5001=API、5002=管理界面」的访问约定——旧项目是
 * Flask + Streamlit 两个进程各占一个端口，本项目只有一个进程，用双监听达到
 * 同样的访问效果，不额外引入 Nginx 或第二个容器。
 */
export async function startServer(
  config: AppConfig,
  deps: ServerDeps,
  logger: Logger,
): Promise<StartedServers> {
  const { queue, pipeline } = deps;
  const app = createApp({
    logger,
    enqueue: (task) => {
      queue.push(() => pipeline.run(task));
    },
    // 追踪事件不进评审队列：它只重新判定已有建议，与真实评审争抢并发槽位
    // 会延长评审等待时间，也会让同一 MR 被重复评审。
    enqueueTracking: deps.enqueueTracking,
    isProjectAllowed: deps.isProjectAllowed,
    apiRoutes: deps.apiRoutes,
    publicApiRoutes: deps.publicApiRoutes,
    authMiddleware: deps.authMiddleware,
    staticAssets: deps.staticAssets,
  });

  const primary = await listenOn(app, config.port, config.host, logger, "主端口");
  const secondary = await listenSecondary(app, config, logger);
  return { primary, secondary };
}

/** 在指定端口监听，返回已就绪的 server；失败时 reject。 */
function listenOn(
  app: Express,
  port: number,
  host: string,
  logger: Logger,
  label: string,
): Promise<Server> {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      logger.error("监听失败", { 端口类型: label, 监听地址: host, 端口: port, 错误: error.message });
      reject(error);
    });
    server.once("listening", () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      logger.info("服务已开始监听", { 端口类型: label, 地址: `http://${host}:${actual}/` });
      resolve(server);
    });
    logger.info("正在监听端口", { 端口类型: label, 监听地址: host, 端口: port });
    server.listen(port, host);
  });
}

/**
 * 尝试监听第二端口；任何失败都只记 warn 并返回 undefined。
 *
 * 不阻断启动的理由：第二端口只是访问便利（兼容既有 5002 习惯），
 * 端口被占用时主端口应当照常提供服务，而不是让整个进程退出。
 */
async function listenSecondary(
  app: Express,
  config: AppConfig,
  logger: Logger,
): Promise<Server | undefined> {
  const uiPort = config.uiPort;
  if (uiPort <= 0) {
    logger.info("未启用第二端口（UI_PORT=0）");
    return undefined;
  }
  if (uiPort === config.port) {
    logger.warn("UI_PORT 与 PORT 相同，跳过第二端口", { 端口: uiPort });
    return undefined;
  }
  try {
    return await listenOn(app, uiPort, config.host, logger, "管理界面端口");
  } catch (error) {
    logger.warn("第二端口监听失败，主端口继续提供服务", {
      端口: uiPort,
      错误: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}
