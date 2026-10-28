<template>
  <div class="login-page">
    <button class="theme-toggle" :title="theme === 'dark' ? '切换到亮色' : '切换到暗色'" @click="toggleTheme">
      <el-icon><Sunny v-if="theme === 'dark'" /><Moon v-else /></el-icon>
    </button>
    <main class="login-sheet">
      <section class="login-context">
        <div class="brand"><span class="brand__mark">CR</span><strong>cr-pilot</strong></div>
        <div class="context-copy">
          <p class="context-title">GitLab 合并请求<br />智能评审控制台</p>
          <p>集中管理评审记录、建议采纳、Prompt、模型与通知链路。</p>
        </div>
        <ul class="feature-ledger">
          <li v-for="feature in features" :key="feature"><span>{{ feature }}</span></li>
        </ul>
        <p class="copyright">© {{ year }} cr-pilot</p>
      </section>

      <section class="login-form-area">
        <div class="login-form-wrap">
          <header>
            <h1>登录控制台</h1>
            <p>使用已登记的控制台账号继续</p>
          </header>
          <el-form ref="formRef" :model="form" :rules="rules" label-position="top" size="large" @submit.prevent>
            <el-form-item label="用户名" prop="username">
              <el-input v-model="form.username" placeholder="请输入用户名" autocomplete="username"><template #prefix><el-icon><User /></el-icon></template></el-input>
            </el-form-item>
            <el-form-item label="密码" prop="password">
              <el-input v-model="form.password" type="password" placeholder="请输入密码" show-password autocomplete="current-password" @keyup.enter="onSubmit"><template #prefix><el-icon><Lock /></el-icon></template></el-input>
            </el-form-item>
            <el-form-item><el-button type="primary" :loading="submitting" class="login-submit" @click="onSubmit">登录</el-button></el-form-item>
          </el-form>
          <p class="login-help">登录失败不会泄露账号是否存在；连续提交期间按钮保持锁定。</p>
        </div>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
/** Framed Sheet 登录页；保留校验、防重复提交、主题切换与 redirect 回跳。 */
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, type FormInstance, type FormRules } from "element-plus";
import { Lock, Moon, Sunny, User } from "@element-plus/icons-vue";
import { isApiError, resetRedirectFlag } from "../api/client.ts";
import { login } from "../stores/auth.ts";
import { theme, toggleTheme } from "../stores/theme.ts";

const route = useRoute();
const router = useRouter();
const formRef = ref<FormInstance>();
const submitting = ref(false);
const form = reactive({ username: "", password: "" });
const year = computed(() => new Date().getFullYear());
const features = ["MR 行内评审与汇总评论", "项目级 Prompt 与模型配置", "评审统计与建议采纳追踪"];
const rules: FormRules = {
  username: [{ required: true, message: "请输入用户名", trigger: "blur" }],
  password: [{ required: true, message: "请输入密码", trigger: "blur" }],
};
onMounted(() => resetRedirectFlag());
async function onSubmit(): Promise<void> {
  if (submitting.value) return;
  submitting.value = true;
  try {
    const valid = await formRef.value?.validate().catch(() => false);
    if (!valid) return;
    await login({ username: form.username, password: form.password });
    const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "/reviews";
    await router.push(redirect);
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "登录失败");
  } finally { submitting.value = false; }
}
</script>

<style scoped>
.login-page { display: grid; min-height: 100vh; place-items: center; padding: 32px; background: var(--app-content-bg); }
.theme-toggle { position: fixed; top: 20px; right: 22px; display: grid; place-items: center; width: 34px; height: 34px; border: 0; border-radius: 7px; background: transparent; color: var(--el-text-color-regular); cursor: pointer; }
.theme-toggle:hover { background: var(--app-header-hover); color: var(--el-text-color-primary); }
.login-sheet { display: grid; grid-template-columns: 1.05fr .95fr; width: min(980px, 100%); min-height: 600px; overflow: hidden; background: var(--el-bg-color); border: 1px solid var(--app-border-color); border-radius: 16px; }
.login-context { display: flex; flex-direction: column; padding: 36px 40px; background: var(--app-sidebar-bg); }
.brand { display: flex; align-items: center; gap: 10px; font-size: 17px; }
.brand__mark { display: grid; place-items: center; width: 28px; height: 28px; border: 2px solid var(--el-text-color-primary); border-radius: 7px; font-size: 11px; font-weight: 700; }
.context-copy { margin-top: 86px; }
.context-title { margin: 0; font-size: 34px; font-weight: 700; line-height: 1.18; letter-spacing: -.03em; }
.context-copy > p:not(.context-title) { max-width: 390px; margin: 16px 0 0; color: var(--el-text-color-regular); font-size: 14px; line-height: 1.65; }
.feature-ledger { padding: 0; margin: 42px 0 0; list-style: none; border-top: 1px solid var(--app-border-color); }
.feature-ledger li { display: flex; align-items: center; justify-content: space-between; min-height: 50px; border-bottom: 1px solid var(--app-border-color); font-size: 13px; }
.feature-ledger b { color: #137a54; font-size: 12px; font-weight: 600; }
.copyright { margin: auto 0 0; color: var(--el-text-color-secondary); font-size: 12px; }
.login-form-area { display: grid; place-items: center; padding: 38px 50px; }
.login-form-wrap { width: 100%; max-width: 350px; }
.login-form-wrap header { margin-bottom: 30px; }
.login-form-wrap h1 { margin: 0; font-size: 25px; line-height: 1.2; }
.login-form-wrap header p,.login-help { color: var(--el-text-color-regular); font-size: 13px; }
.login-form-wrap header p { margin: 8px 0 0; }
.login-submit { width: 100%; margin-top: 8px; }
.login-help { margin: 18px 0 0; line-height: 1.55; }
@media (max-width: 800px) { .login-sheet { grid-template-columns: 1fr; } .login-context { display: none; } .login-form-area { min-height: 560px; } }
</style>
