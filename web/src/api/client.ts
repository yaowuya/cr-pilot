/**
 * 统一 fetch 封装：附加 Bearer 令牌、解析 JSON、401 跳登录。
 *
 * 所有页面只通过本模块访问后端，避免每处各自处理令牌与错误形态。
 */

/** 令牌在 localStorage 中的键名。 */
const TOKEN_KEY = "crp_token";

/** 请求错误：携带 HTTP 状态码，便于调用方区分 401/409 等。 */
export interface ApiError {
  status: number;
  message: string;
}

/**
 * 防重复跳转标志。
 *
 * 页面通常并发发起多个请求，同时 401 时若各自跳转会产生多次导航与控制台告警。
 * 跳转后由路由守卫在登录页重置该标志。
 */
let redirecting = false;

/** 重置跳转标志（登录页挂载时调用）。 */
export function resetRedirectFlag(): void {
  redirecting = false;
}

/** 读取本地令牌；不存在返回空串。 */
export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

/** 写入本地令牌。 */
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/** 清除本地令牌。 */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

/** 把查询参数拼成 query string；值为 undefined/空串的项跳过。 */
function buildQuery(params?: Record<string, unknown>): string {
  if (!params) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/** 判定是否为 ApiError（避免用 instanceof 跨模块失效）。 */
export function isApiError(error: unknown): error is ApiError {
  return typeof error === "object" && error !== null && "status" in error && "message" in error;
}

/**
 * 发起请求。
 *
 * - 有令牌时附加 `Authorization: Bearer`；
 * - 401 时清除令牌并跳转登录页（带 `redirect` 参数以便登录后回跳），且只跳一次；
 * - 非 2xx 时抛出 `ApiError`，`message` 取后端 `error` 字段；
 * - 网络层失败时抛出 `status: 0` 与「服务不可用」，让页面能区分「后端拒绝」与
 *   「连不上后端」。
 */
export async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; params?: Record<string, unknown> } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(`${path}${buildQuery(options.params)}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw { status: 0, message: "服务不可用" } satisfies ApiError;
  }

  if (response.status === 401) {
    clearToken();
    if (!redirecting) {
      redirecting = true;
      const target = `${location.pathname}${location.search}`;
      location.assign(`/login?redirect=${encodeURIComponent(target)}`);
    }
    throw { status: 401, message: "登录已失效，请重新登录" } satisfies ApiError;
  }

  const text = await response.text();
  const body: unknown = text ? safeParse(text) : {};
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
        ? String((body as { error: string }).error)
        : `请求失败（HTTP ${response.status}）`;
    throw { status: response.status, message } satisfies ApiError;
  }
  return body as T;
}

/** 解析 JSON；失败时返回空对象，让调用方按未知结构处理。 */
function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 便捷方法。 */
export const api = {
  get: <T>(path: string, params?: Record<string, unknown>) => request<T>(path, { params }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
