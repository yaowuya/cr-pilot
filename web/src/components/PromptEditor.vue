<template>
  <div class="prompt-editor">
    <el-form-item label="System Prompt（作为模型系统提示）" prop="systemPrompt">
      <el-input
        :model-value="systemPrompt"
        type="textarea"
        :rows="9"
        resize="vertical"
        placeholder="系统的角色与评审要求"
        class="prompt-textarea"
        @update:model-value="emit('update:systemPrompt', $event)"
      />
    </el-form-item>

    <el-form-item label="User Prompt（评审内容模板）" prop="userPrompt">
      <el-input
        :model-value="userPrompt"
        type="textarea"
        :rows="9"
        resize="vertical"
        placeholder="包含占位符的评审内容模板"
        class="prompt-textarea"
        @update:model-value="emit('update:userPrompt', $event)"
      />
      <!--
        占位符提示：模板必须包含 {diffs_text}，否则模型收不到代码变更，
        评审结果必然为空。提交时由后端渲染这两处占位符。
      -->
      <div class="placeholder-hint">
        可用占位符：
        <code>{diffs_text}</code><span class="placeholder-hint__note">代码变更，必填</span>
        <code>{commits_text}</code><span class="placeholder-hint__note">提交历史</span>
        <code>{head_sha}</code><span class="placeholder-hint__note">当前提交 SHA，行内评论定位用</span>
      </div>
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
/* prompt 是代码类文本，用等宽字体；行高略松便于逐行比对 */
.prompt-textarea :deep(textarea) {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.6;
}

.placeholder-hint {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.placeholder-hint code {
  padding: 1px 6px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--el-color-primary);
  background-color: var(--el-color-primary-light-9);
  border-radius: 5px;
}

/* 占位符后的灰色说明文字，与代码片段区分开 */
.placeholder-hint__note {
  margin-right: 6px;
  color: var(--el-text-color-placeholder);
}
</style>
