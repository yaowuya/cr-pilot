import { createApp } from "vue";
import ElementPlus from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import "element-plus/dist/index.css";
// 自定义 token 必须在 Element Plus 之后引入：同优先级下后引入的变量覆盖前者，
// 顺序反了主色和圆角会被 Element Plus 的默认值盖掉。
import "./styles/index.css";
import App from "./App.vue";
import { router } from "./router/index.ts";
import { initTheme } from "./stores/theme.ts";

/**
 * 应用引导。
 *
 * 全量引入 Element Plus 与中文语言包：管理界面文案以中文为主，组件默认文案
 * （分页、表格空态、日期选择）若用英文会与页面其余文字不一致。按需引入会增加
 * 构建配置复杂度，而这是一个内网管理页，体积不是瓶颈。
 *
 * 主题在挂载前初始化：先给 <html> 打上 dark 类，再渲染组件，
 * 避免暗色模式下出现一帧白屏闪烁。
 */
initTheme();

createApp(App).use(ElementPlus, { locale: zhCn }).use(router).mount("#app");
