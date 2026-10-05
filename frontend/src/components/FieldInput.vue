<script setup>
import { computed, ref } from 'vue';
import { Plus, Delete } from '@element-plus/icons-vue';
import { uploadApi } from '../api/uploads';
import { useMeta } from '../stores/meta';
const props = defineProps({ field: Object, modelValue: [String, Number, Boolean, Date, Array] });
const emit = defineEmits(['update:modelValue']);
const meta = useMeta(),
  busy = ref(false);
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
const historicalOptions = computed(() =>
  multipleValue.value.filter((option) => !props.field.options.includes(option)),
);
async function upload(options) {
  busy.value = true;
  try {
    const result = await uploadApi.image(options.file);
    emit('update:modelValue', result.path);
    options.onSuccess(result);
  } catch (e) {
    options.onError(e);
  } finally {
    busy.value = false;
  }
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
    <div v-if="value" class="image-preview">
      <el-image
        :src="meta.imageUrl(value, true)"
        :preview-src-list="[meta.imageUrl(value)]"
        fit="contain"
        preview-teleported
      /><el-button
        class="image-remove"
        :icon="Delete"
        circle
        size="small"
        aria-label="清除图片"
        @click="value = null"
      />
    </div>
    <el-upload
      :show-file-list="false"
      accept="image/png,image/jpeg,image/webp,image/gif"
      :http-request="upload"
      :disabled="busy"
      ><el-button :icon="Plus" :loading="busy">{{
        value ? '替换图片' : '上传图片'
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
