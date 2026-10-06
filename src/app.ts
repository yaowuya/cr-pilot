import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { Logger } from "./logger.ts";
import type { MergeRequestTask } from "./pipeline.ts";

/**
 * webhook 入队动作：把解析出的 MR 任务安排进后台队列。
 * 由 `server.ts` 注入（内部绑定 queue 与 pipeline），让路由不依赖具体实现。
 */
export type WebhookEnqueue = (task: MergeRequestTask) => void;

/** 应用依赖。全部显式注入，接口层测试无需触碰真实模型与 GitLab。 */
export interface AppDeps {
  /** webhook 来源校验 secret，与 GitLab 配置的 Secret Token 一致。 */
  webhookSecret: string;
  /** 日志记录器。 */
  logger: Logger;
  /** 把 MR 任务转成后台队列任务的入口。 */
  enqueue: WebhookEnqueue;
}

/**
 * 创建 Express 应用。不含监听逻辑，便于测试用随机端口启动。
 *
 * 本路由只做两件事：校验来源、分派事件并立即响应。拉取、评审、汇总、回写
 * 全部在后台队列中完成。日志不记录 payload 正文，只记录事件类型与 MR 标识。
 */
export function createApp(deps: AppDeps): Express {
  const { logger } = deps;
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.post("/review/webhook", (req, res) => {
    const receivedAt = Date.now();
    const token = req.headers["x-gitlab-token"];
    if (typeof token !== "string" || token !== deps.webhookSecret) {
      logger.warn("webhook 来源校验失败", { status: 401 });
      res.status(401).json({ error: "webhook 来源校验失败" });
      return;
    }

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

    const task = parseMergeRequestTask(payload);
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

/**
 * 从 GitLab merge_request payload 提取任务字段。
 * `project_id` 优先取顶层，缺失回退 `project.id`；任一关键字段缺失返回 null。
 */
function parseMergeRequestTask(payload: Record<string, unknown>): MergeRequestTask | null {
  const project = isRecord(payload.project) ? payload.project : {};
  const attributes = isRecord(payload.object_attributes) ? payload.object_attributes : {};

  const projectId = readNumber(payload.project_id) ?? readNumber(project.id);
  const iid = readNumber(attributes.iid);
  const fullName = readString(project, "path_with_namespace");
  if (projectId === undefined || iid === undefined || !fullName) return null;

  return {
    projectId,
    iid,
    fullName,
    sourceBranch: readString(attributes, "source_branch"),
    targetBranch: readString(attributes, "target_branch"),
  };
}

/** 判定非 null、非数组的对象，用于安全读取未知 JSON 结构。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读取数字字段；非数字按缺失处理。 */
function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 读取字符串字段并去空白；非字符串一律按缺失处理。 */
function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

/** 读取 body-parser 给出的 4xx 状态码；其他情况一律按 500 处理。 */
function readClientErrorStatus(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 ? status : 500;
}
