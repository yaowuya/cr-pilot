<template>
  <el-container class="admin-layout">
    <el-aside width="200px" class="admin-aside">
      <div class="admin-brand">cr-pilot</div>
      <el-menu :default-active="activeMenu" router class="admin-menu">
        <el-menu-item index="/reviews">
          <el-icon><Document /></el-icon>
          <span>评审记录</span>
        </el-menu-item>
        <el-menu-item index="/prompts">
          <el-icon><EditPen /></el-icon>
          <span>Prompt 管理</span>
        </el-menu-item>
        <el-menu-item index="/config">
          <el-icon><Setting /></el-icon>
          <span>环境变量</span>
        </el-menu-item>
        <el-menu-item index="/admins">
          <el-icon><User /></el-icon>
          <span>管理员</span>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="admin-header">
        <el-dropdown @command="onCommand">
          <span class="admin-user">
            <el-icon><UserFilled /></el-icon>
            {{ username }}
            <el-icon><ArrowDown /></el-icon>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="logout">退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </el-header>

      <el-main class="admin-main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
/**
 * 后台骨架：左侧菜单 + 顶栏 + 内容区。
 *
 * 菜单项与路由一一对应，`default-active` 绑定当前路径让当前页高亮。
 * 顶栏只展示当前管理员与退出入口，不放其他操作，避免与页面内按钮职责重叠。
 */
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { ArrowDown, Document, EditPen, Setting, User, UserFilled } from "@element-plus/icons-vue";
import { currentUsername, logout } from "../stores/auth.ts";

const route = useRoute();
const router = useRouter();
const username = currentUsername();

/** 当前激活的菜单项：取一级路径，避免子路径导致菜单失焦。 */
const activeMenu = computed(() => `/${route.path.split("/")[1] ?? ""}`);

async function onCommand(command: string): Promise<void> {
  if (command !== "logout") return;
  await logout();
  ElMessage.success("已退出登录");
  await router.push("/login");
}
</script>

<style scoped>
.admin-layout {
  height: 100vh;
}

.admin-aside {
  background-color: var(--el-bg-color);
  border-right: 1px solid var(--el-border-color-light);
}

.admin-brand {
  height: 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 16px;
  border-bottom: 1px solid var(--el-border-color-light);
}

.admin-menu {
  border-right: none;
}

.admin-header {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  border-bottom: 1px solid var(--el-border-color-light);
  background-color: var(--el-bg-color);
}

.admin-user {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  color: var(--el-text-color-regular);
}

.admin-main {
  background-color: var(--el-bg-color-page);
}
</style>
