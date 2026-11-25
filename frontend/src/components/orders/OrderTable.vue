<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { Upload } from '@element-plus/icons-vue';
import { orderShippingWarning } from '../../utils/shippingWarning';
import OrderCell from './OrderCell.vue';
import ProductDetails from './ProductDetails.vue';
import { canEditOrder } from '../../utils/orderWritePolicy';
const props = defineProps({
  rows: { type: Array, required: true },
  columns: { type: Array, required: true },
  loading: Boolean,
  showOperations: Boolean,
  canAssign: Boolean,
  warningNow: { type: Number, required: true },
});
const emit = defineEmits([
  'selection-change',
  'edit',
  'assign',
  'import',
  'after-sale',
  'channel-change',
  'loss-mark',
]);
const table = ref();
const compactOperations = ref(false);
const operationWidth = computed(() => (props.canAssign && !compactOperations.value ? 210 : 144));
let compactMedia;
const updateCompactOperations = () => {
  compactOperations.value = compactMedia.matches;
};
onMounted(() => {
  compactMedia = window.matchMedia('(max-width: 1280px)');
  updateCompactOperations();
  compactMedia.addEventListener('change', updateCompactOperations);
});
onBeforeUnmount(() => compactMedia?.removeEventListener('change', updateCompactOperations));
const warnings = computed(() =>
  Object.fromEntries(
    props.rows.map((row) => [row.id, orderShippingWarning(row, props.warningNow)]),
  ),
);
const shippingRowClass = ({ row }) =>
  row.isLoss
    ? 'loss-mark-row'
    : warnings.value[row.id]
      ? `shipping-row-${warnings.value[row.id]}`
      : '';
defineExpose({
  clearSelection: () => table.value?.clearSelection(),
  syncSelection: () => {
    // 回到已选页时采用最新行快照；变为 WFS 的记录不再参与批量操作。
    const current = new Map(props.rows.map((row) => [row.id, row]));
    const selected = (table.value?.getSelectionRows() || [])
      .map((row) => current.get(row.id) || row)
      .filter(canEditOrder);
    table.value?.clearSelection();
    for (const row of selected) table.value.toggleRowSelection(row, true);
    emit('selection-change', table.value?.getSelectionRows() || []);
  },
});
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
    <el-table-column
      type="selection"
      width="46"
      fixed
      :selectable="canEditOrder"
      reserve-selection
    />
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
        !['image', 'storeOwner'].includes(field.type) &&
        !['shopName', 'orderNumber', 'platformShipDate', 'purchaseStatus'].includes(field.key)
      "
    >
      <template #default="{ row }"
        ><OrderCell :row="row" :field="field" :warning="warnings[row.id]" :warning-now="warningNow"
      /></template>
    </el-table-column>
    <el-table-column v-if="showOperations" label="操作" fixed="right" :width="operationWidth"
      ><template #default="{ row }">
        <div v-if="canEditOrder(row)" class="order-row-actions">
          <el-button link type="primary" @click="emit('edit', row)">编辑</el-button>
          <el-button v-if="canAssign" link type="primary" @click="emit('assign', row)"
            >分配渠道</el-button
          >
          <el-button link type="primary" @click="emit('after-sale', row)">采购售后</el-button>
          <el-button link type="primary" @click="emit('channel-change', row)"
            >采购渠道变更</el-button
          >
          <el-button link :type="row.isLoss ? 'info' : 'danger'" @click="emit('loss-mark', row)">
            {{ row.isLoss ? '取消亏损标记' : '标记亏损' }}
          </el-button>
        </div>
        <span v-else class="muted" title="由 Walmart 同步维护">WFS 只读</span>
      </template></el-table-column
    >
    <template #empty
      ><el-empty description="暂无匹配的商品明细，请在店铺管理中同步 Walmart 订单" :image-size="90">
        <!-- 订单来源统一为 Walmart API，保留原 Excel 导入按钮。
        <el-button type="primary" :icon="Upload" @click="emit('import')">导入第一份订单</el-button>
        -->
      </el-empty></template
    >
  </el-table>
</template>

<style scoped>
.order-row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.order-row-actions :deep(.el-button) {
  margin: 0;
  flex: 0 0 auto;
}
</style>
