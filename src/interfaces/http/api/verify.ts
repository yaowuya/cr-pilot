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
import { Router } from "express";
import type { FeatureVerifier } from "../../../application/feature-verifier.ts";
import type { VerifyTask } from "../../../application/feature-verifier.ts";

/** 任务保留上限：超过后丢弃最旧的，防止长时间运行累积内存。 */
const MAX_TASKS = 20;

/** 任务保留时长（毫秒）：1 小时足够页面轮询，也不会长期占用内存。 */
const TASK_TTL_MS = 60 * 60 * 1000;

/** 验证路由依赖。 */
export interface VerifyRouterDeps {
  verifier: FeatureVerifier;
}

/**
 * 内存任务表。
 *
 * 只允许同一时刻运行一个 AI 验证：并发触发会各消耗一次模型额度，
 * 且结果互相干扰。企微验证同样串行，避免短时间内往群里连发多条。
 */
function createTaskStore() {
  const tasks = new Map<string, VerifyTask>();
  let runningKind: "ai" | "wecom" | null = null;

  /** 清理过期与被挤出上限的任务。 */
  const prune = (now: number): void => {
    for (const [id, task] of tasks) {
      if (task.finishedAt !== null && now - task.finishedAt > TASK_TTL_MS) tasks.delete(id);
    }
    while (tasks.size > MAX_TASKS) {
      // Map 保持插入顺序，第一个就是最旧的。
      const oldest = tasks.keys().next().value;
      if (oldest === undefined) break;
      tasks.delete(oldest);
    }
  };

  return {
    /** 当前是否有同类任务在跑。 */
    isRunning(kind: "ai" | "wecom"): boolean {
      return runningKind === kind;
    },

    /** 新建任务并登记；调用方负责实际执行。 */
    create(kind: "ai" | "wecom"): VerifyTask {
      prune(Date.now());
      const task: VerifyTask = {
        id: randomUUID(),
        kind,
        status: "running",
        message: "正在执行…",
        detail: "",
        durationMs: 0,
        startedAt: Date.now(),
        finishedAt: null,
      };
      tasks.set(task.id, task);
      runningKind = kind;
      return task;
    },

    /** 写回最终结果并释放运行标记。 */
    finish(id: string, outcome: { success: boolean; message: string; detail: string; durationMs: number }): void {
      const task = tasks.get(id);
      if (!task) {
        runningKind = null;
        return;
      }
      task.status = outcome.success ? "success" : "failed";
      task.message = outcome.message;
      task.detail = outcome.detail;
      task.durationMs = outcome.durationMs;
      task.finishedAt = Date.now();
      runningKind = null;
    },

    get(id: string): VerifyTask | undefined {
      return tasks.get(id);
    },
  };
}

/** 创建功能自检路由。 */
export function createVerifyRouter(deps: VerifyRouterDeps): Router {
  const router = Router();
  const store = createTaskStore();

  /**
   * 提交验证任务。
   *
   * 后台执行而不 await：请求立即返回任务 ID，页面据此轮询。
   * 执行体自身已捕获异常并返回结构化结果，这里再兜一层防止未处理 rejection。
   */
  const submit = (kind: "ai" | "wecom", run: (taskId: string) => Promise<void>): { id: string } => {
    const task = store.create(kind);
    void run(task.id).catch((error: unknown) => {
      store.finish(task.id, {
        success: false,
        message: `验证执行异常：${error instanceof Error ? error.message : String(error)}`,
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

  router.get("/tasks/:id", (req, res) => {
    const task = store.get(String(req.params.id ?? ""));
    if (!task) {
      res.status(404).json({ error: "任务不存在或已过期" });
      return;
    }
    res.json(task);
  });

  return router;
}
