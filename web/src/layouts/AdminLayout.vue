<template>
  <div class="app-shell" :class="{ 'is-collapsed': collapsed }">
    <!-- 侧边栏：品牌 + 菜单。折叠时只留图标，宽度由 CSS 变量控制 -->
    <aside class="app-sidebar">
      <div class="app-sidebar__logo">
        <span class="app-sidebar__mark">CR</span>
        <transition name="fade">
          <span v-if="!collapsed" class="app-sidebar__title">cr-pilot</span>
        </transition>
      </div>

      <el-scrollbar class="app-sidebar__scroll">
        <el-menu
          :default-active="activeMenu"
          :collapse="collapsed"
          :collapse-transition="false"
          router
          class="app-menu"
        >
          <el-menu-item v-for="item in menuItems" :key="item.path" :index="item.path">
            <el-icon><component :is="item.icon" /></el-icon>
            <template #title>{{ item.title }}</template>
          </el-menu-item>
        </el-menu>
      </el-scrollbar>
    </aside>

    <!-- 主区：顶栏 + 内容 -->
    <div class="app-main">
      <header class="app-header">
        <div class="app-header__left">
          <button class="icon-button" :title="collapsed ? '展开菜单' : '收起菜单'" @click="onToggleCollapse">
            <el-icon><Fold v-if="!collapsed" /><Expand v-else /></el-icon>
          </button>
          <el-breadcrumb separator="/" class="app-breadcrumb">
            <el-breadcrumb-item v-for="(crumb, i) in breadcrumbs" :key="i">{{ crumb }}</el-breadcrumb-item>
          </el-breadcrumb>
        </div>

        <div class="app-header__right">
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
                <el-dropdown-item command="logout">
                  <el-icon><SwitchButton /></el-icon>
                  退出登录
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <el-scrollbar class="app-content">
        <main class="app-content__inner">
          <router-view v-slot="{ Component }">
            <transition name="fade-slide" mode="out-in">
              <component :is="Component" />
            </transition>
          </router-view>
        </main>
      </el-scrollbar>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 后台骨架：可折叠侧边栏 + 顶栏 + 滚动内容区。
 *
 * 布局用 flex 而非 el-container：el-container 的 aside 宽度只能写死，
 * 折叠动画需要 CSS 变量过渡，flex 下更直接。
 *
 * 折叠状态只存内存不持久化——刷新后恢复展开更符合管理后台的使用习惯
 * （折叠通常是为临时腾出横向空间）。
 */
import { computed, onBeforeUnmount, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import {
  ArrowDown,
  Document,
  EditPen,
  Expand,
  Fold,
  Moon,
  Setting,
  Sunny,
  SwitchButton,
  User,
} from "@element-plus/icons-vue";
import { currentUsername, logout } from "../stores/auth.ts";
import { theme, toggleTheme } from "../stores/theme.ts";

const route = useRoute();
const router = useRouter();
// currentUsername() 返回 Ref<string>，模板里可直接解包，脚本里必须取 .value
const username = currentUsername();
const usernameText = computed(() => username.value);

/**
 * 侧边栏折叠状态。
 *
 * 窄屏（<768px）强制折叠：此时展开的侧边栏会把主区压到无法阅读，
 * 折叠是唯一合理状态。宽屏下由用户点击顶栏按钮控制，且不持久化——
 * 折叠通常是为临时腾出横向空间，刷新后恢复展开更符合使用习惯。
 */
const NARROW_BREAKPOINT = 768;
const isNarrow = ref(window.innerWidth <= NARROW_BREAKPOINT);
const userCollapsed = ref(false);

function syncViewport(): void {
  isNarrow.value = window.innerWidth <= NARROW_BREAKPOINT;
}

window.addEventListener("resize", syncViewport);
onBeforeUnmount(() => window.removeEventListener("resize", syncViewport));

/** 实际折叠状态：窄屏恒折叠，否则跟随用户选择。 */
const collapsed = computed(() => isNarrow.value || userCollapsed.value);

/** 顶栏按钮：窄屏下不响应（状态由视口决定），宽屏切换用户选择。 */
function onToggleCollapse(): void {
  if (isNarrow.value) return;
  userCollapsed.value = !userCollapsed.value;
}

/** 菜单定义：path 与路由一一对应，title 同时用于面包屑。 */
const menuItems = [
  { path: "/reviews", title: "评审记录", icon: Document },
  { path: "/prompts", title: "Prompt 管理", icon: EditPen },
  { path: "/config", title: "环境变量", icon: Setting },
  { path: "/admins", title: "管理员", icon: User },
];

/** 当前激活菜单：取一级路径，避免未来加子路由时菜单失焦。 */
const activeMenu = computed(() => `/${route.path.split("/")[1] ?? ""}`);

/** 面包屑：固定「控制台」+ 当前页名。 */
const breadcrumbs = computed(() => {
  const current = menuItems.find((item) => item.path === activeMenu.value);
  return current ? ["控制台", current.title] : ["控制台"];
});

/** 头像文字：取用户名首字符，中文名同样适用。 */
const avatarText = computed(() => (usernameText.value ? usernameText.value.charAt(0).toUpperCase() : "?"));

function onToggleTheme(): void {
  toggleTheme();
}

async function onCommand(command: string): Promise<void> {
  if (command !== "logout") return;
  await logout();
  ElMessage.success("已退出登录");
  await router.push("/login");
}
</script>

<style scoped>
.app-shell {
  display: flex;
  height: 100vh;
  overflow: hidden;
  background-color: var(--app-content-bg);
}

/* ---------- 侧边栏 ---------- */
.app-sidebar {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  width: var(--app-sidebar-width);
  background-color: var(--app-sidebar-bg);
  border-right: 1px solid var(--app-border-color);
  transition: width var(--app-transition) ease;
}

.is-collapsed .app-sidebar {
  width: var(--app-sidebar-collapsed-width);
}

.app-sidebar__logo {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--app-logo-height);
  padding: 0 16px;
  overflow: hidden;
  border-bottom: 1px solid var(--app-border-color);
  white-space: nowrap;
}

/* 品牌方块：用主色渐变做一个无图片的 logo，避免额外资源请求 */
.app-sidebar__mark {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  font-size: 13px;
  font-weight: 700;
  color: #fff;
  letter-spacing: 0.5px;
  background: linear-gradient(135deg, var(--el-color-primary) 0%, var(--el-color-primary-light-3) 100%);
  border-radius: 9px;
}

.app-sidebar__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.app-sidebar__scroll {
  flex: 1;
  min-height: 0;
}

/* 菜单：去掉 Element Plus 默认的右边框与整块高亮，改为圆角胶囊 */
.app-menu {
  padding: 10px;
  border-right: none;
  background-color: transparent;
}

.app-menu :deep(.el-menu-item) {
  height: 42px;
  margin-bottom: 4px;
  font-size: 14px;
  color: var(--app-sidebar-text);
  border-radius: 8px;
  transition: background-color var(--app-transition) ease, color var(--app-transition) ease;
}

.app-menu :deep(.el-menu-item:hover) {
  color: var(--el-text-color-primary);
  background-color: var(--app-header-hover);
}

.app-menu :deep(.el-menu-item.is-active) {
  font-weight: 500;
  color: var(--app-sidebar-text-active);
  background-color: var(--app-sidebar-active-bg);
}

/* 折叠时图标居中，去掉 Element Plus 默认的 padding 偏移 */
.app-menu.el-menu--collapse :deep(.el-menu-item) {
  justify-content: center;
  padding: 0 !important;
}

/* ---------- 主区 ---------- */
.app-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.app-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  height: var(--app-logo-height);
  padding: 0 16px;
  background-color: var(--app-header-bg);
  border-bottom: 1px solid var(--app-border-color);
}

.app-header__left,
.app-header__right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.app-breadcrumb {
  margin-left: 4px;
  font-size: 13px;
}

/* 顶栏图标按钮：无边框方块，hover 才显底色 */
.icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  font-size: 17px;
  color: var(--app-header-text);
  cursor: pointer;
  background: transparent;
  border: none;
  border-radius: 8px;
  transition: background-color var(--app-transition) ease, color var(--app-transition) ease;
}

.icon-button:hover {
  color: var(--el-text-color-primary);
  background-color: var(--app-header-hover);
}

.app-user {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 8px 0 4px;
  color: var(--app-header-text);
  cursor: pointer;
  border-radius: 8px;
  transition: background-color var(--app-transition) ease;
}

.app-user:hover {
  background-color: var(--app-header-hover);
}

.app-user__avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: linear-gradient(135deg, var(--el-color-primary) 0%, var(--el-color-primary-light-3) 100%);
  border-radius: 50%;
}

.app-user__name {
  max-width: 120px;
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.app-user__caret {
  font-size: 12px;
}

/* ---------- 内容区 ---------- */
.app-content {
  flex: 1;
  min-height: 0;
}

.app-content__inner {
  padding: var(--app-content-padding);
}

/* ---------- 过渡动画 ---------- */
.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--app-transition) ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* 页面切换：轻微上移 + 淡入，比纯淡入更有层次 */
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.fade-slide-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.fade-slide-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* 窄屏：侧边栏强制收起为图标条，避免内容被挤成一条。
   这里同时覆盖「用户手动展开」的状态——小屏展开侧边栏会把主区压没，
   因此用 !important 压过 is-collapsed 的反向规则。 */
@media (max-width: 768px) {
  .app-sidebar {
    width: var(--app-sidebar-collapsed-width) !important;
  }

  .app-sidebar__logo {
    justify-content: center;
    padding: 0;
  }

  .app-sidebar__title,
  .app-user__name {
    display: none;
  }

  /* 菜单项在窄屏只显示图标：文字节点必须一起隐藏，否则会溢出到主区上 */
  .app-menu :deep(.el-menu-item) {
    justify-content: center;
    padding: 0 !important;
  }

  .app-menu :deep(.el-menu-item span) {
    display: none;
  }

  .app-breadcrumb {
    display: none;
  }

  .app-content__inner {
    padding: 16px;
  }
}
</style>
