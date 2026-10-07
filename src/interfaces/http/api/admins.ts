/**
 * 管理员账号管理路由。
 *
 * 删除约束（proposal P-004）：禁止删除当前登录账号，禁止删除最后一个管理员。
 * 自删优先判定——两个约束同时成立时，返回自删的错误更贴合用户意图。
 */
import { Router } from "express";
import type { AdminRepository } from "../../../domain/admin.ts";

/** 密码最小长度，与前端表单校验保持一致。 */
const MIN_PASSWORD_LENGTH = 8;

/** 管理员路由依赖。 */
export interface AdminsRouterDeps {
  admins: AdminRepository;
}

/** 创建管理员账号路由。 */
export function createAdminsRouter(deps: AdminsRouterDeps): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    // list() 的对外视图本身不含 password_hash，这里无需再裁剪字段。
    res.json(deps.admins.list());
  });

  router.post("/", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username) {
      res.status(400).json({ error: "用户名不能为空" });
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: `密码长度不能少于 ${MIN_PASSWORD_LENGTH} 位` });
      return;
    }
    try {
      const created = deps.admins.create(username, password);
      res.json(created);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 仓储抛出「已存在」表示用户名唯一约束冲突。
      res.status(/已存在/.test(message) ? 409 : 500).json({ error: message });
    }
  });

  router.delete("/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "账号 ID 非法" });
      return;
    }
    const current = String(res.locals.username ?? "");
    const target = deps.admins.list().find((admin) => admin.id === id);
    if (!target) {
      res.status(404).json({ error: "账号不存在" });
      return;
    }
    if (target.username === current) {
      res.status(400).json({ error: "不能删除当前登录的账号" });
      return;
    }
    if (deps.admins.count() <= 1) {
      res.status(400).json({ error: "不能删除最后一个管理员账号" });
      return;
    }
    deps.admins.delete(id);
    res.json({ ok: true });
  });

  return router;
}
