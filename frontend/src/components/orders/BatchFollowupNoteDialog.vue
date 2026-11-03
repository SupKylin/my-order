<script setup>
import { ref } from 'vue';
import { ElMessage } from 'element-plus';
import { orderApi } from '../../api/orders';

const props = defineProps({ items: { type: Array, required: true } });
const emit = defineEmits(['close', 'saved']);
const mode = ref('replace');
const note = ref('');
const busy = ref(false);
async function submit() {
  if (busy.value) return;
  if (mode.value === 'replace' && !note.value.trim())
    return ElMessage.warning('请输入跟单备注；需要清空时请选择“清空备注”');
  busy.value = true;
  try {
    const result = await orderApi.updateFollowupNote(
      props.items,
      mode.value,
      mode.value === 'clear' ? null : note.value,
    );
    ElMessage.success(
      `已${mode.value === 'clear' ? '清空' : '更新'} ${result.updated} 条商品明细的跟单备注`,
    );
    emit('saved');
  } catch {
    // 请求层统一提示错误；保留当前草稿供用户处理后重试。
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <el-dialog
    :model-value="true"
    title="批量修改跟单备注"
    width="520px"
    :close-on-click-modal="!busy"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    @update:model-value="!busy && emit('close')"
  >
    <p class="dialog-description">
      将{{ mode === 'clear' ? '清空' : '覆盖' }}跨页选中的 {{ items.length }} 条商品明细的跟单备注。
    </p>
    <el-radio-group v-model="mode" :disabled="busy" aria-label="备注修改方式">
      <el-radio value="replace">覆盖原备注</el-radio>
      <el-radio value="clear">清空备注</el-radio>
    </el-radio-group>
    <el-input
      v-if="mode === 'replace'"
      v-model="note"
      type="textarea"
      :rows="6"
      :maxlength="12000"
      show-word-limit
      :disabled="busy"
      placeholder="填写跟单备注，将覆盖所选明细的原备注"
      aria-label="跟单备注"
      style="margin-top: 16px"
    />
    <template #footer>
      <el-button :disabled="busy" @click="emit('close')">取消</el-button>
      <el-button type="primary" :loading="busy" @click="submit">
        {{ mode === 'clear' ? '确认清空' : '确认修改' }}（{{ items.length }} 条）
      </el-button>
    </template>
  </el-dialog>
</template>
