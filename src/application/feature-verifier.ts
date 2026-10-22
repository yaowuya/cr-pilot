/**
 * 功能自检用例：不依赖真实 MR，直接验证 AI 评审与企微推送两条链路。
 *
 * 为什么需要它：这两条链路此前只能等真实 MR 合并后才能观察效果，反馈周期长、
 * 不可控。评审器只接收 `{ systemPrompt, code }`，企微通知器只需一个 webhook 地址，
 * 都能在本地隔离驱动，因此把它们做成可随时触发的自检能力（页面按钮与 CLI 共用）。
 *
 * 与 CLI 的关系：`scripts/verify-features.ts` 只负责参数解析与打印，真正的验证
 * 逻辑放在这里，避免两套实现漂移。
 *
 * 安全边界：不写数据库、不发 MR 评论、不改仓库文件。企微消息固定带 `[验证]`
 * 前缀与发送时间，避免被误认为真实评审提醒。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import type { Logger } from "../shared/logger.ts";
import type { AppConfig } from "../shared/config.ts";
import { createPiReviewer } from "../infrastructure/pi/reviewer.ts";
import { createWecomNotifier } from "../infrastructure/wecom/wecom-notifier.ts";
import { loadReviewRules } from "../infrastructure/rules/review-rules.ts";
import { parseReviewScore } from "../domain/review-rules.ts";
import { maskWecomUserId, type WecomContactRepository } from "../domain/wecom-contact.ts";
import type { PromptRepository } from "../domain/review-prompt.ts";
import { buildWecomMessage, renderWecomMention, type WecomMentionTarget } from "./review-pipeline.ts";

/**
 * 验证用的样例 diff。
 *
 * 刻意包含三类典型问题（SQL 注入、硬编码密钥、N+1 查询）：模型只要能识别出
 * 其中任意一类并给出低分，就说明 prompt 与模型链路是通的。用固定样例而不是
 * 随机代码，让多次验证的结果可以横向比较。
 */
export const SAMPLE_DIFF = `diff --git a/src/auth/login.ts b/src/auth/login.ts
index 1111111..2222222 100644
--- a/src/auth/login.ts
+++ b/src/auth/login.ts
@@ -10,6 +10,18 @@ export async function login(req: Request, res: Response) {
+  // 硬编码密钥，且未做任何失败处理
+  const SECRET = "super-secret-key-12345";
+  const user = await db.query(
+    \`SELECT * FROM users WHERE name = '\${req.body.name}' AND pwd = '\${req.body.password}'\`
+  );
+  if (user) {
+    const token = jwt.sign({ id: user.id }, SECRET);
+    res.json({ token });
+  }
+  // 未处理 user 为空的情况，也没有 try/catch
 }
diff --git a/src/api/orders.ts b/src/api/orders.ts
index 3333333..4444444 100644
--- a/src/api/orders.ts
+++ b/src/api/orders.ts
@@ -20,3 +20,8 @@ export async function listOrders(ids: number[]) {
+  // 循环里逐条查库，典型的 N+1
+  const rows = [];
+  for (const id of ids) {
+    rows.push(await db.query(\`SELECT * FROM orders WHERE id = \${id}\`));
+  }
+  return rows;
 }`;

/** 一次验证任务的状态。 */
export type VerifyTaskStatus = "running" | "success" | "failed";

/** 验证任务结果；页面与 CLI 共用同一结构。 */
export interface VerifyTask {
  id: string;
  /** 验证类型：AI 评审或企微推送。 */
  kind: "ai" | "wecom";
  status: VerifyTaskStatus;
  /** 成功时的一句话结论；失败时为错误原因。 */
  message: string;
  /** 详细信息（评审摘要、发送字节数、群名等），供页面展开查看。 */
  detail: string;
  /** 耗时毫秒；未结束时为 0。 */
  durationMs: number;
  /** Unix 毫秒。 */
  startedAt: number;
  finishedAt: number | null;
}

/** 验证用例依赖。 */
export interface FeatureVerifierDeps {
  config: AppConfig;
  logger: Logger;
  /** 与正式通知共用的提交人映射；只查询，不写入，也不从登录账号推断提交人。 */
  wecomContacts?: Pick<WecomContactRepository, "findByGitlabUsername">;
  /** 与正式评审共用数据库优先的 prompt 来源；缺省时保留现有纯 YAML 用法。 */
  promptSource?: Pick<PromptRepository, "list" | "resolve">;
}

/**
 * 一个可选的企微机器人（群机器人）。
 *
 * 机器人身份是本次评审最终生效的 `wecom_webhook_url`（数据库优先、YAML 兜底）；
 * 同一地址被多个项目复用时视为同一个机器人。地址含 `key=` 密钥，因此对外只暴露 `id` 与脱敏后的 key，
 * 原始 URL 不下发到浏览器，也不接受前端回传任意地址。
 */
export interface WecomBot {
  /** 由 webhook 地址派生的稳定标识；同一地址恒定，不含明文密钥。 */
  id: string;
  /** 脱敏 key：仅保留末 4 位，便于人工核对是哪台机器人。 */
  maskedKey: string;
  /** 使用该机器人的项目名称（从数据库项目绑定与 YAML 候选项目解析）。 */
  repositories: string[];
}

/** 企微自检输入；页面提交 GitLab 账号与机器人标识，实际地址由服务端解析。 */
export interface VerifyWecomOptions {
  /** 仅 CLI 使用：本机运维指定任意地址，HTTP 接口不接受该字段。 */
  webhookOverride?: string;
  /** 页面选择：已配置机器人的 id，由 `listWecomBots` 提供。 */
  webhookId?: string;
  dryRun?: boolean;
  /** 被测提交人的 GitLab 账号；省略仅兼容既有 CLI 的无提及验证。 */
  gitlabUsername?: string;
}

/** 验证用例端口。 */
export interface FeatureVerifier {
  /** 执行一次 AI 评审验证；失败时返回 `success: false` 而不是抛错。 */
  verifyAi(): Promise<VerifyOutcome>;
  /** 列出当前生效的企微机器人（数据库优先、YAML 兜底），按地址去重。 */
  listWecomBots(): Promise<WecomBot[]>;
  /**
   * 执行一次企微发送验证。
   *
   * 目标优先级：`webhookOverride`（仅 CLI）> `webhookId`（页面选择）。
   * `dryRun` 为 true 时只组装消息不发送。提供 `gitlabUsername` 时读取现有映射
   * 并验证末行提及；映射不存在则失败而不发送，不能把 GitLab 账号直接当企微 userid。
   */
  verifyWecom(options?: VerifyWecomOptions): Promise<VerifyOutcome>;
}

/** 一次验证的结构化结果。 */
export interface VerifyOutcome {
  success: boolean;
  message: string;
  detail: string;
  durationMs: number;
}

/** 加载规则集合；与主程序同一套配置来源。 */
async function loadRules(config: AppConfig, logger: Logger) {
  const fallbackPrompt = await readFile(config.promptPath, "utf8").catch(() => "");
  if (!fallbackPrompt) {
    throw new Error(`读取 prompt 兜底文件失败：${config.promptPath}。请确认工作目录是仓库根，或检查 REVIEW_PROMPT_PATH`);
  }
  return loadReviewRules(config.rulesDir, fallbackPrompt, { logger, style: config.reviewStyle });
}

/** 从 webhook 地址派生稳定 id：取 SHA-256 前 12 位，不可反推密钥。 */
function webhookIdOf(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 12);
}

/** 脱敏 webhook key：只保留末 4 位，其余用星号覆盖。 */
export function maskWebhookKey(url: string): string {
  const key = /[?&]key=([^&]+)/.exec(url)?.[1] ?? "";
  if (!key) return "（无法解析 key）";
  return key.length <= 4 ? "****" : `****${key.slice(-4)}`;
}

/** 规则文件里的仓库列表；`repository` 支持逗号分隔多个仓库。 */
function parseRepositories(raw: string): string[] {
  const match = raw.match(/^repository:\s*(.+)$/m);
  if (!match) return [];
  return match[1]
    .trim()
    .replace(/^["']|["']$/g, "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 列出当前能用于评审的企微机器人（按最终生效地址去重）。
 *
 * 正式评审在 `review-pipeline.ts` 中先调用数据库的 `resolve(project)`；只有数据库
 * 没有项目或 default 记录时才回落 YAML。候选项目来自两处，逐项复用同一优先级
 * 求实际地址；如果 DB 已命中但未配置 webhook，不能偷偷回退到陈旧的 YAML 地址。
 * `default` 单独加入，用于没有项目规则的 MR；原始 URL 只留在服务端。
 */
async function collectWecomBots(
  config: AppConfig,
  logger: Logger,
  promptSource?: FeatureVerifierDeps["promptSource"],
): Promise<{ bot: WecomBot; url: string }[]> {
  // 生产环境可能仅保留数据库 prompt，YAML 目录缺失不能屏蔽已配置的机器人。
  const files = (await readdir(config.rulesDir).catch(() => []))
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml")).sort();
  const rules = await loadRules(config, logger);
  const projects = new Set<string>();
  for (const file of files) {
    const raw = await readFile(`${config.rulesDir}/${file}`, "utf8").catch(() => "");
    for (const repository of parseRepositories(raw)) projects.add(repository);
  }
  for (const prompt of promptSource?.list() ?? []) {
    for (const project of prompt.projects) projects.add(project);
  }

  const byUrl = new Map<string, WecomBot>();
  const add = (url: string | undefined, project: string): void => {
    const normalized = url?.trim();
    if (!normalized) return;
    const existing = byUrl.get(normalized);
    if (existing) {
      if (!existing.repositories.includes(project)) existing.repositories.push(project);
      return;
    }
    byUrl.set(normalized, { id: webhookIdOf(normalized), maskedKey: maskWebhookKey(normalized), repositories: [project] });
  };

  // 数据库 default 即使没有 webhook 也遮蔽 YAML default；与真实评审链路保持一致。
  const dbDefault = promptSource?.resolve();
  add(dbDefault ? dbDefault.wecomWebhookUrl : rules.resolve().wecomWebhookUrl, "default");
  for (const project of projects) {
    const stored = promptSource?.resolve(project);
    add(stored ? stored.wecomWebhookUrl : rules.resolve(project).wecomWebhookUrl, project);
  }
  return [...byUrl.entries()].map(([url, bot]) => ({ bot, url }));
}

/** 包装正式通知模板，保留提交人的末行提及，并明确标记为测试消息。 */
export function buildVerifyMessage(input: {
  score: number;
  comment: string;
  ranAt: Date;
  mention?: WecomMentionTarget;
}): string {
  const base = buildWecomMessage({
    projectId: 0,
    iid: 0,
    fullName: "[验证] cr-pilot 功能自检（非真实 MR）",
    sourceBranch: "verify/sample",
    targetBranch: "verify/target",
    score: input.score,
    comment: input.comment,
    mrUrl: null,
    mention: input.mention,
  });
  const stamp = input.ranAt.toLocaleString("zh-CN", { hour12: false });
  // 前缀 + 时间戳：群里一眼能看出这是验证消息，不是某次真实评审。
  return `# ⚠️ [验证] cr-pilot 功能自检\n\n> 这条不是真实 MR 评审提醒，由「功能自检」在 ${stamp} 发出。\n\n${base}`;
}

/** 创建功能自检用例。 */
export function createFeatureVerifier(deps: FeatureVerifierDeps): FeatureVerifier {
  const { config, logger } = deps;

  return {
    async verifyAi() {
      const startedAt = Date.now();
      try {
        // AI 验证不针对具体仓库，用 default 规则即可。
        const rules = await loadRules(config, logger);
        const ruleSet = rules.resolve();
        const reviewer = createPiReviewer({ logger });
        const controller = new AbortController();
        // 与主程序一致的超时口径：超时即验证失败，避免页面一直转圈。
        const timer = setTimeout(() => controller.abort(new Error(`超过 ${config.timeoutMs}ms 未返回`)), config.timeoutMs);
        let text: string;
        try {
          const result = await reviewer.review({ systemPrompt: ruleSet.systemPrompt, code: SAMPLE_DIFF, signal: controller.signal });
          text = result.text;
        } finally {
          clearTimeout(timer);
        }
        const durationMs = Date.now() - startedAt;

        if (!text.trim()) {
          return { success: false, message: "AI 评审返回空文本", detail: "通常是 prompt 或模型配置问题，请检查「AI 厂商」页与 prompt 文件。", durationMs };
        }
        const score = parseReviewScore(text);
        if (score <= 0) {
          return {
            success: false,
            message: "评审输出里解析不到总分",
            detail: `模型未按 prompt 约定输出「总分：N 分」。原始输出前 500 字：\n${text.slice(0, 500)}`,
            durationMs,
          };
        }
        return {
          success: true,
          message: `AI 评审通过，解析出 ${score} 分`,
          detail: text.slice(0, 500),
          durationMs,
        };
      } catch (error) {
        return {
          success: false,
          message: `AI 评审失败：${error instanceof Error ? error.message : String(error)}`,
          detail: "",
          durationMs: Date.now() - startedAt,
        };
      }
    },

    async listWecomBots() {
      const bots = await collectWecomBots(config, logger, deps.promptSource);
      // 排序只为让下拉顺序稳定，便于反复验证时定位同一台机器人。
      return bots.map((item) => item.bot).sort((left, right) => left.id.localeCompare(right.id));
    },

    async verifyWecom(options = {}) {
      const startedAt = Date.now();
      let mention: WecomMentionTarget | undefined;
      let webhookUrl = "";
      try {
        let renderedMention: string | null = null;
        let mentionDescription = "未选择测试提交人，本次未验证 @ 提交人。";
        if (options.gitlabUsername !== undefined) {
          const gitlabUsername = options.gitlabUsername.trim();
          if (!gitlabUsername) throw new Error("请选择测试提交人");
          // 自检没有真实 MR 作者，必须由用户选人，再从服务端映射解析，不能猜登录者
          // 或默认取第一条映射。每次执行都重新查，避免页面加载后映射被改动或删除。
          const contact = deps.wecomContacts?.findByGitlabUsername(gitlabUsername);
          if (!contact) throw new Error("找不到该提交人的企微映射，请先在「企微映射」页登记或刷新列表");
          mention = { userId: contact.wecomUserId, name: contact.wecomName };
          renderedMention = renderWecomMention(mention);
          if (!renderedMention) throw new Error("该提交人的企微映射无法生成安全的提及，请检查姓名与 userid");
          mentionDescription = renderedMention.startsWith("<@") ? "真实成员提醒" : "仅中文姓名展示，不触发成员提醒";
        }
        webhookUrl = options.webhookOverride?.trim() ?? "";
        let source = "命令行指定的地址";
        if (!webhookUrl && options.webhookId) {
          // 页面只回传 id；真实地址必须由服务端按当前配置解析，
          // 这样浏览器既不接触密钥，也无法把自检当成任意地址的出口。
          const bots = await collectWecomBots(config, logger, deps.promptSource);
          const selected = bots.find((item) => item.bot.id === options.webhookId);
          if (!selected) throw new Error("所选企微机器人不存在或配置已变更，请刷新机器人列表后重试");
          webhookUrl = selected.url;
          const repoLabel = selected.bot.repositories[0] ?? "未关联仓库";
          const extra = selected.bot.repositories.length > 1 ? ` 等 ${selected.bot.repositories.length} 个仓库` : "";
          source = `机器人 ${selected.bot.maskedKey}（${repoLabel}${extra}）`;
        }
        if (!webhookUrl) {
          // CLI 未装配数据库时仍取第一条 YAML 机器人；服务端注入仓储后取
          // 当前生效的第一台机器人，不能使用已被数据库覆盖的旧 YAML 地址。
          const first = (await collectWecomBots(config, logger, deps.promptSource))[0];
          if (first) {
            webhookUrl = first.url;
            source = `当前生效规则（${first.bot.repositories[0]}，${first.bot.maskedKey}）`;
          }
        }
        if (!webhookUrl) {
          return {
            success: false,
            message: "找不到企微 webhook 地址",
            detail: "当前生效的数据库/YAML 规则未配置 wecom_webhook_url，也没有指定地址。",
            durationMs: Date.now() - startedAt,
          };
        }

        const message = buildVerifyMessage({ score: 60, comment: "P1：样例问题，用于验证消息组装。", ranAt: new Date(), mention });
        const bytes = new TextEncoder().encode(message).length;
        // 发群仍用真实 <@userid>；只在返回给页面/CLI 的结果文本中遮盖中间字符。
        const displayMessage = renderedMention?.startsWith("<@") && mention?.userId && message.endsWith(renderedMention)
          ? `${message.slice(0, -renderedMention.length)}<@${maskWecomUserId(mention.userId.trim())}>`
          : message;
        if (options.dryRun) {
          return {
            success: true,
            message: `消息已组装，${bytes} 字节（未发送）`,
            // 预览也要标明目标机器人：否则用户无法确认这条消息准备发到哪个群。
            detail: `目标：${source}\n提及方式：${mentionDescription}\n\n${displayMessage}`,
            durationMs: Date.now() - startedAt,
          };
        }

        const notifier = createWecomNotifier({ logger });
        await notifier.send(webhookUrl, message);
        return {
          success: true,
          message: `企微消息已发送（${bytes} 字节）`,
          detail: `目标：${source}\n提及方式：${mentionDescription}\n\n${displayMessage}`,
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        let reason = error instanceof Error ? error.message : String(error);
        // 企微 errmsg 可能原样引用 userid 或 webhook；错误结果也不能泄露明文。
        if (webhookUrl) reason = reason.replaceAll(webhookUrl, "[企微 webhook 已隐藏]");
        const userId = mention?.userId?.trim();
        if (userId) reason = reason.replaceAll(userId, maskWecomUserId(userId));
        return {
          success: false,
          message: `企微发送失败：${reason}`,
          detail: "",
          durationMs: Date.now() - startedAt,
        };
      }
    },
  };
}
