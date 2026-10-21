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
import { createAdoptionTracker } from "./application/adoption-tracker.ts";
import { startServer } from "./interfaces/http/server.ts";
import { openDatabase } from "./infrastructure/sqlite/database.ts";
import { createAdminRepository } from "./infrastructure/sqlite/admin-repo.ts";
import { createConfigRepository } from "./infrastructure/sqlite/config-repo.ts";
import { createWecomContactRepository } from "./infrastructure/sqlite/wecom-contact-repo.ts";
import { createPromptRepository } from "./infrastructure/sqlite/prompt-repo.ts";
import { createLlmProviderRepository } from "./infrastructure/sqlite/llm-provider-repo.ts";
import { createReviewRecordRepository } from "./infrastructure/sqlite/review-record-repo.ts";
import { createReviewFindingRepository } from "./infrastructure/sqlite/review-finding-repo.ts";
import { apiKeyEnvName, writeModelsJson } from "./infrastructure/pi/models-json.ts";
import { createAuthMiddleware, createRequireAdmin } from "./interfaces/http/auth-middleware.ts";
import { createStaticAssets } from "./interfaces/http/static-assets.ts";
import { createAdminsRouter } from "./interfaces/http/api/admins.ts";
import { createAuthRouter } from "./interfaces/http/api/auth.ts";
import { createConfigRouter } from "./interfaces/http/api/config.ts";
import { createWecomContactsRouter } from "./interfaces/http/api/wecom-contacts.ts";
import { createPromptsRouter } from "./interfaces/http/api/prompts.ts";
import { createProvidersRouter } from "./interfaces/http/api/providers.ts";
import { createReviewsRouter } from "./interfaces/http/api/reviews.ts";

/** 前端构建产物目录，与 `web/vite.config.ts` 的 outDir 对应。 */
const WEB_DIST_DIR = "dist";

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
    管理界面端口: config.uiPort > 0 && config.uiPort !== config.port ? config.uiPort : "(未启用)",
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

    // 持久化适配器：六个仓储共用同一连接（D-018 单连接 + WAL）。
    // adminUsername 传入用于计算角色（D-024）：只有它指定的账号是管理员。
    const admins = createAdminRepository(db, config.authSalt, config.adminUsername);
    const prompts = createPromptRepository(db);
    const providers = createLlmProviderRepository(db);
    const records = createReviewRecordRepository(db);
    const wecomContacts = createWecomContactRepository(db);
    const findings = createReviewFindingRepository(db);

    /**
     * 把数据库里的厂商配置导出到 `pi-agent/models.json`，并把密钥写进环境变量。
     *
     * 两件事必须一起做：models.json 里写的是 `$LLM_KEY_XXX` 引用，若只写文件不导出
     * 环境变量，SDK 解析密钥时会拿到空值并报 No API key found。
     *
     * 文件布局（D-025）：`models.json` 是运行时产物（已 gitignore），
     * `models.template.json` 入库作为初始配置。数据库为空时用模板兜底，
     * 保证新机器首次部署也能启动。
     */
    const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || "pi-agent";
    const syncModels = (): void => {
      const all = providers.list().map((item) => providers.get(item.id)).filter((item): item is NonNullable<typeof item> => Boolean(item));
      for (const provider of all) {
        if (provider.apiKey) process.env[apiKeyEnvName(provider.name)] = provider.apiKey;
      }
      const result = writeModelsJson({ agentDir, providers: all, defaultProvider: providers.getDefault() });
      // written=false 表示内容与磁盘一致（无变化），不打日志避免每次启动刷屏。
      if (result.written) {
        logger.info("已同步 LLM 厂商配置到 models.json", {
          路径: result.path,
          // 数据库厂商数单独说明：为 0 时文件内容来自模板兜底，
          // 直接写「厂商数=0 已同步」会让人误以为生成了空文件。
          数据库厂商数: all.length,
          默认模型: result.defaultModel ?? "(沿用模板)",
        });
      }
      // 数据库为空时依赖模板兜底：文件能生成但内容是模板里的厂商。
      // 若模板也缺失则完全没有 models.json，SDK 会报「No API key found」——
      // 那个报错与实际原因（没配厂商）不符，必须在这里显式告警。
      if (all.length === 0) {
        logger.warn("数据库中没有 LLM 厂商：models.json 将使用 models.template.json 的模板配置。请在「AI 厂商」页添加厂商");
      }
    };
    // 启动时同步一次：保证容器重建后 models.json 与数据库一致（数据库是唯一事实源）。
    syncModels();
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
    // 角色由 ADMIN_USERNAME 决定（D-024）：为空时没有任何账号是管理员，
    // 「管理员」页对所有人不可见。这通常是漏配 .env，必须显式告警。
    if (!config.adminUsername) {
      logger.warn("ADMIN_USERNAME 未配置：所有账号都将被视为普通账号，「管理员」页不可访问。请在 .env 中指定管理员账号名");
    } else {
      logger.info("管理员权限归属", { 管理员账号: config.adminUsername });
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
      llmProviders: providers,
      wecomContacts,
      findingWriter: findings,
      // 追踪定时任务拿不到 webhook 请求头的令牌，因此用部署盐加密后随建议持久化。
      secretKey: config.authSalt,
    });

    // 采纳追踪：独立的定时任务，不进评审队列——它只重新判定已有建议，
    // 与真实评审争抢并发槽位会拖慢评审响应。
    const adoptionTracker = createAdoptionTracker({ findings, client, logger, secretKey: config.authSalt });
    if (config.adoptionTrackingEnabled) {
      const timer = setInterval(() => {
        // runOnce 内部已消化所有异常，这里再兜一层防止未处理 rejection 终止进程。
        void adoptionTracker.runOnce().catch((error: unknown) => {
          logger.warn("采纳追踪轮次异常", { 错误: error instanceof Error ? error.message : String(error) });
        });
      }, config.adoptionSyncIntervalMs);
      // unref：定时器不应阻止进程退出（测试与优雅停机都依赖这一点）。
      timer.unref();
      logger.info("采纳追踪已启用", { 间隔毫秒: config.adoptionSyncIntervalMs });
    } else {
      logger.info("采纳追踪已关闭：ADOPTION_TRACKING_ENABLED=false");
    }

    const authMiddleware = createAuthMiddleware({ admins, authSalt: config.authSalt });
    // 管理员权限门：只挂在账号管理路由上，其余管理页所有登录账号都能用。
    const requireAdmin = createRequireAdmin();
    const staticAssets = createStaticAssets({ distDir: WEB_DIST_DIR, logger });
    await startServer(
      config,
      {
        queue,
        pipeline,
        logger,
        // 有新提交时只登记追踪，不重复跑完整评审。追踪轮次由定时器驱动，
        // 这里只记日志；定时器保证最终会被处理。
        enqueueTracking: (task) => {
          logger.info("MR 有新提交，等待下一轮采纳追踪", {
            项目ID: task.projectId,
            MR编号: task.iid,
          });
        },
        authMiddleware,
        // 登录免鉴权；me 自带鉴权（否则无法用于校验本地令牌）。
        publicApiRoutes: { "/api/auth": createAuthRouter({ admins, authSalt: config.authSalt, authMiddleware }) },
        apiRoutes: {
          "/api/admins": createAdminsRouter({ admins, requireAdmin }),
          "/api/reviews": createReviewsRouter({ records, findings }),
          "/api/config": createConfigRouter({ config: configRepo }),
          "/api/wecom-contacts": createWecomContactsRouter({ contacts: wecomContacts }),
          "/api/prompts": createPromptsRouter({ prompts, providers, rulesDir: config.rulesDir }),
          "/api/providers": createProvidersRouter({ providers, onChanged: syncModels }),
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
