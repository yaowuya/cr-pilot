import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createConsoleLogger, createFileLogger } from "./shared/logger.ts";
import { applyConfigOverrides, loadConfig } from "./shared/config.ts";
import { createTaskQueue } from "./shared/queue.ts";
import { createGitlabClient } from "./infrastructure/gitlab/gitlab-client.ts";
import { createPiReviewer } from "./infrastructure/pi/reviewer.ts";
import { loadReviewRules } from "./infrastructure/rules/review-rules.ts";
import { createWecomNotifier } from "./infrastructure/wecom/wecom-notifier.ts";
import { createReviewPipeline } from "./application/review-pipeline.ts";
import { startServer } from "./interfaces/http/server.ts";
import { openDatabase } from "./infrastructure/sqlite/database.ts";
import { createAdminRepository } from "./infrastructure/sqlite/admin-repo.ts";
import { createConfigRepository } from "./infrastructure/sqlite/config-repo.ts";
import { createPromptRepository } from "./infrastructure/sqlite/prompt-repo.ts";
import { createReviewRecordRepository } from "./infrastructure/sqlite/review-record-repo.ts";
import { createAuthMiddleware } from "./interfaces/http/auth-middleware.ts";
import { createStaticAssets } from "./interfaces/http/static-assets.ts";
import { createAdminsRouter } from "./interfaces/http/api/admins.ts";
import { createAuthRouter } from "./interfaces/http/api/auth.ts";
import { createConfigRouter } from "./interfaces/http/api/config.ts";
import { createPromptsRouter } from "./interfaces/http/api/prompts.ts";
import { createReviewsRouter } from "./interfaces/http/api/reviews.ts";

/** 前端构建产物目录，与 `web/vite.config.ts` 的 outDir 对应。 */
const WEB_DIST_DIR = "web/dist";

// 仅在直接执行本文件时启动服务。测试会导入各模块，因此必须有这层判定，
// 否则一次 import 就会占用端口并留下一个不会退出的进程。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // 先加载项目根目录的 .env（存在才加载，不覆盖已有环境变量），再读取配置：
  // 本地开发把密钥放在 .env（已 gitignore），部署时用真实环境变量注入。
  loadEnvFileIfPresent(".env");

  // 分两次读配置，顺序不可调换：
  // 1) 第一次只为拿到数据库路径（DB_PATH 本身不来自数据库覆盖）；
  // 2) 打开库、把覆盖值写进 process.env（数据库优先）；
  // 3) 第二次才得到最终生效配置。
  // 若合并成一次读取，数据库覆盖将不生效——P-005 的语义会被静默破坏。
  const bootstrapConfig = loadConfig();
  const dbFile = bootstrapConfig.dbPath;
  if (dbFile !== ":memory:") {
    // 首次启动时 data 目录可能还不存在（容器挂载卷首次创建），提前建好。
    mkdirSync(dirname(dbFile), { recursive: true });
  }
  const db = openDatabase(dbFile);
  const configRepo = createConfigRepository(db);
  const overrides: Record<string, string> = {};
  for (const item of configRepo.list()) overrides[item.key] = item.value;
  applyConfigOverrides(process.env, overrides);

  const config = loadConfig();
  const logger = config.logFile ? createFileLogger(config.logLevel, config.logFile) : createConsoleLogger(config.logLevel);
  // 启动横幅先打印生效配置：排障时第一步就是确认进程实际用了哪套配置。
  logger.info("cr-pilot 正在启动", { Node版本: process.version, 日志级别: config.logLevel });
  logger.info("生效配置", {
    监听地址: config.host,
    端口: config.port,
    GitLab地址: config.gitlabUrl,
    Prompt路径: config.promptPath,
    评审超时毫秒: config.timeoutMs,
    单批Token预算: config.batchMaxTokens,
    规则目录: config.rulesDir,
    评审风格: config.reviewStyle,
    队列并发数: config.queueConcurrency,
    日志文件: config.logFile,
    数据库: dbFile,
    配置覆盖项: Object.keys(overrides).length,
    // 只确认是否配置，绝不打印密钥值。容器内 pi 通过 models.json 的
    // $LLMGW_API_KEY 插值取密钥；为空时评审会报 No API key found。
    模型密钥已配置: Boolean(process.env.LLMGW_API_KEY),
  });
  if (!process.env.LLMGW_API_KEY) {
    logger.warn("LLMGW_API_KEY 未配置：pi 评审将报 No API key found，请在 .env 中填写模型密钥");
  }
  if (!config.authSalt) {
    // 空盐会让令牌可预测：派生值只依赖用户名，任何人都能算出别人的令牌。
    logger.warn("AUTH_SALT 未配置：管理 API 的令牌可被预测，请在 .env 中设置随机盐");
  }
  try {
    // 组合根：把基础设施适配器实现注入到应用用例，再把用例注入 HTTP 路由。
    const queue = createTaskQueue(config.queueConcurrency, logger);
    const client = createGitlabClient({
      url: config.gitlabUrl,
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
    const wecomNotifier = createWecomNotifier({ logger });

    // 持久化适配器：四个仓储共用同一连接（D-018 单连接 + WAL）。
    const admins = createAdminRepository(db, config.authSalt);
    const prompts = createPromptRepository(db);
    const records = createReviewRecordRepository(db);
    // 首次启动引导首个管理员（D-011）；已有账号时不覆盖。
    admins.ensureInitialAdmin(config.adminUsername, config.adminPassword);
    if (config.adminUsername && admins.count() === 0) {
      logger.warn("ADMIN_USERNAME 为空：管理 API 无可用账号，请配置后重启");
    } else if (config.adminUsername) {
      logger.info("管理员账号已就绪", { 账号数: admins.count() });
    }

    const pipeline = createReviewPipeline({
      client,
      rules,
      reviewer,
      logger,
      batchMaxTokens: config.batchMaxTokens,
      timeoutMs: config.timeoutMs,
      wecomNotifier,
      recordWriter: records,
      promptSource: prompts,
    });

    const authMiddleware = createAuthMiddleware({ admins, authSalt: config.authSalt });
    const staticAssets = createStaticAssets({ distDir: WEB_DIST_DIR, logger });
    await startServer(
      config,
      {
        queue,
        pipeline,
        logger,
        authMiddleware,
        // 登录免鉴权；me 自带鉴权（否则无法用于校验本地令牌）。
        publicApiRoutes: { "/api/auth": createAuthRouter({ admins, authSalt: config.authSalt, authMiddleware }) },
        apiRoutes: {
          "/api/admins": createAdminsRouter({ admins }),
          "/api/reviews": createReviewsRouter({ records }),
          "/api/config": createConfigRouter({ config: configRepo }),
          "/api/prompts": createPromptsRouter({ prompts, rulesDir: config.rulesDir }),
        },
        staticAssets,
      },
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
