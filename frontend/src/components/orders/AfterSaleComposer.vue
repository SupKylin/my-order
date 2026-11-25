<script setup>
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import FieldInput from '../FieldInput.vue';
const props = defineProps({
  submit: { type: Function, required: true },
  disabled: Boolean,
  label: { type: String, default: '发送记录' },
  subject: { type: String, default: '售后' },
});
const emit = defineEmits(['sent', 'busy']);
const content = ref(''),
  images = ref([]),
  sending = ref(false),
  uploading = ref(false);
// 公网站点使用HTTP，不能依赖仅在安全上下文提供的randomUUID。
function requestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
let pending = null;
function uploadState(value) {
  uploading.value = value;
  emit('busy', value || sending.value);
}
async function send() {
  if (sending.value || uploading.value || props.disabled) return;
  if (!content.value.trim()) return ElMessage.warning(`请填写${props.subject}内容`);
  if ((images.value || []).length > 20) return ElMessage.warning('每条记录最多上传20张图片');
  const body = { content: content.value.trim(), images: images.value || [] };
  const signature = JSON.stringify(body);
  if (!pending || pending.signature !== signature) pending = { signature, id: requestId() };
  sending.value = true;
  emit('busy', true);
  try {
    const result = await props.submit({ ...body, requestId: pending.id });
    content.value = '';
    images.value = [];
    pending = null;
    ElMessage.success(`${props.subject}记录已保存`);
    emit('sent', result);
  } catch {
    /* 保留内容、图片和提交标识，失败后可安全重试。 */
  } finally {
    sending.value = false;
    emit('busy', uploading.value);
  }
}
</script>
<template>
  <el-form label-position="top" :disabled="disabled || sending">
    <el-form-item :label="`${subject}内容`">
      <el-input
        v-model="content"
        type="textarea"
        :rows="3"
        maxlength="12000"
        show-word-limit
        :placeholder="`填写${subject}说明或回复内容`"
      />
    </el-form-item>
    <el-form-item :label="`${subject}图片（每条最多20张）`">
      <FieldInput :field="{ type: 'image' }" v-model="images" @uploading="uploadState" />
    </el-form-item>
    <el-button type="primary" :loading="sending" :disabled="disabled || uploading" @click="send">{{
      label
    }}</el-button>
    <span class="composer-note">发送后不可修改或删除</span>
  </el-form>
</template>
<style scoped>
.composer-note {
  margin-left: 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
