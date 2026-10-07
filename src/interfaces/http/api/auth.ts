/**
 * 认证路由：登录、登出、当前管理员。
 *
 * 登录是唯一免鉴权的 `/api` 入口。登录失败一律返回相同的 401 响应体，
 * 不区分「用户不存在」与「密码错误」——否则可被用来枚举有效用户名。
 */
import { Router, type RequestHandler } from "express";
import type { AdminRepository } from "../../../domain/admin.ts";
import { deriveToken } from "../../../shared/crypto.ts";

/** 认证路由依赖。 */
export interface AuthRouterDeps {
  admins: AdminRepository;
  authSalt: string;
  /**
   * 鉴权中间件，只作用于 `GET /me`。
   *
   * login 必须免鉴权（否则无法换取令牌），而 me 是前端启动时校验本地令牌的入口，
   * 必须要求有效令牌——否则它永远返回空用户名，前端的登录态检查形同虚设。
   */
  authMiddleware?: RequestHandler;
}

/** 登录失败时的统一响应体（两种失败必须字节级一致）。 */
const LOGIN_FAILED = { error: "用户名或密码错误" };

/**
 * 创建认证路由。
 *
 * `logout` 无服务端状态（D-009 无状态令牌）：接口只为语义完整，实际清除在前端。
 * 因此它不撤销令牌——改密码或重启进程才会让旧令牌失效。
 */
export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();

  router.post("/login", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) {
      res.status(400).json({ error: "用户名与密码不能为空" });
      return;
    }
    const admin = deps.admins.authenticate(username, password);
    if (!admin) {
      res.status(401).json(LOGIN_FAILED);
      return;
    }
    res.json({ token: deriveToken(admin.username, deps.authSalt), username: admin.username });
  });

  router.post("/logout", (_req, res) => {
    res.json({ ok: true });
  });

  // me 要求有效令牌：它是前端判断本地令牌是否仍可用的唯一依据。
  const meGuards = deps.authMiddleware ? [deps.authMiddleware] : [];
  router.get("/me", ...meGuards, (_req, res) => {
    res.json({ username: String(res.locals.username ?? "") });
  });

  return router;
}
