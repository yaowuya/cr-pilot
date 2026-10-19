/**
 * 主题（亮色 / 暗色）状态。
 *
 * 只操作 `<html>` 上的 `dark` 类名——所有颜色都定义在 `styles/index.css`
 * 的 `html:root` 与 `html:root.dark` 两套变量里，切换类名即整体换肤，
 * 无需逐个组件改样式。
 *
 * 持久化到 localStorage；首次访问跟随系统 `prefers-color-scheme`。
 */
import { ref } from "vue";

export type ThemeMode = "light" | "dark";

const STORAGE_KEY = "cr-pilot-theme";

/** 读取系统偏好，作为没有本地记录时的默认值。 */
function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

/** 当前主题。 */
export const theme = ref<ThemeMode>("light");

/** 把主题应用到 DOM 并持久化。 */
function apply(mode: ThemeMode): void {
  theme.value = mode;
  // Element Plus 的暗色变量挂在 html.dark 上，必须打在 <html> 而不是 <body>
  document.documentElement.classList.toggle("dark", mode === "dark");
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 隐私模式下 localStorage 可能不可写，主题失效不影响主流程，忽略。
  }
}

/** 初始化：本地记录优先，其次跟随系统。应用启动时调用一次。 */
export function initTheme(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    saved = null;
  }
  if (saved === "light" || saved === "dark") {
    apply(saved);
    return;
  }
  apply(systemPrefersDark() ? "dark" : "light");
}

/** 在亮色/暗色间切换。 */
export function toggleTheme(): void {
  apply(theme.value === "dark" ? "light" : "dark");
}
