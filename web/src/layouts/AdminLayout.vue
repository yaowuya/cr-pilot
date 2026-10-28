<template>
  <div class="app-shell" :class="{ 'is-collapsed': collapsed }">
    <div class="app-brand">
      <span class="app-brand__mark">CR</span>
      <transition name="fade"><span v-if="!collapsed" class="app-brand__title">cr-pilot</span></transition>
    </div>

    <header class="app-header">
      <div class="app-header__left">
        <button class="icon-button" :title="collapsed ? '展开菜单' : '收起菜单'" @click="onToggleCollapse">
          <el-icon><Fold v-if="!collapsed" /><Expand v-else /></el-icon>
        </button>
        <el-breadcrumb separator="/" class="app-breadcrumb">
          <el-breadcrumb-item v-for="crumb in breadcrumbs" :key="crumb">{{ crumb }}</el-breadcrumb-item>
        </el-breadcrumb>
      </div>
      <div class="app-header__right">
        <span class="app-header__status">内部评审控制台</span>
        <button class="icon-button" :title="theme === 'dark' ? '切换到亮色' : '切换到暗色'" @click="onToggleTheme">
          <el-icon><Sunny v-if="theme === 'dark'" /><Moon v-else /></el-icon>
        </button>
        <el-dropdown trigger="click" @command="onCommand">
          <span class="app-user">
            <span class="app-user__avatar">{{ avatarText }}</span>
            <span class="app-user__name">{{ usernameText }}</span>
            <el-icon class="app-user__caret"><ArrowDown /></el-icon>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="logout"><el-icon><SwitchButton /></el-icon>退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </header>

    <aside class="app-sidebar">
      <el-scrollbar class="app-sidebar__scroll">
        <el-menu :default-active="activeMenu" :collapse="collapsed" :collapse-transition="false" router class="app-menu">
          <el-menu-item-group v-for="group in visibleMenuGroups" :key="group.title">
            <template #title><span>{{ group.title }}</span></template>
            <el-menu-item v-for="item in group.items" :key="item.path" :index="item.path">
              <el-icon><component :is="item.icon" /></el-icon>
              <template #title>{{ item.title }}</template>
            </el-menu-item>
          </el-menu-item-group>
        </el-menu>
      </el-scrollbar>
      <p v-if="!collapsed" class="app-sidebar__note">评审、分析与配置使用同一套实时数据</p>
    </aside>

    <div class="app-main">
      <el-scrollbar class="app-content">
        <main class="app-content__sheet">
          <router-view v-slot="{ Component }">
            <transition name="fade-slide" mode="out-in"><component :is="Component" /></transition>
          </router-view>
        </main>
      </el-scrollbar>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Framed Sheet 管理外壳：侧栏与顶栏组成低饱和框架，业务页面位于单一白色工作表。
 * 折叠、主题、权限菜单、面包屑和退出行为保持原有契约。
 */
import { computed, onBeforeUnmount, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import {
  ArrowDown,
  ChatDotRound,
  Cpu,
  DataAnalysis,
  Document,
  EditPen,
  Expand,
  Fold,
  MagicStick,
  Moon,
  Setting,
  Sunny,
  SwitchButton,
  TrendCharts,
  User,
} from "@element-plus/icons-vue";
import { currentIsAdmin, currentUsername, logout } from "../stores/auth.ts";
import { theme, toggleTheme } from "../stores/theme.ts";

const route = useRoute();
const router = useRouter();
const username = currentUsername();
const usernameText = computed(() => username.value);
const isAdmin = currentIsAdmin();
const NARROW_BREAKPOINT = 768;
const isNarrow = ref(window.innerWidth <= NARROW_BREAKPOINT);
const userCollapsed = ref(false);

function syncViewport(): void { isNarrow.value = window.innerWidth <= NARROW_BREAKPOINT; }
window.addEventListener("resize", syncViewport);
onBeforeUnmount(() => window.removeEventListener("resize", syncViewport));

const collapsed = computed(() => isNarrow.value || userCollapsed.value);
function onToggleCollapse(): void { if (!isNarrow.value) userCollapsed.value = !userCollapsed.value; }

const menuGroups = [
  {
    title: "评审",
    items: [
      { path: "/reviews", title: "评审记录", icon: Document, adminOnly: false },
      { path: "/stats", title: "统计分析", icon: TrendCharts, adminOnly: false },
      { path: "/adoption", title: "采纳率", icon: DataAnalysis, adminOnly: false },
    ],
  },
  {
    title: "配置",
    items: [
      { path: "/prompts", title: "Prompt 管理", icon: EditPen, adminOnly: false },
      { path: "/providers", title: "AI 厂商", icon: Cpu, adminOnly: false },
      { path: "/config", title: "环境变量", icon: Setting, adminOnly: false },
    ],
  },
  {
    title: "运维",
    items: [
      { path: "/wecom-contacts", title: "企微映射", icon: ChatDotRound, adminOnly: false },
      { path: "/verify", title: "功能自检", icon: MagicStick, adminOnly: false },
      { path: "/admins", title: "管理员", icon: User, adminOnly: true },
    ],
  },
];
const allMenuItems = menuGroups.flatMap((group) => group.items);
const visibleMenuGroups = computed(() => menuGroups.map((group) => ({
  ...group,
  items: group.items.filter((item) => !item.adminOnly || isAdmin.value),
})).filter((group) => group.items.length > 0));
const activeMenu = computed(() => `/${route.path.split("/")[1] ?? ""}`);
const breadcrumbs = computed(() => {
  const current = allMenuItems.find((item) => item.path === activeMenu.value);
  return current ? ["控制台", current.title] : ["控制台"];
});
const avatarText = computed(() => (usernameText.value ? usernameText.value.charAt(0).toUpperCase() : "?"));
function onToggleTheme(): void { toggleTheme(); }
async function onCommand(command: string): Promise<void> {
  if (command !== "logout") return;
  await logout();
  ElMessage.success("已退出登录");
  await router.push("/login");
}
</script>

<style scoped>
.app-shell {
  display: grid;
  grid-template-columns: var(--app-sidebar-width) minmax(0, 1fr);
  grid-template-rows: var(--app-logo-height) minmax(0, 1fr);
  height: 100vh;
  overflow: hidden;
  background: var(--app-content-bg);
}
.app-brand {
  grid-area: 1 / 1;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 22px;
  white-space: nowrap;
  overflow: hidden;
}
.app-brand__mark {
  display: grid;
  flex: 0 0 24px;
  place-items: center;
  width: 24px;
  height: 24px;
  font-size: 10px;
  font-weight: 700;
  border: 2px solid var(--el-text-color-primary);
  border-radius: 7px;
}
.app-brand__title { font-size: 16px; font-weight: 700; }
.app-header {
  grid-area: 1 / 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  padding: 0 20px 0 28px;
  background: var(--app-header-bg);
  color: var(--app-header-text);
}
.app-header__left,.app-header__right,.app-user { display: flex; align-items: center; }
.app-header__left { gap: 12px; min-width: 0; }
.app-header__right { gap: 12px; }
.app-header__status { font-size: 12px; color: var(--el-text-color-secondary); }
.icon-button {
  display: inline-grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--app-header-text);
  cursor: pointer;
}
.icon-button:hover { background: var(--app-header-hover); color: var(--el-text-color-primary); }
.app-breadcrumb { font-size: 12px; }
.app-user { gap: 8px; cursor: pointer; outline: none; }
.app-user__avatar {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--app-sidebar-active-bg);
  color: var(--el-text-color-primary);
  font-weight: 700;
}
.app-user__name { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.app-user__caret { font-size: 12px; }
.app-sidebar {
  grid-area: 2 / 1;
  display: flex;
  min-height: 0;
  flex-direction: column;
  padding: 8px 12px 16px;
  background: var(--app-sidebar-bg);
  overflow: hidden;
}
.app-sidebar__scroll { flex: 1; min-height: 0; }
.app-menu { border-right: 0; background: transparent; }
.app-menu :deep(.el-menu-item-group__title) {
  height: auto;
  padding: 14px 12px 6px !important;
  color: var(--el-text-color-secondary);
  font-size: 11px;
  line-height: 1.2;
}
.app-menu :deep(.el-menu-item) {
  height: 38px;
  margin: 3px 0;
  padding: 0 12px !important;
  border-radius: 8px;
  color: var(--app-sidebar-text);
}
.app-menu :deep(.el-menu-item:hover) { background: var(--app-header-hover); }
.app-menu :deep(.el-menu-item.is-active) { background: var(--app-sidebar-active-bg); color: var(--app-sidebar-text-active); font-weight: 600; }
.app-menu :deep(.el-icon) { font-size: 17px; }
.app-sidebar__note { margin: auto 12px 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.5; }
.app-main { grid-area: 2 / 2; min-width: 0; min-height: 0; padding: 0 8px 8px 0; }
.app-content { height: 100%; }
.app-content__sheet {
  min-height: calc(100vh - var(--app-logo-height) - 8px);
  padding: var(--app-content-padding);
  background: var(--el-bg-color);
  border: 1px solid var(--app-border-color);
  border-radius: 16px;
}
.is-collapsed { grid-template-columns: var(--app-sidebar-collapsed-width) minmax(0, 1fr); }
.is-collapsed .app-brand { justify-content: center; padding: 0; }
.is-collapsed .app-sidebar { padding-inline: 8px; }
.is-collapsed .app-menu :deep(.el-menu-item-group__title) { display: none; }
.is-collapsed .app-menu :deep(.el-menu-item) { justify-content: center; padding: 0 !important; }
.fade-enter-active,.fade-leave-active,.fade-slide-enter-active,.fade-slide-leave-active { transition: opacity .15s ease, transform .15s ease; }
.fade-enter-from,.fade-leave-to { opacity: 0; }
.fade-slide-enter-from { opacity: 0; transform: translateY(5px); }
.fade-slide-leave-to { opacity: 0; transform: translateY(-3px); }
@media (max-width: 768px) {
  .app-header__status,.app-user__name,.app-user__caret,.app-breadcrumb { display: none; }
  .app-content__sheet { min-width: 680px; }
}
</style>
