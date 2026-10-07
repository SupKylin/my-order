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
  // 独立导入页面限制表格高度；弹框内交由弹框正文统一滚动。
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
const fieldOptions = computed(() => props.allowedFields || meta.fields);
const availableColumns = computed(() =>
  columns.value.filter((column) => !props.modelValue.some((row) => row.column === column.column)),
);
const issues = computed(() => mappingIssues(props.modelValue, fieldOptions.value));
const ambiguous = computed(() =>
  ambiguousSuggestions(columns.value)
    .filter((item) => !props.modelValue.some((row) => row.field === item.field))
    .map(
      (item) =>
        `${meta.fieldMap[item.field]?.label || item.field}（第 ${item.sources.map((column) => column.column).join('、')} 列）`,
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
function selectColumn(index, columnNumber) {
  const source = columns.value.find((column) => column.column === columnNumber);
  patch(index, { column: columnNumber ?? null, header: source?.header || '' });
}
function addMapping() {
  const source = availableColumns.value[0];
  emit('update:modelValue', [
    ...props.modelValue,
    { column: source?.column ?? null, header: source?.header || '', field: '' },
  ]);
}
/** 按关系所在行删除，重复列或重复字段也可分别移除；不修改已有订单。 */
function removeMapping(index) {
  emit(
    'update:modelValue',
    props.modelValue.filter((_, rowIndex) => rowIndex !== index),
  );
}
function samples(columnNumber) {
  return (
    columns.value.find((column) => column.column === columnNumber)?.samples?.find(Boolean) ||
    '— / 嵌入图片'
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
    v-if="ambiguous.length"
    type="warning"
    :closable="false"
    show-icon
    class="mapping-notice"
    :title="`以下自动识别存在多个来源，请新增映射后手动选择：${ambiguous.join('；')}`"
  />
  <el-table :data="modelValue" :max-height="maxHeight" class="mapping-table">
    <el-table-column label="关系" width="60" type="index" />
    <el-table-column label="Excel 源列" min-width="220">
      <template #default="{ row, $index }">
        <template v-if="manualSource">
          <el-input-number
            :model-value="row.column"
            :min="1"
            :max="500"
            :precision="0"
            :disabled="disabled"
            :aria-label="`第 ${$index + 1} 条映射列号`"
            placeholder="列号"
            controls-position="right"
            @update:model-value="patch($index, { column: $event ?? null })"
          />
          <el-input
            :model-value="row.header"
            :disabled="disabled"
            :aria-label="`第 ${$index + 1} 条映射表头`"
            placeholder="Excel 表头原文"
            class="mapping-header-input"
            @update:model-value="patch($index, { header: $event })"
          />
        </template>
        <el-select
          v-else
          :model-value="row.column"
          filterable
          clearable
          :disabled="disabled"
          :aria-label="`第 ${$index + 1} 条映射源列`"
          placeholder="选择 Excel 列"
          @update:model-value="selectColumn($index, $event)"
        >
          <el-option
            v-for="column in columns"
            :key="column.column"
            :value="column.column"
            :label="`第 ${column.column} 列 · ${column.header || '（空表头）'}`"
            :disabled="
              modelValue.some(
                (mapping, index) => index !== $index && mapping.column === column.column,
              )
            "
          />
        </el-select>
      </template>
    </el-table-column>
    <el-table-column v-if="!manualSource" label="示例数据" min-width="150">
      <template #default="{ row }"
        ><span class="muted ellipsis">{{ samples(row.column) }}</span></template
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
    表头仍会保存在模板中，可稍后配置；导入时跳过这些列。必须保留订单号的映射，WalmartSku、店铺名可不映射，不映射时按空值匹配，只匹配对应空值的组合。每个源列和系统字段只能使用一次；不需要的关系可直接删除，也可通过“新增映射”重新添加。删除映射只影响后续导入，已有订单字段保留原值。
  </p>
</template>
