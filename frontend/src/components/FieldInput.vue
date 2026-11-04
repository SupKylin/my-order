<script setup>
import { computed, ref } from 'vue';
import { Plus, Delete } from '@element-plus/icons-vue';
import { uploadApi } from '../api/uploads';
import { useMeta } from '../stores/meta';
import { imageValues as parseImageValues } from '../utils/image-values';
const props = defineProps({ field: Object, modelValue: [String, Number, Boolean, Date, Array] });
const emit = defineEmits(['update:modelValue', 'uploading']);
const meta = useMeta(),
  uploadingCount = ref(0),
  pendingImagePaths = ref([]);
const busy = computed(() => uploadingCount.value > 0);
// 手工清空要发出 null，后端才能区分“清空”与“未提供”。
const value = computed({
  get: () => props.modelValue ?? '',
  set: (v) => emit('update:modelValue', v === '' || v == null ? null : v),
});
const multipleValue = computed({
  get: () =>
    Array.isArray(props.modelValue) ? props.modelValue : props.modelValue ? [props.modelValue] : [],
  set: (values) => emit('update:modelValue', values.length ? values : null),
});
const imageList = computed(() => parseImageValues(props.modelValue));
const imagePreviewUrls = computed(() => imageList.value.map((path) => meta.imageUrl(path)));
const historicalOptions = computed(() =>
  multipleValue.value.filter((option) => !props.field.options.includes(option)),
);
async function upload(options) {
  uploadingCount.value += 1;
  emit('uploading', true);
  let uploadedPath = '';
  try {
    const result = await uploadApi.image(options.file);
    uploadedPath = result.path;
    pendingImagePaths.value.push(uploadedPath);
    const next = [...new Set([...imageList.value, ...pendingImagePaths.value])];
    emit('update:modelValue', next);
    options.onSuccess(result);
  } catch (e) {
    options.onError(e);
  } finally {
    if (uploadedPath) {
      const index = pendingImagePaths.value.indexOf(uploadedPath);
      if (index >= 0) pendingImagePaths.value.splice(index, 1);
    }
    uploadingCount.value -= 1;
    if (!uploadingCount.value) emit('uploading', false);
  }
}
function removeImage(index) {
  const next = imageList.value.filter((_, imageIndex) => imageIndex !== index);
  emit('update:modelValue', next.length ? next : null);
}
</script>
<template>
  <el-select
    v-if="field.type === 'multiselect'"
    v-model="multipleValue"
    multiple
    clearable
    filterable
    placeholder="请选择采购渠道（可多选）"
  >
    <el-option
      v-for="option in historicalOptions"
      :key="option"
      :value="option"
      :label="`${option}（历史值）`"
      disabled
    />
    <el-option v-for="option in field.options" :key="option" :value="option" :label="option" />
  </el-select>
  <el-select
    v-else-if="field.type === 'select'"
    v-model="value"
    clearable
    filterable
    placeholder="请选择"
    ><el-option
      v-if="value && !field.options.includes(value)"
      :value="value"
      :label="`${value}（历史值）`"
      disabled />
    <el-option v-for="option in field.options" :key="option" :label="option" :value="option"
  /></el-select>
  <el-date-picker
    v-else-if="field.type === 'date' || field.type === 'datetime'"
    v-model="value"
    :type="field.type === 'date' ? 'date' : 'datetime'"
    :value-format="field.type === 'date' ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:mm:ss'"
    :placeholder="field.type === 'date' ? '选择日期' : '选择日期与时间'"
    clearable
  />
  <div v-else-if="field.type === 'image'" class="image-field">
    <div v-if="imageList.length" class="image-preview-list">
      <div v-for="(path, index) in imageList" :key="path" class="image-preview">
      <el-image
        :src="meta.imageUrl(path, true)"
        :preview-src-list="imagePreviewUrls"
        :initial-index="index"
        fit="contain"
        preview-teleported
      /><el-button
        class="image-remove"
        :icon="Delete"
        circle
        size="small"
        aria-label="清除图片"
        :disabled="busy"
        @click="removeImage(index)"
      />
      </div>
    </div>
    <el-upload
      :show-file-list="false"
      multiple
      accept="image/png,image/jpeg,image/webp,image/gif"
      :http-request="upload"
      :disabled="busy"
      ><el-button :icon="Plus" :loading="busy">{{
        imageList.length ? '继续上传' : '上传图片'
      }}</el-button></el-upload
    >
  </div>
  <el-input
    v-else-if="field.type === 'textarea'"
    v-model="value"
    type="textarea"
    :rows="3"
    :maxlength="12000"
    placeholder="填写备注信息"
  />
  <el-input
    v-else
    v-model="value"
    :placeholder="
      ['money', 'decimal', 'integer'].includes(field.type) ? '请输入数字' : '请输入' + field.label
    "
    :inputmode="
      ['money', 'decimal'].includes(field.type)
        ? 'decimal'
        : field.type === 'integer'
          ? 'numeric'
          : 'text'
    "
    clearable
  />
</template>
