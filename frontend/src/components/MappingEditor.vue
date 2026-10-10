<script setup>
import { computed } from 'vue';
import { Plus, Delete } from '@element-plus/icons-vue';
import { useMeta } from '../stores/meta';
import { ambiguousSuggestions, mappingIssues, selectedMappings } from '../mapping';

const props = defineProps({
  info: Object,
  modelValue: { type: Array, default: () => [] },
  manualSource: Boolean,
  disabled: Boolean,
  allowedFields: { type: Array, default: null },
  // 模板弹框使用剩余高度，只滚动表格数据行；其他入口保留原高度限制。
  tableHeight: { type: [Number, String], default: null },
  maxHeight: { type: [Number, String], default: 460 },
});
const emit = defineEmits(['update:modelValue']);
const meta = useMeta();
const groups = [
  { key: 'order', label: '订单信息' },
  { key: 'product', label: '商品信息' },
  { key: 'purchase', label: '采购信息' },
];
const columns = computed(() => props.info?.columns || []);
const sourceHeaders = computed(() => [
  ...new Set(columns.value.map((column) => column.header.trim()).filter(Boolean)),
]);
const duplicateHeaders = computed(() =>
  sourceHeaders.value.filter(
    (header) => columns.value.filter((column) => column.header.trim() === header).length > 1,
  ),
);
const fieldOptions = computed(() => props.allowedFields || meta.fields);
const availableColumns = computed(() =>
  sourceHeaders.value.filter(
    (header) =>
      !duplicateHeaders.value.includes(header) &&
      !props.modelValue.some((row) => row.header.trim() === header),
  ),
);
const issues = computed(() => mappingIssues(props.modelValue, fieldOptions.value));
const ambiguous = computed(() =>
  ambiguousSuggestions(columns.value)
    .filter((item) => !props.modelValue.some((row) => row.field === item.field))
    .map(
      (item) =>
        `${meta.fieldMap[item.field]?.label || item.field}（${item.sources.map((column) => column.header || '空表头').join('、')}）`,
    ),
);
const canAdd = computed(
  () => props.modelValue.length < 500 && (props.manualSource || availableColumns.value.length > 0),
);

function patch(index, values) {
  emit(
    'update:modelValue',
    props.modelValue.map((row, rowIndex) => (rowIndex === index ? { ...row, ...values } : row)),
  );
}
function addMapping() {
  const header = availableColumns.value[0];
  emit('update:modelValue', [...props.modelValue, { header: header || '', field: '' }]);
}
/** 按关系所在行删除，重复列或重复字段也可分别移除；不修改已有订单。 */
function removeMapping(index) {
  emit(
    'update:modelValue',
    props.modelValue.filter((_, rowIndex) => rowIndex !== index),
  );
}
function samples(header) {
  return (
    columns.value
      .find((column) => column.header.trim() === header.trim())
      ?.samples?.find(Boolean) || '— / 嵌入图片'
  );
}
</script>

<template>
  <div class="mapping-caption">
    <span>映射关系 · {{ selectedMappings(modelValue).length }} 条生效</span>
    <el-button
      size="small"
      type="primary"
      :icon="Plus"
      :disabled="disabled || !canAdd"
      @click="addMapping"
      >新增映射</el-button
    >
  </div>
  <el-alert
    v-if="!manualSource && duplicateHeaders.length"
    type="warning"
    :closable="false"
    show-icon
    class="mapping-notice"
    :title="`示例表存在重复表头：${duplicateHeaders.join('、')}。需要导入这些字段时，请先在 Excel 中改为唯一名称。`"
  />
  <el-alert
    v-if="ambiguous.length"
    type="warning"
    :closable="false"
    show-icon
    class="mapping-notice"
    :title="`以下自动识别存在多个来源，请新增映射后手动选择：${ambiguous.join('；')}`"
  />
  <el-table :data="modelValue" :height="tableHeight" :max-height="maxHeight" class="mapping-table">
    <el-table-column label="关系" width="60" type="index" />
    <el-table-column label="Excel 表头名称" min-width="220">
      <template #default="{ row, $index }">
        <div v-if="manualSource" class="mapping-source-fields">
          <el-input
            :model-value="row.header"
            :disabled="disabled"
            :aria-label="`第 ${$index + 1} 条映射表头`"
            placeholder="Excel 表头原文"
            class="mapping-header-input"
            @update:model-value="patch($index, { header: $event })"
          />
        </div>
        <el-select
          v-else
          :model-value="row.header"
          filterable
          clearable
          :disabled="disabled"
          :aria-label="`第 ${$index + 1} 条映射表头`"
          placeholder="选择 Excel 表头"
          @update:model-value="patch($index, { header: $event || '' })"
        >
          <el-option
            v-for="header in sourceHeaders"
            :key="header"
            :value="header"
            :label="header"
            :disabled="
              duplicateHeaders.includes(header) ||
              modelValue.some(
                (mapping, index) => index !== $index && mapping.header.trim() === header,
              )
            "
          />
        </el-select>
      </template>
    </el-table-column>
    <el-table-column v-if="!manualSource" label="示例数据" min-width="150">
      <template #default="{ row }"
        ><span class="muted ellipsis">{{ samples(row.header) }}</span></template
      >
    </el-table-column>
    <el-table-column label="系统字段" min-width="240">
      <template #default="{ row, $index }">
        <el-select
          :model-value="row.field"
          filterable
          clearable
          :disabled="disabled"
          :aria-label="`第 ${$index + 1} 条映射系统字段`"
          placeholder="不映射（保留原值）"
          @update:model-value="patch($index, { field: $event || '' })"
        >
          <el-option-group v-for="group in groups" :key="group.key" :label="group.label">
            <el-option
              v-for="field in fieldOptions.filter((item) => item.group === group.key)"
              :key="field.key"
              :value="field.key"
              :label="field.label + (field.required ? ' *' : '')"
              :disabled="
                modelValue.some((mapping, index) => index !== $index && mapping.field === field.key)
              "
            />
          </el-option-group>
        </el-select>
        <div
          v-for="issue in issues.filter((item) => item.index === $index)"
          :key="issue.message"
          class="mapping-error"
        >
          {{ issue.message }}
        </div>
      </template>
    </el-table-column>
    <el-table-column label="操作" width="100" fixed="right">
      <template #default="{ $index }"
        ><el-button
          link
          type="danger"
          :icon="Delete"
          :disabled="disabled"
          :aria-label="`删除第 ${$index + 1} 条映射`"
          @click="removeMapping($index)"
          >删除</el-button
        ></template
      >
    </el-table-column>
    <template #empty
      ><el-empty description="暂无映射关系，点击“新增映射”开始配置" :image-size="55"
    /></template>
  </el-table>
  <p
    v-for="issue in issues.filter((item) => item.index === null)"
    :key="issue.message"
    class="mapping-error"
  >
    {{ issue.message }}
  </p>
  <p class="mapping-footnote">
    未选择系统字段的 Excel
    表头仍会保存在模板中，可稍后配置；导入时跳过这些列。仅按表头名称匹配，列顺序可以变化，忽略表头首尾空格。采购导入需映射店铺名、订单号、WalmartSku及至少一个可更新的采购字段；采购渠道不参与导入。每个表头名称和系统字段只能使用一次；同名表头无法区分，请先修改
    Excel。删除映射只影响后续导入，已有订单字段保留原值。
  </p>
</template>
