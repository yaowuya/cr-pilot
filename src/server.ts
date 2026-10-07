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
  const { queue, pipeline } = deps;
  const app = createApp({
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
  // 先加载项目根目录的 .env（存在才加载，不覆盖已有环境变量），再读取配置：
  // 本地开发把密钥放在 .env（已 gitignore），部署时用真实环境变量注入。
  loadEnvFileIfPresent(".env");
  const config = loadConfig();
  const logger = createConsoleLogger(config.logLevel);
  // 启动横幅先打印生效配置：排障时第一步就是确认进程实际用了哪套配置。
  // GitLab token 只确认是否配置，绝不打印值。
  logger.info("cr-pilot 正在启动", { node: process.version, logLevel: config.logLevel });
  logger.info("生效配置", {
    host: config.host,
    port: config.port,
    gitlabUrl: config.gitlabUrl,
    gitlabTokenSet: config.gitlabToken.length > 0,
    promptPath: config.promptPath,
    timeoutMs: config.timeoutMs,
    batchMaxTokens: config.batchMaxTokens,
    rulesDir: config.rulesDir,
    reviewStyle: config.reviewStyle,
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
    const rules = await loadReviewRules(config.rulesDir, fallbackPrompt, {
      logger,
      style: config.reviewStyle,
    });
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
      { queue, pipeline, logger },
      logger,
    );
  } catch (error) {
    logger.error("服务启动失败", { message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

/**
 * 加载 .env 文件（Node 22 内置 `process.loadEnvFile`，键值写进 process.env，
 * 已存在的同名环境变量优先）。文件不存在时静默跳过：部署环境不需要 .env，
 * 测试也从不经过直接执行入口。
 */
function loadEnvFileIfPresent(path: string): void {
  try {
    process.loadEnvFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // 文件存在但格式非法（如重复键）时抛错而不是静默继续：配置错误越早暴露越好。
      throw error;
    }
  }
}
