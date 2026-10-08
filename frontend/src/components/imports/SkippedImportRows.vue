<script setup>
import { computed, ref, watch } from 'vue';
const props = defineProps({ rows: { type: Array, default: () => [] } });
const page = ref(1);
const pageSize = 20;
const visibleRows = computed(() =>
  props.rows.slice((page.value - 1) * pageSize, page.value * pageSize),
);
watch(
  () => props.rows,
  () => {
    page.value = 1;
  },
);
</script>

<template>
  <section v-if="rows.length" class="skipped-import-rows">
    <el-alert
      :title="`已跳过 ${rows.length} 行，以下数据不会新增或更新订单。可翻页查看全部明细。`"
      type="warning"
      show-icon
      :closable="false"
    />
    <el-table :data="visibleRows" max-height="360">
      <el-table-column label="文件" prop="sourceName" min-width="150" show-overflow-tooltip />
      <el-table-column label="Excel 行" prop="rowNumber" width="90" />
      <el-table-column label="系统店铺名" prop="shopName" min-width="120" />
      <el-table-column label="客户订单号" prop="orderNumber" min-width="170" />
      <el-table-column label="Walmart SKU" prop="walmartSku" min-width="150" />
      <el-table-column label="跳过原因" prop="reason" min-width="260" />
    </el-table>
    <el-pagination
      v-model:current-page="page"
      :page-size="pageSize"
      :total="rows.length"
      layout="total, prev, pager, next"
    />
  </section>
</template>

<style scoped>
.skipped-import-rows {
  margin: 16px 0;
  text-align: left;
}
.el-pagination {
  justify-content: flex-end;
  margin-top: 12px;
}
</style>
