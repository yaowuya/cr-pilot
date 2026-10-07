/**
 * Bearer 令牌鉴权中间件。
 *
 * 适用于全部 `/api/*`（登录除外）。令牌校验方式见下：逐个比对库中账号的派生
 * 令牌，不查会话表。
 */
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { AdminRepository } from "../../domain/admin.ts";
import { deriveToken } from "../../shared/crypto.ts";

/** 鉴权依赖：管理员仓储与部署盐。 */
export interface AuthMiddlewareDeps {
  admins: AdminRepository;
  authSalt: string;
}

/** 从 `Authorization: Bearer <token>` 头提取令牌；格式不符返回空串。 */
function readBearerToken(header: string | undefined): string {
  if (!header) return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

/** 定长比较两个 hex 令牌；长度不同直接判否（不比较内容）。 */
function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 创建 Bearer 令牌鉴权中间件。
 *
 * 无状态令牌（D-009）：账号数量为个位数到几十，逐个派生比对的开销可忽略，
 * 换来的是不引入会话表与吊销逻辑。令牌无效统一返回 401，由前端跳登录页。
 *
 * 认证通过的账号名写入 `res.locals.username` 而不是扩展 `req` 类型，
 * 避免为局部需求修改全局 Express 类型声明。
 */
export function createAuthMiddleware(deps: AuthMiddlewareDeps): RequestHandler {
  return (req, res, next) => {
    const token = readBearerToken(req.headers.authorization);
    if (!token) {
      res.status(401).json({ error: "缺少访问令牌" });
      return;
    }
    const matched = deps.admins
      .list()
      .find((admin) => tokensEqual(deriveToken(admin.username, deps.authSalt), token));
    if (!matched) {
      res.status(401).json({ error: "访问令牌无效" });
      return;
    }
    res.locals.username = matched.username;
    next();
  };
}
