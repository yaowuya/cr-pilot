<template>
  <div>
    <el-form-item label="System Prompt（作为模型系统提示）">
      <el-input :model-value="systemPrompt" type="textarea" :rows="10" placeholder="系统的角色与评审要求" @update:model-value="emit('update:systemPrompt', $event)" />
    </el-form-item>

    <el-form-item label="User Prompt（评审内容模板）">
      <el-input :model-value="userPrompt" type="textarea" :rows="10" placeholder="包含占位符的评审内容模板" @update:model-value="emit('update:userPrompt', $event)" />
      <!--
        占位符提示：模板必须包含 {diffs_text}，否则模型收不到代码变更，
        评审结果必然为空。提交时由后端渲染这两处占位符。
      -->
      <el-text type="info" size="small" class="placeholder-hint">
        可用占位符：<code>{diffs_text}</code>（代码变更，必填）与 <code>{commits_text}</code>（提交历史）
      </el-text>
    </el-form-item>
  </div>
</template>

<script setup lang="ts">
/**
 * prompt 双栏编辑器。
 *
 * 唯一自建组件：Element Plus 没有「双栏 prompt 编辑 + 占位符提示」的现成组件。
 *
 * 按字段双向绑定（`v-model:system-prompt` / `v-model:user-prompt`）而不是绑定整个
 * 表单对象：父组件用 `reactive()` 声明表单时无法整体重新赋值（const 绑定），
 * 传对象再回传新对象会让输入静默丢失。按字段绑定只写入属性，语义也更贴近本组件
 * 实际负责的范围——它只编辑两个 prompt，不碰项目名与企微配置。
 */
defineProps<{ systemPrompt: string; userPrompt: string }>();
const emit = defineEmits<{ "update:systemPrompt": [string]; "update:userPrompt": [string] }>();
</script>

<style scoped>
.placeholder-hint {
  margin-top: 4px;
  display: block;
}

.placeholder-hint code {
  padding: 0 4px;
  background-color: var(--el-fill-color-light);
  border-radius: 2px;
}
</style>
