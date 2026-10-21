<script setup>
import { computed } from 'vue';
import { PLATFORM_TIME_ZONE } from '../../utils/businessTime';
const props = defineProps({ metric: Object, unit: { type: String, default: '' } });
function reportTime(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return value;
  const date = new Date(/^\d{13}$/.test(String(value)) ? Number(value) : value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('zh-CN', { timeZone: PLATFORM_TIME_ZONE, hour12: false });
}
const hint = computed(() => {
  const m = props.metric;
  if (!m) return '等待每日任务更新';
  return [
    m.error,
    m.fetchedAt && `上次成功获取（PST）：${reportTime(m.fetchedAt)}`,
    m.reportUpdatedAt && `平台报表时间（PST）：${reportTime(m.reportUpdatedAt)}`,
    m.scheduledSettlementDate && `预计结算日：${m.scheduledSettlementDate}`,
    m.sellerAccountableRate != null && `卖家责任口径：${m.sellerAccountableRate}%`,
    m.standard && `平台标准：${m.standard}`,
    m.risk && `平台评估：${m.risk}`,
  ]
    .filter(Boolean)
    .join('；');
});
</script>
<template>
  <el-tooltip :content="hint" placement="top" :show-after="200">
    <div class="remote-metric">
      <span>{{ metric?.value == null ? '—' : `${metric.value}${unit}` }}</span>
      <small v-if="metric?.status === 'error'" class="remote-error">{{
        metric.value == null ? '获取失败' : '历史值 · 更新失败'
      }}</small>
      <small v-else-if="!metric">等待更新</small>
      <small v-if="metric?.scheduledSettlementDate"
        >预计结算 {{ metric.scheduledSettlementDate }}</small
      >
      <small v-if="metric?.reportUpdatedAt && !unit"
        >报表 {{ reportTime(metric.reportUpdatedAt) }}</small
      >
    </div>
  </el-tooltip>
</template>
<style scoped>
.remote-metric {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  line-height: 1.6;
}
small {
  color: var(--el-text-color-secondary);
  font-size: 11px;
}
.remote-error {
  color: var(--el-color-warning-dark-2);
}
</style>
