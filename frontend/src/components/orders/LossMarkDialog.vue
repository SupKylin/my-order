<script setup>
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { orderApi } from '../../api/orders';

const props = defineProps({ items: { type: Array, required: true }, isLoss: Boolean });
const emit = defineEmits(['close', 'saved']);
const busy = ref(false);
async function submit() {
  if (busy.value) return;
  busy.value = true;
  try {
    const result = await orderApi.updateLossMark(props.items, props.isLoss);
    ElMessage.success(
      `已${props.isLoss ? '标记亏损' : '取消亏损标记'}，处理 ${result.rows.length} 条商品明细`,
    );
    emit('saved', result.rows);
  } catch {
    // 统一提示错误，保留选中项；版本冲突时由用户刷新后重新操作。
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <el-dialog
    :model-value="true"
    :title="isLoss ? '标记亏损' : '取消亏损标记'"
    width="460px"
    :close-on-click-modal="!busy"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    @update:model-value="!busy && emit('close')"
  >
    <p>将为所选 {{ items.length }} 条商品明细{{ isLoss ? '标记亏损' : '取消亏损标记' }}。</p>
    <p>订单管理和采购售后同步显示，仅作人工标记，不改变利润计算及统计金额。</p>
    <template #footer>
      <el-button :disabled="busy" @click="emit('close')">取消</el-button>
      <el-button :type="isLoss ? 'danger' : 'primary'" :loading="busy" @click="submit"
        >确认（{{ items.length }} 条）</el-button
      >
    </template>
  </el-dialog>
</template>
