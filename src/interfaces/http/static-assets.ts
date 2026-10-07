/**
 * 前端构建产物的静态托管与 SPA fallback。
 *
 * 前端用 history 模式路由，因此任意未匹配的前端路径都要回落到 `index.html`。
 * 但 `/api` 与 `/review` 必须排除：否则未匹配的管理 API 会返回 HTML，
 * 前端按 JSON 解析时拿到一堆标签，错误信息完全丢失。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type RequestHandler } from "express";
import type { Logger } from "../../shared/logger.ts";

/** 不参与 SPA fallback 的路径前缀（后端自有路由）。 */
const BACKEND_PREFIXES = ["/api", "/review"];

/** 静态托管依赖。 */
export interface StaticAssetsDeps {
  /** 前端构建产物目录（`web/dist`）。 */
  distDir: string;
  logger: Logger;
}

/**
 * 创建静态资源中间件数组（顺序敏感，需挂在业务路由之后、404 处理之前）。
 *
 * 产物目录不存在时返回空数组而不是抛错：本地开发常常只跑后端，
 * 未构建前端时服务仍应正常提供 API 与 webhook。
 */
export function createStaticAssets(deps: StaticAssetsDeps): RequestHandler[] {
  const indexFile = join(deps.distDir, "index.html");
  if (!existsSync(indexFile)) {
    deps.logger.info("未找到前端构建产物，跳过静态资源托管", { 目录: deps.distDir });
    return [];
  }

  const fallback: RequestHandler = (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }
    if (BACKEND_PREFIXES.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`))) {
      // 交给后面的 404 处理，保证未匹配 API 返回 JSON。
      next();
      return;
    }
    res.sendFile(indexFile);
  };

  return [express.static(deps.distDir, { index: false }), fallback];
}
