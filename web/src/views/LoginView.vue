<template>
  <div class="login-page">
    <!-- 左侧品牌区：装饰性光斑 + 产品定位文案。窄屏隐藏，只保留表单 -->
    <section class="login-brand">
      <div class="login-brand__glow login-brand__glow--1" />
      <div class="login-brand__glow login-brand__glow--2" />

      <div class="login-brand__content">
        <div class="login-brand__mark">CR</div>
        <h1 class="login-brand__title">cr-pilot</h1>
        <p class="login-brand__slogan">GitLab 合并请求智能评审</p>

        <ul class="login-brand__features">
          <li v-for="feature in features" :key="feature.text">
            <el-icon><component :is="feature.icon" /></el-icon>
            <span>{{ feature.text }}</span>
          </li>
        </ul>
      </div>

      <p class="login-brand__footer">© {{ year }} cr-pilot</p>
    </section>

    <!-- 右侧表单区 -->
    <section class="login-form-area">
      <button class="login-theme-toggle" :title="theme === 'dark' ? '切换到亮色' : '切换到暗色'" @click="toggleTheme">
        <el-icon><Sunny v-if="theme === 'dark'" /><Moon v-else /></el-icon>
      </button>

      <div class="login-form-wrap">
        <header class="login-form__header">
          <h2 class="login-form__title">欢迎回来</h2>
          <p class="login-form__desc">请使用管理员账号登录控制台</p>
        </header>

        <el-form
          ref="formRef"
          :model="form"
          :rules="rules"
          label-position="top"
          size="large"
          @submit.prevent
        >
          <el-form-item label="用户名" prop="username">
            <el-input v-model="form.username" placeholder="请输入用户名" autocomplete="username">
              <template #prefix>
                <el-icon><User /></el-icon>
              </template>
            </el-input>
          </el-form-item>

          <el-form-item label="密码" prop="password">
            <el-input
              v-model="form.password"
              type="password"
              placeholder="请输入密码"
              show-password
              autocomplete="current-password"
              @keyup.enter="onSubmit"
            >
              <template #prefix>
                <el-icon><Lock /></el-icon>
              </template>
            </el-input>
          </el-form-item>

          <el-form-item>
            <el-button type="primary" :loading="submitting" class="login-submit" @click="onSubmit">
              登 录
            </el-button>
          </el-form-item>
        </el-form>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * 登录页。
 *
 * 左右分栏：左侧纯装饰的品牌区（窄屏隐藏），右侧表单。
 * 提交前本地校验非空；提交中禁用按钮防重复提交。登录成功后按 `redirect`
 * 查询参数回跳原目标（由路由守卫写入），缺省进入评审记录页。
 */
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, type FormInstance, type FormRules } from "element-plus";
import { Document, Lock, Moon, Setting, Sunny, User } from "@element-plus/icons-vue";
import { isApiError, resetRedirectFlag } from "../api/client.ts";
import { login } from "../stores/auth.ts";
import { theme, toggleTheme } from "../stores/theme.ts";

const route = useRoute();
const router = useRouter();
const formRef = ref<FormInstance>();
const submitting = ref(false);
const form = reactive({ username: "", password: "" });

const year = computed(() => new Date().getFullYear());

/**
 * 品牌区卖点：与产品实际能力对应，不是营销话术。
 *
 * icon 必须是导入的组件对象而非字符串——本项目按组件逐个 import 图标，
 * 没有全局注册，传字符串会让 `component :is` 渲染出空标签。
 */
const features = [
  { icon: Document, text: "自动评审 MR 并输出行内评论" },
  { icon: Setting, text: "环境变量与 Prompt 在线管理" },
  { icon: User, text: "评审记录与评分统计留痕" },
];

const rules: FormRules = {
  username: [{ required: true, message: "请输入用户名", trigger: "blur" }],
  password: [{ required: true, message: "请输入密码", trigger: "blur" }],
};

onMounted(() => {
  // 进入登录页说明上一轮跳转已结束，重置防重复跳转标志。
  resetRedirectFlag();
});

async function onSubmit(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  submitting.value = true;
  try {
    await login({ username: form.username, password: form.password });
    const redirect = typeof route.query.redirect === "string" ? route.query.redirect : "/reviews";
    await router.push(redirect);
  } catch (error) {
    ElMessage.error(isApiError(error) ? error.message : "登录失败");
  } finally {
    submitting.value = false;
  }
}
</script>

<style scoped>
.login-page {
  display: flex;
  height: 100vh;
  overflow: hidden;
  background-color: var(--el-bg-color-page);
}

/* ---------- 左侧品牌区 ---------- */
.login-brand {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: space-between;
  padding: 56px;
  overflow: hidden;
  background: linear-gradient(150deg, #4b4bc4 0%, #5b5bd6 45%, #7c7cdf 100%);
}

/* 两团模糊光斑：给纯色渐变加一点纵深，避免大面积死板 */
.login-brand__glow {
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  pointer-events: none;
}

.login-brand__glow--1 {
  top: -120px;
  right: -80px;
  width: 420px;
  height: 420px;
  background: rgb(255 255 255 / 22%);
}

.login-brand__glow--2 {
  bottom: -140px;
  left: -60px;
  width: 380px;
  height: 380px;
  background: rgb(129 140 248 / 40%);
}

.login-brand__content {
  position: relative;
  z-index: 1;
  max-width: 420px;
}

.login-brand__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  font-size: 19px;
  font-weight: 700;
  color: #4b4bc4;
  letter-spacing: 1px;
  background: #fff;
  border-radius: 14px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 16%);
}

.login-brand__title {
  margin: 28px 0 8px;
  font-size: 40px;
  font-weight: 700;
  line-height: 1.1;
  color: #fff;
  letter-spacing: -0.5px;
}

.login-brand__slogan {
  margin: 0 0 40px;
  font-size: 16px;
  color: rgb(255 255 255 / 82%);
}

.login-brand__features {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.login-brand__features li {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  color: rgb(255 255 255 / 90%);
}

.login-brand__features .el-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  font-size: 15px;
  background: rgb(255 255 255 / 16%);
  border-radius: 8px;
}

.login-brand__footer {
  position: relative;
  z-index: 1;
  margin: 0;
  font-size: 12px;
  color: rgb(255 255 255 / 60%);
}

/* ---------- 右侧表单区 ---------- */
.login-form-area {
  position: relative;
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  padding: 40px;
  background-color: var(--el-bg-color);
}

.login-theme-toggle {
  position: absolute;
  top: 24px;
  right: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  font-size: 17px;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  background: transparent;
  border: none;
  border-radius: 8px;
  transition: background-color var(--app-transition) ease, color var(--app-transition) ease;
}

.login-theme-toggle:hover {
  color: var(--el-text-color-primary);
  background-color: var(--el-fill-color-light);
}

.login-form-wrap {
  width: 100%;
  max-width: 360px;
}

.login-form__header {
  margin-bottom: 32px;
}

.login-form__title {
  margin: 0 0 8px;
  font-size: 26px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.login-form__desc {
  margin: 0;
  font-size: 14px;
  color: var(--el-text-color-secondary);
}

.login-submit {
  width: 100%;
  margin-top: 8px;
  font-weight: 500;
  letter-spacing: 2px;
}

/* 窄屏：隐藏品牌区，只留表单 */
@media (max-width: 900px) {
  .login-brand {
    display: none;
  }
}
</style>
