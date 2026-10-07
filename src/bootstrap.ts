import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { createConsoleLogger } from "./shared/logger.ts";
import { loadConfig } from "./shared/config.ts";
import { createTaskQueue } from "./shared/queue.ts";
import { createGitlabClient } from "./infrastructure/gitlab/gitlab-client.ts";
import { createPiReviewer } from "./infrastructure/pi/reviewer.ts";
import { loadReviewRules } from "./infrastructure/rules/review-rules.ts";
import { createReviewPipeline } from "./application/review-pipeline.ts";
import { startServer } from "./interfaces/http/server.ts";

// 仅在直接执行本文件时启动服务。测试会导入各模块，因此必须有这层判定，
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
    // 组合根：把基础设施适配器实现注入到应用用例，再把用例注入 HTTP 路由。
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
