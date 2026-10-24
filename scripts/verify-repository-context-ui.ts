/**
 * 隔离 UI 验证入口：使用真实 Express/router/SQLite 和已构建页面，
 * 仅创建正常启动账号，业务配置必须经页面创建。不加载 .env、不接模型或真实 GitLab。
 * 监听随机本机端口；退出关闭临时库并清理，强杀后由验证者清理打印的专属临时目录。
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/interfaces/http/app.ts";
import { createAuthMiddleware, createRequireAdmin } from "../src/interfaces/http/auth-middleware.ts";
import { createAuthRouter } from "../src/interfaces/http/api/auth.ts";
import { createAdminsRouter } from "../src/interfaces/http/api/admins.ts";
import { createPromptsRouter } from "../src/interfaces/http/api/prompts.ts";
import { createProvidersRouter } from "../src/interfaces/http/api/providers.ts";
import { createReviewsRouter } from "../src/interfaces/http/api/reviews.ts";
import { createStaticAssets } from "../src/interfaces/http/static-assets.ts";
import { createAdminRepository } from "../src/infrastructure/sqlite/admin-repo.ts";
import { createPromptRepository } from "../src/infrastructure/sqlite/prompt-repo.ts";
import { createLlmProviderRepository } from "../src/infrastructure/sqlite/llm-provider-repo.ts";
import { createReviewRecordRepository } from "../src/infrastructure/sqlite/review-record-repo.ts";
import { openDatabase } from "../src/infrastructure/sqlite/database.ts";
import { createSilentLogger } from "../src/shared/logger.ts";

const root = await mkdtemp(join(tmpdir(), "crp-ui-context-"));
const rulesDir = join(root, "rules");
await mkdir(rulesDir);
const db = openDatabase(join(root, "ui.db"));
const logger = createSilentLogger();
const authSalt = "isolated-ui-validation-only";
/** 每次运行随机生成，避免仓库里出现看似真实的固定口令。 */
const username = "ui-reviewer";
const password = `local-${randomBytes(12).toString("hex")}`;
const admins = createAdminRepository(db, authSalt, username);
admins.ensureInitialAdmin(username, password);
const prompts = createPromptRepository(db);
const providers = createLlmProviderRepository(db);
const authMiddleware = createAuthMiddleware({ admins, authSalt });
const app = createApp({
  logger, enqueue: () => { throw new Error("隔离验证实例不执行 webhook 任务"); },
  authMiddleware,
  publicApiRoutes: { "/api/auth": createAuthRouter({ admins, authSalt, authMiddleware }) },
  apiRoutes: {
    "/api/prompts": createPromptsRouter({ prompts, providers, rulesDir }),
    "/api/providers": createProvidersRouter({ providers }),
    "/api/admins": createAdminsRouter({ admins, requireAdmin: createRequireAdmin() }),
    "/api/reviews": createReviewsRouter({ records: createReviewRecordRepository(db) }),
  },
  staticAssets: createStaticAssets({ distDir: resolve("dist"), logger }),
});
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((done, reject) => { server.once("listening", done); server.once("error", reject); });
const address = server.address();
if (!address || typeof address === "string") throw new Error("未取得隔离验证端口");
console.log(JSON.stringify({url:`http://127.0.0.1:${address.port}`,username,password,temporaryDirectory:root,coreApi:"real Express + SQLite",mockedCoreApi:false}));
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await new Promise<void>(done => server.close(() => done()));
  db.close();
  await rm(root, { recursive:true, force:true, maxRetries:3 });
}
process.once("SIGINT", () => { void stop().then(() => process.exit(0)); });
process.once("SIGTERM", () => { void stop().then(() => process.exit(0)); });
