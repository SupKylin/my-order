<script setup>
import { ref, toRef } from 'vue';
import { Rank } from '@element-plus/icons-vue';
import { useColumnDragSort } from '../../composables/useColumnDragSort';

const props = defineProps({
  columns: { type: Array, required: true },
  visible: { type: Array, required: true },
  saving: Boolean,
});
const emit = defineEmits(['close', 'save']);
const rows = ref([...props.columns]);
const selected = ref(props.visible.map((column) => column.key));
const { dragging, target, start, over, leave, drop, stop, moveByKey } = useColumnDragSort(
  rows,
  toRef(props, 'saving'),
);
function save() {
  emit('save', {
    order: rows.value.map((column) => column.key),
    hidden: rows.value
      .filter((column) => !selected.value.includes(column.key))
      .map((column) => column.key),
  });
}
</script>

<template>
  <el-dialog
    :model-value="true"
    title="表头设置"
    width="560px"
    class="column-settings-dialog"
    :close-on-click-modal="!saving"
    :close-on-press-escape="!saving"
    :show-close="!saving"
    @close="emit('close')"
  >
    <div class="column-settings-toolbar">
      <span class="muted">已勾选 {{ selected.length }} / {{ rows.length }} 列</span>
      <div>
        <el-button text :disabled="saving" @click="selected = rows.map((column) => column.key)"
          >全选</el-button
        >
        <el-button text :disabled="saving" @click="selected = []">清除勾选</el-button>
      </div>
    </div>
    <p class="column-order-hint muted">
      拖动左侧手柄调整顺序，靠近上下边缘可自动滚动。店铺名和订单号固定在左侧，保存后跟随当前账号。
    </p>
    <el-checkbox-group
      v-model="selected"
      class="column-settings-list"
      :disabled="saving"
      @dragover="over"
      @dragleave="leave"
      @drop="drop"
    >
      <div
        v-for="(column, index) in rows"
        :key="column.key"
        class="column-order-row"
        :data-column="column.key"
        :class="{
          'is-dragging': dragging === column.key,
          'drop-before': target?.key === column.key && !target.after,
          'drop-after': target?.key === column.key && target.after,
        }"
      >
        <button
          v-if="!column.fixed"
          type="button"
          class="column-drag-handle"
          :draggable="!saving"
          :disabled="saving"
          :aria-label="`拖动排序：${column.label}`"
          title="拖动调整顺序，也可聚焦后按上下方向键"
          @dragstart="start($event, column)"
          @dragend="stop"
          @keydown.up.prevent="moveByKey(index, -1)"
          @keydown.down.prevent="moveByKey(index, 1)"
        >
          <el-icon><Rank /></el-icon>
        </button>
        <span v-else class="column-drag-placeholder" aria-hidden="true" />
        <el-checkbox :value="column.key">{{ column.label }}</el-checkbox>
        <span v-if="column.fixed" class="muted">固定左侧</span>
      </div>
    </el-checkbox-group>
    <template #footer>
      <el-button :disabled="saving" @click="emit('close')">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存设置</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.column-order-hint {
  margin: 0 0 12px;
  line-height: 1.6;
}
.column-order-row {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 40px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.column-order-row .el-checkbox {
  flex: 1;
  min-width: 0;
  margin-right: 0;
}
.column-order-row :deep(.el-checkbox__label) {
  white-space: normal;
}
.column-drag-handle,
.column-drag-placeholder {
  width: 28px;
  height: 28px;
  flex: 0 0 28px;
}
.column-drag-handle {
  display: inline-flex;
  font-size: 16px;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--el-text-color-secondary);
  cursor: grab;
}
.column-drag-handle:hover,
.column-drag-handle:focus-visible {
  color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.column-drag-handle:active {
  cursor: grabbing;
}
.column-drag-handle:disabled {
  cursor: not-allowed;
}
.is-dragging {
  opacity: 0.45;
}
.drop-before::before,
.drop-after::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--el-color-primary);
  pointer-events: none;
}
.drop-before::before {
  top: 0;
}
.drop-after::after {
  bottom: 0;
}
</style>
