import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { createApp } from "./app.ts";
import { loadConfig, type AppConfig } from "./config.ts";
import { createGitlabClient } from "./gitlab-client.ts";
import { createConsoleLogger, type Logger } from "./logger.ts";
import { createReviewPipeline, type ReviewPipeline } from "./pipeline.ts";
import { createTaskQueue, type TaskQueue } from "./queue.ts";
import { createPiReviewer } from "./reviewer.ts";
import { loadReviewRules } from "./rules.ts";
import { readFile } from "node:fs/promises";

/** `startServer` 的装配依赖：webhook 路由所需的队列、入队与管线。 */
export interface ServerDeps {
  queue: TaskQueue;
  webhookSecret: string;
  pipeline: ReviewPipeline;
  logger: Logger;
}

/**
 * 装配应用并监听端口。
 *
 * 显式创建 http server 并在 `listen()` 之前挂好事件监听：`app.listen(port, host, cb)`
 * 的回调并不对应 `listening` 事件，端口被占用时它会先于 `error` 触发，导致启动失败
 * 被当成成功。这里只认 `listening` 与 `error` 两个事件，启动错误以 reject 抛出。
 */
export function startServer(config: AppConfig, deps: ServerDeps, logger: Logger): Promise<Server> {
  const { queue, webhookSecret, pipeline } = deps;
  const app = createApp({
    webhookSecret,
    logger,
    enqueue: (task) => {
      queue.push(() => pipeline.run(task));
    },
  });
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once("error", (error) => {
      logger.error("监听失败", { host: config.host, port: config.port, message: error.message });
      reject(error);
    });
    server.once("listening", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : config.port;
      logger.info("服务已开始监听", { url: `http://${config.host}:${port}/review/webhook` });
      resolve(server);
    });
    logger.info("正在监听端口", { host: config.host, port: config.port });
    server.listen(config.port, config.host);
  });
}

// 仅在直接执行本文件时启动服务。测试会导入本模块，因此必须有这层判定，
// 否则一次 import 就会占用端口并留下一个不会退出的进程。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const logger = createConsoleLogger(config.logLevel);
  // 启动横幅先打印生效配置：排障时第一步就是确认进程实际用了哪套配置。
  // GitLab token 与 webhook secret 只确认是否配置，绝不打印值。
  logger.info("cr-pilot 正在启动", { node: process.version, logLevel: config.logLevel });
  logger.info("生效配置", {
    host: config.host,
    port: config.port,
    gitlabUrl: config.gitlabUrl,
    gitlabTokenSet: config.gitlabToken.length > 0,
    webhookSecretSet: config.gitlabWebhookSecret.length > 0,
    promptPath: config.promptPath,
    timeoutMs: config.timeoutMs,
    batchMaxTokens: config.batchMaxTokens,
    rulesDir: config.rulesDir,
  });
  try {
    const queue = createTaskQueue(logger);
    const client = createGitlabClient({
      url: config.gitlabUrl,
      token: config.gitlabToken,
      timeoutMs: config.gitlabApiTimeoutMs,
      insecureTls: config.gitlabInsecureTls,
      logger,
    });
    const fallbackPrompt = await readFile(config.promptPath, "utf8").catch(() => "");
    const rules = await loadReviewRules(config.rulesDir, fallbackPrompt, logger);
    const reviewer = createPiReviewer({ logger });
    const pipeline = createReviewPipeline({
      client,
      rules,
      reviewer,
      logger,
      batchMaxTokens: config.batchMaxTokens,
      timeoutMs: config.timeoutMs,
    });
    await startServer(
      config,
      { queue, webhookSecret: config.gitlabWebhookSecret, pipeline, logger },
      logger,
    );
  } catch (error) {
    logger.error("服务启动失败", { message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}
