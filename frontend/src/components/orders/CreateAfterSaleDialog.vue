<script setup>
import { ref } from 'vue';
import { afterSalesApi } from '../../api/purchase-after-sales';
import AfterSaleComposer from './AfterSaleComposer.vue';
const props = defineProps({ item: { type: Object, required: true } });
const emit = defineEmits(['close', 'created']);
const busy = ref(false);
</script>
<template>
  <el-dialog
    :model-value="true"
    title="创建采购售后工单"
    width="640px"
    style="max-width: calc(100vw - 32px)"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    @close="emit('close')"
  >
    <p class="ticket-order">{{ item.shopName }} · {{ item.orderNumber }} · {{ item.walmartSku }}</p>
    <AfterSaleComposer
      :submit="(body) => afterSalesApi.create({ ...body, itemId: item.id })"
      label="创建工单"
      @busy="busy = $event"
      @sent="emit('created', $event)"
    />
  </el-dialog>
</template>
<style scoped>
.ticket-order {
  margin: 0 0 20px;
  overflow-wrap: anywhere;
  color: var(--el-text-color-secondary);
}
</style>
