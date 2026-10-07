import { createApp } from "vue";
import ElementPlus from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import "element-plus/dist/index.css";
import App from "./App.vue";
import { router } from "./router/index.ts";

/**
 * 应用引导。
 *
 * 全量引入 Element Plus 与中文语言包：管理界面文案以中文为主，组件默认文案
 * （分页、表格空态、日期选择）若用英文会与页面其余文字不一致。按需引入会增加
 * 构建配置复杂度，而这是一个内网管理页，体积不是瓶颈。
 */
createApp(App).use(ElementPlus, { locale: zhCn }).use(router).mount("#app");
