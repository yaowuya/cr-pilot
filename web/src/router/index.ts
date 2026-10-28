/**
 * 路由表与全局守卫。
 *
 * `/login` 是唯一白名单路由，其余路由都要求有效登录态。history 模式依赖后端
 * SPA fallback（见 `src/interfaces/http/static-assets.ts`）。
 *
 * 权限（D-024）：`meta.requiresAdmin` 标记管理员专属路由。普通账号直接输入
 * URL 会被弹回评审记录页——但这只是体验层，真正的门在后端 `/api/admins` 的
 * 403 校验上。
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { ensureAuth, currentIsAdmin } from "../stores/auth.ts";
import AdminLayout from "../layouts/AdminLayout.vue";

const routes: RouteRecordRaw[] = [
  {
    path: "/login",
    name: "login",
    // 登录页单独引入，不经过 AdminLayout（未登录时不应渲染侧边菜单）。
    component: () => import("../views/LoginView.vue"),
    meta: { public: true },
  },
  {
    path: "/",
    component: AdminLayout,
    redirect: "/reviews",
    children: [
      { path: "reviews", name: "reviews", component: () => import("../views/ReviewsView.vue") },
      { path: "stats", name: "stats", component: () => import("../views/StatsView.vue") },
      { path: "adoption", name: "adoption", component: () => import("../views/AdoptionView.vue") },
      { path: "prompts", name: "prompts", component: () => import("../views/PromptsView.vue") },
      { path: "providers", name: "providers", component: () => import("../views/ProvidersView.vue") },
      { path: "config", name: "config", component: () => import("../views/ConfigView.vue") },
      { path: "wecom-contacts", name: "wecom-contacts", component: () => import("../views/WecomContactsView.vue") },
      { path: "verify", name: "verify", component: () => import("../views/VerifyView.vue") },
      {
        path: "admins",
        name: "admins",
        component: () => import("../views/AdminsView.vue"),
        meta: { requiresAdmin: true },
      },
    ],
  },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  const ok = await ensureAuth();
  if (!ok) {
    // 带上原目标，登录成功后回跳（见 LoginView）。
    return { path: "/login", query: { redirect: to.fullPath } };
  }
  // 权限不足时回到默认首页，不显示 403 页面：管理后台里「没这个页面」
  // 比「你被拒绝了」更贴合普通账号的心智，也避免暴露权限模型细节。
  if (to.meta.requiresAdmin && !currentIsAdmin().value) {
    return { path: "/reviews" };
  }
  return true;
});
