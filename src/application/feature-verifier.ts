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
import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import type { Logger } from "../shared/logger.ts";
import type { AppConfig } from "../shared/config.ts";
import { createPiReviewer } from "../infrastructure/pi/reviewer.ts";
import { createWecomNotifier } from "../infrastructure/wecom/wecom-notifier.ts";
import { loadReviewRules } from "../infrastructure/rules/review-rules.ts";
import { parseReviewScore, type RuleSet } from "../domain/review-rules.ts";
import { buildWecomMessage } from "./review-pipeline.ts";

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
}

/** 验证用例端口。 */
export interface FeatureVerifier {
  /** 执行一次 AI 评审验证；失败时返回 `success: false` 而不是抛错。 */
  verifyAi(): Promise<VerifyOutcome>;
  /**
   * 执行一次企微发送验证。
   *
   * `webhookOverride` 为空时按规则文件里的地址发送；`dryRun` 为 true 时只组装
   * 消息不发送，供页面在用户确认前预览。
   */
  verifyWecom(options?: { webhookOverride?: string; dryRun?: boolean }): Promise<VerifyOutcome>;
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

/**
 * 找到第一个配置了企微 webhook 的规则集。
 *
 * 真实配置里 webhook 挂在**仓库级**规则上（如 `prompts/rules/auto-ops.yaml`），
 * `default.yaml` 只有阈值；直接 `resolve()` 会拿到空地址。这里扫描规则目录，
 * 按文件名顺序取第一个带 webhook 的，让自检在没有指定仓库时也能工作。
 */
async function findRulesetWithWebhook(
  config: AppConfig,
  logger: Logger,
): Promise<{ ruleSet: RuleSet; repository: string }> {
  const files = (await readdir(config.rulesDir)).filter((name) => name.endsWith(".yaml") || name.endsWith(".yml")).sort();
  const rules = await loadRules(config, logger);
  for (const file of files) {
    // 用正则读 repository 字段，再交给统一解析器取规则集，
    // 避免在这里重复实现 YAML 解析与模板渲染。
    const raw = await readFile(`${config.rulesDir}/${file}`, "utf8").catch(() => "");
    const match = raw.match(/^repository:\s*(.+)$/m);
    if (!match) continue;
    const repository = match[1].trim().replace(/^["']|["']$/g, "");
    if (!repository) continue;
    const ruleSet = rules.resolve(repository);
    if (ruleSet.wecomWebhookUrl) return { ruleSet, repository };
  }
  throw new Error(
    `没有找到配置 wecom_webhook_url 的规则文件（目录 ${config.rulesDir}）。请先在某条规则里配置，或指定 webhook 地址。`,
  );
}

/** 构造一条明显标记为测试的企微消息，避免被误认为真实评审提醒。 */
export function buildVerifyMessage(input: { score: number; comment: string; ranAt: Date }): string {
  const base = buildWecomMessage({
    projectId: 0,
    iid: 0,
    fullName: "[验证] cr-pilot 功能自检（非真实 MR）",
    sourceBranch: "verify/sample",
    targetBranch: "verify/target",
    score: input.score,
    comment: input.comment,
    mrUrl: null,
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

    async verifyWecom(options = {}) {
      const startedAt = Date.now();
      try {
        let webhookUrl = options.webhookOverride?.trim() ?? "";
        let source = "命令行指定的地址";
        if (!webhookUrl) {
          const found = await findRulesetWithWebhook(config, logger);
          webhookUrl = found.ruleSet.wecomWebhookUrl ?? "";
          source = `规则文件（${found.repository}）`;
        }
        if (!webhookUrl) {
          return {
            success: false,
            message: "找不到企微 webhook 地址",
            detail: "规则文件未配置 wecom_webhook_url，也没有指定地址。",
            durationMs: Date.now() - startedAt,
          };
        }

        const message = buildVerifyMessage({ score: 60, comment: "P1：样例问题，用于验证消息组装。", ranAt: new Date() });
        const bytes = new TextEncoder().encode(message).length;
        if (options.dryRun) {
          return {
            success: true,
            message: `消息已组装，${bytes} 字节（未发送）`,
            detail: message,
            durationMs: Date.now() - startedAt,
          };
        }

        const notifier = createWecomNotifier({ logger });
        await notifier.send(webhookUrl, message);
        return {
          success: true,
          message: `企微消息已发送（${bytes} 字节）`,
          detail: `目标：${source}\n\n${message}`,
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        return {
          success: false,
          message: `企微发送失败：${error instanceof Error ? error.message : String(error)}`,
          detail: "",
          durationMs: Date.now() - startedAt,
        };
      }
    },
  };
}
