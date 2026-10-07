import { createServer, type Server } from "node:http";
import { createApp } from "./app.ts";
import type { AppConfig } from "../../shared/config.ts";
import type { Logger } from "../../shared/logger.ts";
import type { TaskQueue } from "../../shared/queue.ts";
import type { ReviewPipeline } from "../../application/review-pipeline.ts";
import type { AppDeps } from "./app.ts";

/** `startServer` 的装配依赖：webhook 路由所需的队列、入队与管线，以及管理 API。 */
export interface ServerDeps extends Partial<Pick<AppDeps, "apiRoutes" | "publicApiRoutes" | "authMiddleware" | "staticAssets">> {
  queue: TaskQueue;
  pipeline: ReviewPipeline;
  logger: Logger;
}

/**
 * 装配应用并监听端口（HTTP 表现层的组合入口）。
 *
 * 显式创建 http server 并在 `listen()` 之前挂好事件监听：`app.listen(port, host, cb)`
 * 的回调并不对应 `listening` 事件，端口被占用时它会先于 `error` 触发，导致启动失败
 * 被当成成功。这里只认 `listening` 与 `error` 两个事件，启动错误以 reject 抛出。
 */
export function startServer(config: AppConfig, deps: ServerDeps, logger: Logger): Promise<Server> {
  const { queue, pipeline } = deps;
  const app = createApp({
    logger,
    enqueue: (task) => {
      queue.push(() => pipeline.run(task));
    },
    apiRoutes: deps.apiRoutes,
    publicApiRoutes: deps.publicApiRoutes,
    authMiddleware: deps.authMiddleware,
    staticAssets: deps.staticAssets,
  });
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      logger.error("监听失败", { 监听地址: config.host, 端口: config.port, 错误: error.message });
      reject(error);
    });
    server.once("listening", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : config.port;
      logger.info("服务已开始监听", { 地址: `http://${config.host}:${port}/review/webhook` });
      resolve(server);
    });
    logger.info("正在监听端口", { 监听地址: config.host, 端口: config.port });
    server.listen(config.port, config.host);
  });
}
