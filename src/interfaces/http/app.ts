import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Logger } from "../../shared/logger.ts";
import type { MergeRequestTask } from "../../domain/review-task.ts";
import { parseMergeRequestTask } from "./webhook-parser.ts";

/**
 * webhook 入队动作：把解析出的 MR 任务安排进后台队列。
 * 由组合根（bootstrap）注入（内部绑定 queue 与 pipeline），让路由不依赖具体实现。
 */
export type WebhookEnqueue = (task: MergeRequestTask) => void;

/** 应用依赖。全部显式注入，接口层测试无需触碰真实模型与 GitLab。 */
export interface AppDeps {
  /** 日志记录器。 */
  logger: Logger;
  /** 把 MR 任务转成后台队列任务的入口。 */
  enqueue: WebhookEnqueue;
}

/**
 * 创建 Express 应用（HTTP 表现层）。不含监听逻辑，便于测试用随机端口启动。
 *
 * 本路由只做一件事：按事件类型分派并立即响应。拉取、评审、汇总、回写全部在
 * 后台队列中完成。日志不记录 payload 正文，只记录事件类型与 MR 标识。
 *
 * 来源校验（内网隔离、网关白名单等）由部署层负责：一个 GitLab 实例可以有多个
 * 项目，每个项目在 GitLab 侧配置的 Secret token 各不相同，单实例无法用一份全局
 * secret 校验所有来源，因此本路由不做 `X-Gitlab-Token` 比对。
 */
export function createApp(deps: AppDeps): Express {
  const { logger } = deps;
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.post("/review/webhook", (req, res) => {
    const receivedAt = Date.now();
    const body: unknown = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      logger.warn("webhook payload 不是对象", { status: 400 });
      res.status(400).json({ error: "请求体必须是 JSON 对象" });
      return;
    }
    const payload = body as Record<string, unknown>;

    if (payload.object_kind !== "merge_request") {
      logger.warn("不支持的事件类型", { status: 400, objectKind: String(payload.object_kind ?? "") });
      res.status(400).json({ error: `仅支持 merge_request 事件，收到：${String(payload.object_kind ?? "无")}` });
      return;
    }

    const instanceHeader = req.headers["x-gitlab-instance"];
    const task = parseMergeRequestTask(payload, typeof instanceHeader === "string" ? instanceHeader : undefined);
    if (!task) {
      logger.warn("merge_request payload 缺少关键字段", { status: 400 });
      res.status(400).json({ error: "merge_request payload 缺少 project 或 object_attributes 信息" });
      return;
    }

    deps.enqueue(task);
    logger.info("MR 任务已入队", {
      projectId: task.projectId,
      iid: task.iid,
      fullName: task.fullName,
      totalMs: Date.now() - receivedAt,
    });
    res.json({ message: `merge_request !${task.iid} 已进入评审队列` });
  });

  app.use((req, res) => {
    logger.debug("未命中任何路由", { method: req.method, path: req.path });
    res.status(404).json({ error: "未找到该路径" });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    // 请求体 JSON 解析失败与体积超限由 body-parser 以带 status 的错误抛出，沿用该状态码。
    const status = readClientErrorStatus(error);
    const message = error instanceof Error ? error.message : "服务器内部错误";
    logger.error("请求处理异常", { status, message });
    res.status(status).json({ error: message });
  });

  return app;
}

/** 读取 body-parser 给出的 4xx 状态码；其他情况一律按 500 处理。 */
function readClientErrorStatus(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 ? status : 500;
}
