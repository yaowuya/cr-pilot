/**
 * 路由表与全局守卫。
 *
 * `/login` 是唯一白名单路由，其余路由都要求有效登录态。history 模式依赖后端
 * SPA fallback（见 `src/interfaces/http/static-assets.ts`）。
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from "vue-router";
import { ensureAuth } from "../stores/auth.ts";
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
      { path: "prompts", name: "prompts", component: () => import("../views/PromptsView.vue") },
      { path: "config", name: "config", component: () => import("../views/ConfigView.vue") },
      { path: "admins", name: "admins", component: () => import("../views/AdminsView.vue") },
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
  if (ok) return true;
  // 带上原目标，登录成功后回跳（见 LoginView）。
  return { path: "/login", query: { redirect: to.fullPath } };
});
