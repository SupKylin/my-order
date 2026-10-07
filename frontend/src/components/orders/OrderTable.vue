<script setup>
import { ref, computed } from 'vue';
import { Upload } from '@element-plus/icons-vue';
import { shippingWarning } from '../../utils/shippingWarning';
import OrderCell from './OrderCell.vue';
import ProductDetails from './ProductDetails.vue';
const props = defineProps({
  rows: { type: Array, required: true },
  columns: { type: Array, required: true },
  loading: Boolean,
  deleting: Boolean,
  warningNow: { type: Number, required: true },
});
const emit = defineEmits(['selection-change', 'edit', 'assign', 'import', 'delete']);
const table = ref();
const warnings = computed(() =>
  Object.fromEntries(
    props.rows.map((row) => [row.id, shippingWarning(row.platformShipDate, props.warningNow)]),
  ),
);
const shippingRowClass = ({ row }) =>
  warnings.value[row.id] ? `shipping-row-${warnings.value[row.id]}` : '';
defineExpose({ clearSelection: () => table.value?.clearSelection() });
</script>
<template>
  <el-table
    ref="table"
    v-loading="loading"
    :data="rows"
    row-key="id"
    class="orders-table"
    :row-class-name="shippingRowClass"
    @selection-change="emit('selection-change', $event)"
    height="100%"
  >
    <el-table-column type="selection" width="46" fixed />
    <el-table-column type="expand" width="40" fixed
      ><template #default="{ row }"><ProductDetails :row="row" /></template
    ></el-table-column>
    <el-table-column
      v-for="field in columns"
      :key="field.key"
      :prop="field.key"
      :label="field.label"
      :min-width="field.width"
      :fixed="field.fixed"
      :align="field.type === 'money' ? 'right' : 'left'"
      :show-overflow-tooltip="
        !['image', 'assignee'].includes(field.type) &&
        !['platformShipDate', 'purchaseStatus'].includes(field.key)
      "
    >
      <template #default="{ row }"
        ><OrderCell :row="row" :field="field" :warning="warnings[row.id]" :warning-now="warningNow"
      /></template>
    </el-table-column>
    <el-table-column label="操作" fixed="right" width="180"
      ><template #default="{ row }">
        <el-button link type="primary" @click="emit('edit', row)">编辑</el-button>
        <el-button link type="primary" @click="emit('assign', row)">分配</el-button>
        <el-button link type="danger" :disabled="deleting" @click="emit('delete', row)"
          >删除</el-button
        >
      </template></el-table-column
    >
    <template #empty
      ><el-empty description="暂无匹配的商品明细" :image-size="90">
        <el-button type="primary" :icon="Upload" @click="emit('import')">导入第一份订单</el-button>
      </el-empty></template
    >
  </el-table>
</template>
