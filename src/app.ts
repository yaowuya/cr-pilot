import express, { type Express, type NextFunction, type Request, type Response } from "express";
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
    let systemPrompt: string;
    try {
      systemPrompt = await loadReviewPrompt(deps.promptPath);
    } catch (error) {
      // prompt 不可用属于服务端配置问题，与评审失败区分开，调用方据此排查方向不同。
      res.status(500).json({ error: error instanceof Error ? error.message : "读取 prompt 失败" });
      return;
    }

    const signal = AbortSignal.timeout(deps.timeoutMs);
    try {
      const result = await deps.reviewer.review({ systemPrompt, code, context, signal });
      const review = result.text.trim();
      if (!review) {
        // Reviewer 是可替换契约，空结果在这里再挡一次，避免把空评审当成功返回。
        res.status(502).json({ error: "评审结果为空" });
        return;
      }
      res.json({ review, model: result.model, duration_ms: Date.now() - startedAt });
    } catch (error) {
      // 超时判定只看信号状态：pi 在中断时抛出的错误类型不稳定，不能作为判定依据。
      if (signal.aborted) {
        res.status(504).json({ error: `评审超时（${deps.timeoutMs}ms）` });
        return;
      }
      res.status(502).json({ error: error instanceof Error ? error.message : "评审调用失败" });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "未找到该路径" });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    // 请求体 JSON 解析失败与体积超限由 body-parser 以带 status 的错误抛出，沿用该状态码。
    res.status(readClientErrorStatus(error)).json({
      error: error instanceof Error ? error.message : "服务器内部错误",
    });
  });

  return app;
}

/** 读取 body-parser 给出的 4xx 状态码；其他情况一律按 500 处理。 */
function readClientErrorStatus(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 ? status : 500;
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
