import express, { type Express } from "express";
import { extractGitlabContext, isGitlabPayload } from "./gitlab.ts";
import { loadReviewPrompt } from "./prompt.ts";
import type { Reviewer } from "./reviewer.ts";

/** 应用依赖。全部显式注入，接口层测试无需触碰真实模型。 */
export interface AppDeps {
  /** 评审执行者。 */
  reviewer: Reviewer;
  /** 评审 prompt 文件路径，每个请求重新读取。 */
  promptPath: string;
  /** 单次评审的超时毫秒数。 */
  timeoutMs: number;
}

/** 创建 Express 应用。不含监听逻辑，便于测试用随机端口启动。 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  // diff 可能较大，放宽默认的 100kb 限制；上限仍是常量，避免无界读取请求体。
  app.use(express.json({ limit: "2mb" }));

  app.post("/review/webhook", async (req, res) => {
    const body: unknown = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      res.status(400).json({ error: "请求体必须是 JSON 对象" });
      return;
    }
    const payload = body as Record<string, unknown>;

    const code = typeof payload.code === "string" ? payload.code.trim() : "";
    if (!code) {
      res.status(400).json({ error: describeMissingCode(payload) });
      return;
    }

    const contextParts: string[] = [];
    if (typeof payload.context === "string" && payload.context.trim()) {
      contextParts.push(payload.context.trim());
    }
    if (isGitlabPayload(payload)) {
      const gitlabContext = extractGitlabContext(payload);
      if (gitlabContext) contextParts.push(gitlabContext);
    }
    const context = contextParts.join("\n\n") || undefined;

    const startedAt = Date.now();
    const systemPrompt = await loadReviewPrompt(deps.promptPath);
    const signal = AbortSignal.timeout(deps.timeoutMs);
    const result = await deps.reviewer.review({ systemPrompt, code, context, signal });
    res.json({ review: result.text, model: result.model, duration_ms: Date.now() - startedAt });
  });

  return app;
}

/**
 * 生成缺少 code 时的错误信息。
 *
 * GitLab 的 webhook 不含代码，调用方容易误以为接口会自己去拉 diff，
 * 因此命中 GitLab payload 时把这一点直接写进错误信息。
 */
function describeMissingCode(payload: Record<string, unknown>): string {
  return isGitlabPayload(payload)
    ? "GitLab payload 不含代码内容，请在请求体中附带非空的 code 字段"
    : "请求体缺少非空的 code 字段";
}
