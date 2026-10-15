<script setup>
import { computed } from 'vue';
import { fmtBeijingDate } from '../../utils/format';

const props = defineProps({ summary: Object, now: { type: Number, required: true } });
// 沿用服务器校准时钟；跨北京时间午夜立即隐藏前一天统计，不发起额外请求。
const channels = computed(() =>
  props.summary?.date === fmtBeijingDate(props.now) &&
  props.now < Date.parse(props.summary.expiresAt)
    ? props.summary.channels || []
    : [],
);
</script>

<template>
  <div class="assignment-summary" aria-label="今日采购渠道分配汇总">
    <span
      class="summary-label"
      :title="`${fmtBeijingDate(now)} · 北京时间；全部有权限的商品明细，不受列表筛选影响`"
      >今日分配：</span
    >
    <div class="summary-channels">
      <template v-if="channels.length">
        <el-tag v-for="entry in channels" :key="entry.channel" size="small" effect="light">
          {{ entry.channel }}：{{ entry.count }} 条
        </el-tag>
      </template>
      <span v-else class="muted">暂无分配记录</span>
    </div>
  </div>
</template>

<style scoped>
.assignment-summary {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  gap: 6px;
  font-size: 12px;
}
.summary-label {
  flex-shrink: 0;
  color: var(--el-text-color-secondary);
}
.summary-channels {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
  scrollbar-width: thin;
}
.summary-channels .el-tag {
  flex-shrink: 0;
}
</style>
