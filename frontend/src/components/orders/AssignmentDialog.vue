<script setup>
import { useMeta } from '../../stores/meta';
const assignDialog = defineModel({ type: Boolean });
const channels = defineModel('channels', { type: Array, required: true });
defineProps({ count: Number, assignBusy: Boolean });
const emit = defineEmits(['submit']);
const meta = useMeta();
</script>
<template>
  <el-dialog
    v-model="assignDialog"
    title="分配采购渠道"
    width="460px"
    :close-on-click-modal="!assignBusy"
    :close-on-press-escape="!assignBusy"
    :show-close="!assignBusy"
    ><p class="dialog-description">
      为选中的 {{ count }} 条商品明细分配采购渠道，本次选择将覆盖原渠道。
    </p>
    <el-form label-position="top"
      ><el-form-item label="采购渠道" required
        ><el-select
          v-model="channels"
          placeholder="选择采购渠道（可多选）"
          multiple
          filterable
          :disabled="assignBusy"
          ><el-option
            v-for="channel in meta.fieldMap.purchaseChannel?.options"
            :key="channel"
            :value="channel"
            :label="channel" /></el-select></el-form-item></el-form
    ><el-alert
      title="仅“是否可分配”为“是”的订单可以分配渠道；未审核或不可分配的订单请先调整状态。"
      type="info"
      :closable="false"
    /><template #footer
      ><el-button :disabled="assignBusy" @click="assignDialog = false">取消</el-button
      ><el-button
        type="primary"
        :loading="assignBusy"
        :disabled="!channels.length"
        @click="emit('submit')"
        >确认分配</el-button
      ></template
    ></el-dialog
  >
</template>
