/**
 * 登录态：令牌与当前管理员。
 *
 * 用模块级单例而不是 Pinia：全局只有两个状态（令牌、用户名），引入状态管理库
 * 的成本大于收益。页面级数据由各页面自己持有。
 */
import { ref, type Ref } from "vue";
import { api, clearToken, getToken, setToken } from "../api/client.ts";

/** 当前管理员用户名；空串表示未登录。 */
const username: Ref<string> = ref("");
/** 是否已完成一次登录态校验，避免并发路由重复请求 /me。 */
let verified = false;
/** 进行中的校验 Promise，供并发调用复用。 */
let pending: Promise<boolean> | null = null;

/** 登录：成功后写入令牌与用户名。 */
export async function login(input: { username: string; password: string }): Promise<void> {
  const result = await api.post<{ token: string; username: string }>("/api/auth/login", input);
  setToken(result.token);
  username.value = result.username;
  verified = true;
  pending = null;
}

/**
 * 退出登录：清除本地令牌与内存状态。
 *
 * 后端令牌是无状态的（D-009），因此这里只需本地清除；接口调用失败也不影响退出。
 */
export async function logout(): Promise<void> {
  try {
    await api.post("/api/auth/logout");
  } catch {
    // 无状态令牌：服务端没有会话可撤销，失败无需阻断退出流程。
  }
  clearToken();
  username.value = "";
  verified = false;
  pending = null;
}

/**
 * 校验登录态。
 *
 * - 无令牌直接失败（不请求后端）；
 * - 已校验成功过则直接返回，避免每次路由跳转都发一次请求；
 * - 并发调用复用同一个 Promise，避免多路由同时进入时重复请求 `/me`。
 */
export function ensureAuth(): Promise<boolean> {
  if (verified && username.value) return Promise.resolve(true);
  if (!getToken()) return Promise.resolve(false);
  if (pending) return pending;
  pending = api
    .get<{ username: string }>("/api/auth/me")
    .then((result) => {
      username.value = result.username;
      verified = true;
      return true;
    })
    .catch(() => {
      // 401 已由 client 处理跳转；此处只需返回失败让守卫放行到登录页。
      clearToken();
      username.value = "";
      verified = false;
      return false;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** 已登录用户名（模板中直接用）。 */
export function currentUsername(): Ref<string> {
  return username;
}
