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
  //
  // 这段必须包在 try 里：覆盖值可能来自管理页面，非法值（如 PORT=abc）会让
  // loadConfig 抛错。裸抛意味着进程直接退出，而此时日志器还没建好，
  // 排障者从日志与启动横幅都拿不到任何线索。
  let dbFile = "";
  let db: ReturnType<typeof openDatabase> | undefined;
  let configRepo: ReturnType<typeof createConfigRepository> | undefined;
  let overrides: Record<string, string> = {};
  let config: ReturnType<typeof loadConfig>;
  try {
    const bootstrapConfig = loadConfig();
    dbFile = bootstrapConfig.dbPath;
    if (dbFile !== ":memory:") {
      // 首次启动时 data 目录可能还不存在（容器挂载卷首次创建），提前建好。
      mkdirSync(dirname(dbFile), { recursive: true });
    }
    db = openDatabase(dbFile);
    configRepo = createConfigRepository(db);
    for (const item of configRepo.list()) overrides[item.key] = item.value;
    applyConfigOverrides(process.env, overrides);
    config = loadConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `[FATAL] 配置加载失败：${message}\n` +
        `数据库：${dbFile || "(未确定)"}\n` +
        `可能是管理页面写入的覆盖值非法。请检查 .env 与数据库 config_overrides 表，` +
        `清理非法项后重启（容器内可用 sqlite3 或删除该行）。\n`,
    );
    process.exit(1);
  }
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
  // 空盐时令牌 = 只依赖用户名的公开派生值，任何人都能离线算出 admin 的令牌，
  // 等于管理 API（配置、账号、评审记录）完全开放。这比「令牌可预测」严重得多，
  // 因此在启动前直接终止，而不是只告警后继续提供不设防的管理接口。
  if (!config.authSalt) {
    logger.error(
      "AUTH_SALT 未配置：管理 API 的令牌可被离线伪造，服务拒绝启动。" +
        "请在 .env 中设置 AUTH_SALT（建议 32 位随机 hex），例如：" +
        'node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'hex\'))"',
    );
    process.exitCode = 1;
  } else {
    await startApplication({ config, logger, db: db as NonNullable<typeof db>, configRepo: configRepo as NonNullable<typeof configRepo> });
  }
}

/** 启动应用：装配全部适配器与路由，最后监听端口。 */
async function startApplication(input: {
  config: ReturnType<typeof loadConfig>;
  logger: ReturnType<typeof createConsoleLogger>;
  db: NonNullable<ReturnType<typeof openDatabase>>;
  configRepo: NonNullable<ReturnType<typeof createConfigRepository>>;
}): Promise<void> {
  const { config, logger, db, configRepo } = input;
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
    // 密码为空时跳过：空密码账号无法登录（登录接口要求非空），却会占住
    // 「表为空」的位置，导致后续再配 ADMIN_PASSWORD 也不会被创建。
    if (config.adminUsername && config.adminPassword) {
      admins.ensureInitialAdmin(config.adminUsername, config.adminPassword);
    }
    if (admins.count() === 0) {
      logger.warn("尚无管理员账号：请设置 ADMIN_USERNAME 与 ADMIN_PASSWORD 后重启，否则管理页面无法登录");
    } else {
      logger.info("管理员账号已就绪", { 账号数: admins.count(), 引导已启用: Boolean(config.adminUsername && config.adminPassword) });
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
