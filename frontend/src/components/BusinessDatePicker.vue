<script setup>
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { dateBounds, dateDisabled, dateRangeError } from '../utils/dateRanges';

defineOptions({ inheritAttrs: false });
const props = defineProps({
  modelValue: [Array, String, Date],
  policy: { type: String, default: '' },
  type: { type: String, default: 'daterange' },
  minDate: String,
  maxDate: String,
  required: Boolean,
});
const emit = defineEmits(['update:modelValue']);
const root = ref(null),
  anchor = ref(null),
  clock = ref(Date.now());
let typed = null;
const bounds = computed(() =>
  dateBounds(props.policy, clock.value, {
    minDate: props.minDate,
    maxDate: props.maxDate,
  }),
);
const disabledDate = (date) => dateDisabled(date, bounds.value, anchor.value);
function calendarChange(values) {
  typed = null;
  anchor.value = values?.[0] && !values?.[1] ? values[0] : null;
}
function visibleChange(visible) {
  if (visible) clock.value = Date.now();
  anchor.value = null;
}
function captureInput(event) {
  if (!event.target.matches('input')) return;
  typed = Array.from(root.value.querySelectorAll('input')).map((input) => input.value);
}
watch(
  () => props.modelValue,
  (value) => {
    if (!value?.length) typed = null;
  },
  { flush: 'sync' },
);
function validate(values = props.modelValue) {
  clock.value = Date.now();
  // 重置等程序操作可能尚未刷新子组件属性，优先使用父页面当前值。
  const error = dateRangeError((values === props.modelValue && typed) || values, bounds.value, {
    datetime: props.type === 'datetimerange',
    required: props.required,
  });
  typed = null;
  if (error) ElMessage.warning(error);
  return !error;
}
defineExpose({ validate });
</script>

<template>
  <span ref="root" class="business-date-picker" @input.capture="captureInput">
    <el-date-picker
      v-bind="$attrs"
      :model-value="modelValue"
      :type="type"
      :disabled-date="disabledDate"
      @update:model-value="emit('update:modelValue', $event)"
      @calendar-change="calendarChange"
      @visible-change="visibleChange"
      @clear="typed = null"
    />
  </span>
</template>

<style scoped>
.business-date-picker {
  display: contents;
}
</style>
