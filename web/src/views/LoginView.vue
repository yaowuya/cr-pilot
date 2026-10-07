<template>
  <div class="login-page">
    <el-card class="login-card">
      <template #header>
        <div class="login-title">cr-pilot 管理控制台</div>
      </template>
      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" @submit.prevent>
        <el-form-item label="用户名" prop="username">
          <el-input v-model="form.username" placeholder="用户名" autocomplete="username" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="密码"
            show-password
            autocomplete="current-password"
            @keyup.enter="onSubmit"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="submitting" class="login-submit" @click="onSubmit">登录</el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
/**
 * 登录页。
 *
 * 提交前本地校验非空；提交中禁用按钮防重复提交。登录成功后按 `redirect` 查询
 * 参数回跳原目标（由路由守卫写入），缺省进入评审记录页。
 */
import { onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, type FormInstance, type FormRules } from "element-plus";
import { isApiError, resetRedirectFlag } from "../api/client.ts";
import { login } from "../stores/auth.ts";

const route = useRoute();
const router = useRouter();
const formRef = ref<FormInstance>();
const submitting = ref(false);
const form = reactive({ username: "", password: "" });

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
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: var(--el-bg-color-page);
}

.login-card {
  width: 360px;
}

.login-title {
  text-align: center;
  font-weight: 600;
}

.login-submit {
  width: 100%;
}
</style>
