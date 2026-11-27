/**
 * 功能自检路由：把耗时的验证任务异步化，避免 HTTP 请求长时间挂起。
 *
 * 为什么必须异步：一次 AI 评审实测约 70 秒，同步返回会让浏览器、反向代理和后
 * 置连接全部长时间等待，稍有超时配置就整体失败。这里改成「提交即返回任务 ID，
 * 页面轮询结果」，把长耗时隔离在后台。
 *
 * 任务只存内存：验证是运维自检动作，进程重启后历史结果没有保留价值，
 * 落库反而增加清理负担。
 */
import { randomUUID } from "node:crypto";
import { Router, type RequestHandler } from "express";
import type { FeatureVerifier, VerifyTask } from "../../../application/feature-verifier.ts";
import type { OcrSelfTestOutcome } from "../../../application/ocr-self-test.ts";
import { isRepositoryProjectKey } from "../../../domain/review-prompt.ts";

/** 任务保留上限：超过后丢弃最旧的，防止长时间运行累积内存。 */
const MAX_TASKS = 20;

/** 任务保留时长（毫秒）：1 小时足够页面轮询，也不会长期占用内存。 */
const TASK_TTL_MS = 60 * 60 * 1000;

/** 验证路由依赖。 */
export interface VerifyRouterDeps {
  verifier: FeatureVerifier;
  /** OCR 使用配置好的模型，提交与轮询都由管理员操作。 */
  ocr?: { verify(project?: string): Promise<OcrSelfTestOutcome>; requireAdmin: RequestHandler };
}

type VerifyKind = VerifyTask["kind"] | "ocr";
type StoredTask = Omit<VerifyTask, "kind"> & { kind: VerifyKind; ocr?: OcrSelfTestOutcome["ocr"] };

/** OCR 自检只接受选择配置的项目路径，测试代码、模型地址及凭据均由服务端决定。 */
function readOcrProject(body: unknown): string | undefined | null {
  if (body === undefined) return undefined;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length === 0) return undefined;
  if (keys.length !== 1 || keys[0] !== "project") return null;
  const value = (body as Record<string, unknown>).project;
  const project = typeof value === "string" ? value.trim() : "";
  return project.includes("/") && isRepositoryProjectKey(project) ? project : null;
}

/**
 * 内存任务表。
 *
 * 每种类型单独限并发：避免重复消耗模型额度或短时间内向群里连发多条消息。
 */
function createTaskStore() {
  const tasks = new Map<string, StoredTask>();
  const runningKinds = new Set<VerifyKind>();

  /** 清理过期与被挤出上限的任务。 */
  const prune = (now: number): void => {
    for (const [id, task] of tasks) {
      if (task.finishedAt !== null && now - task.finishedAt > TASK_TTL_MS) tasks.delete(id);
    }
    // 按插入顺序丢弃已结束任务。保留运行中的任务以便轮询和释放同类型的并发占用。
    for (const [id, task] of tasks) {
      if (tasks.size <= MAX_TASKS) break;
      if (task.finishedAt !== null) tasks.delete(id);
    }
  };

  return {
    /** 当前是否有同类任务在跑。 */
    isRunning(kind: VerifyKind): boolean {
      return runningKinds.has(kind);
    },

    /** 新建任务并登记；调用方负责实际执行。 */
    create(kind: VerifyKind): StoredTask {
      const now = Date.now();
      const task: StoredTask = {
        id: randomUUID(),
        kind,
        status: "running",
        message: "正在执行…",
        detail: "",
        durationMs: 0,
        startedAt: now,
        finishedAt: null,
      };
      tasks.set(task.id, task);
      runningKinds.add(kind);
      prune(now);
      return task;
    },

    /** 写回最终结果并释放运行标记。 */
    finish(id: string, outcome: OcrSelfTestOutcome): void {
      const task = tasks.get(id);
      if (!task || task.finishedAt !== null) return;
      task.status = outcome.success ? "success" : "failed";
      task.message = outcome.message;
      task.detail = outcome.detail;
      task.durationMs = outcome.durationMs;
      task.finishedAt = Date.now();
      if (task.kind === "ocr" && outcome.ocr !== undefined) task.ocr = outcome.ocr;
      runningKinds.delete(task.kind);
    },

    get(id: string): StoredTask | undefined {
      prune(Date.now());
      return tasks.get(id);
    },
  };
}

/** 创建功能自检路由。 */
export function createVerifyRouter(deps: VerifyRouterDeps): Router {
  const router = Router();
  const store = createTaskStore();
  const { ocr } = deps;

  /**
   * 提交验证任务。
   *
   * 后台执行而不 await：请求立即返回任务 ID，页面据此轮询。
   * 执行体自身已捕获异常并返回结构化结果，这里再兜一层防止未处理 rejection。
   */
  const submit = (kind: VerifyKind, run: (taskId: string) => Promise<void>): { id: string } => {
    const task = store.create(kind);
    void run(task.id).catch((error: unknown) => {
      store.finish(task.id, {
        success: false,
        message: kind === "ocr" ? "OCR 验证执行异常" : `验证执行异常：${error instanceof Error ? error.message : String(error)}`,
        detail: "",
        durationMs: Date.now() - task.startedAt,
      });
    });
    return { id: task.id };
  };

  router.post("/ai", (_req, res) => {
    if (store.isRunning("ai")) {
      res.status(409).json({ error: "已有 AI 验证正在执行，请等待完成" });
      return;
    }
    const { id } = submit("ai", async (taskId) => {
      store.finish(taskId, await deps.verifier.verifyAi());
    });
    res.json({ taskId: id });
  });

  if (ocr) {
    router.post("/ocr", ocr.requireAdmin, (req, res) => {
      const project = readOcrProject(req.body);
      // Express 会跳过非 JSON 正文。请求确实有正文时，不能误用无项目的默认厂商。
      const bodySupplied = req.headers["transfer-encoding"] !== undefined || Number(req.headers["content-length"]) > 0;
      if (project === null || (req.body === undefined && bodySupplied)) {
        res.status(400).json({ error: "OCR 验证仅接受可选的完整项目路径 project" });
        return;
      }
      if (store.isRunning("ocr")) {
        res.status(409).json({ error: "已有 OCR 验证正在执行，请等待完成" });
        return;
      }
      const { id } = submit("ocr", async (taskId) => {
        store.finish(taskId, await ocr.verify(project));
      });
      res.json({ taskId: id });
    });
  }

  // 机器人列表：只返回脱敏 key 与关联仓库，原始 webhook 地址不下发浏览器。
  router.get("/wecom-bots", async (_req, res) => {
    try {
      res.json({ items: await deps.verifier.listWecomBots() });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/wecom", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const gitlabUsername = typeof body.gitlabUsername === "string" ? body.gitlabUsername.trim() : "";
    // 自检没有真实 MR 作者；必须显式选人，不能把无提及的消息当作 @ 功能验证成功。
    if (!gitlabUsername || !/^[a-zA-Z0-9_.-]+$/.test(gitlabUsername)) {
      res.status(400).json({ error: "请选择有效的测试提交人（GitLab 账号）" });
      return;
    }
    // 只接受已配置机器人的 id：前端拿不到原始地址，也不能让自检接口打任意 URL。
    const webhookId = typeof body.webhookId === "string" ? body.webhookId.trim() : "";
    if (!webhookId || !/^[0-9a-f]{12}$/.test(webhookId)) {
      res.status(400).json({ error: "请选择要测试的企微机器人" });
      return;
    }
    // 真实发群是不可撤销动作，必须由调用方显式确认；缺省只做预览。
    const confirmSend = body.confirmSend === true;
    if (store.isRunning("wecom")) {
      res.status(409).json({ error: "已有企微验证正在执行，请等待完成" });
      return;
    }
    const { id } = submit("wecom", async (taskId) => {
      store.finish(taskId, await deps.verifier.verifyWecom({ webhookId, dryRun: !confirmSend, gitlabUsername }));
    });
    res.json({ taskId: id });
  });

  router.get("/tasks/:id", (req, res, next) => {
    const task = store.get(String(req.params.id ?? ""));
    if (!task) {
      res.status(404).json({ error: "任务不存在或已过期" });
      return;
    }
    if (task.kind !== "ocr") {
      res.json(task);
      return;
    }
    // OCR 任务 ID 并非授权凭据，查询始终复用与提交相同的管理员门禁。
    if (!ocr) {
      res.status(404).json({ error: "任务不存在或已过期" });
      return;
    }
    res.locals.ocrTask = task;
    return ocr.requireAdmin(req, res, next);
  }, (_req, res) => {
    res.json(res.locals.ocrTask);
  });

  return router;
}
