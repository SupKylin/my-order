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
  if (mode.value !== 'clear' && !note.value.trim())
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
      将{{ { clear: '清空', replace: '覆盖', append: '追加' }[mode] }}跨页选中的
      {{ items.length }} 条商品明细的跟单备注。
    </p>
    <el-radio-group v-model="mode" :disabled="busy" aria-label="备注修改方式">
      <el-radio value="replace">覆盖原备注</el-radio>
      <el-radio value="append">追加备注</el-radio>
      <el-radio value="clear">清空备注</el-radio>
    </el-radio-group>
    <el-input
      v-if="mode !== 'clear'"
      v-model="note"
      type="textarea"
      :rows="6"
      :maxlength="12000"
      show-word-limit
      :disabled="busy"
      :placeholder="
        mode === 'append'
          ? '保留原备注，换行追加本次内容；原备注为空则直接写入'
          : '填写跟单备注，将覆盖所选明细的原备注'
      "
      aria-label="跟单备注"
      style="margin-top: 16px"
    />
    <p v-if="mode === 'append'" class="dialog-description">
      追加后总长度不得超过12000字符；任一条超限，本批次均不修改。
    </p>
    <template #footer>
      <el-button :disabled="busy" @click="emit('close')">取消</el-button>
      <el-button type="primary" :loading="busy" @click="submit">
        {{ { clear: '确认清空', replace: '确认修改', append: '确认追加' }[mode] }}（{{
          items.length
        }}
        条）
      </el-button>
    </template>
  </el-dialog>
</template>
