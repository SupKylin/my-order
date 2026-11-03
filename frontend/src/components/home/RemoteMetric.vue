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
    m.source === 'returns' && '来源：退货退款接口，仅统计已完成退款（含税）；不是财务账期净额',
    m.asOf && `退款数据截至（PST）：${reportTime(m.asOf)}`,
    m.periodStart && `统计范围：${m.periodStart} 至 ${m.periodEnd}`,
    m.coverageThrough && `报表连续覆盖至：${m.coverageThrough}`,
    m.fallback && '本次未取得有效付款报表，使用最近一次成功报表；金额属于标注日期，不代表当前账期',
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
      <small
        v-if="metric?.statusText"
        :class="{ 'remote-error': ['error', 'partial', 'unverified'].includes(metric.status) }"
        >{{ metric.statusText }}</small
      >
      <small v-else-if="metric?.status === 'error'" class="remote-error">{{
        metric.value == null
          ? '获取失败'
          : metric.fallback
            ? '最近可用报表 · 历史金额'
            : '历史值 · 更新失败'
      }}</small>
      <small v-else-if="metric?.status === 'partial'" class="remote-error">数据未完整覆盖</small>
      <small v-else-if="!metric">等待更新</small>
      <small v-if="metric?.periodStart">{{ metric.periodStart }} 至 {{ metric.periodEnd }}</small>
      <small v-if="metric?.coverageThrough">覆盖至 {{ metric.coverageThrough }}</small>
      <small v-if="metric?.source === 'returns'">已完成退款 · 含税</small>
      <small v-if="metric?.asOf">截至 {{ reportTime(metric.asOf) }}</small>
      <small v-if="metric?.value == null && metric?.error">{{ metric.error }}</small>
      <small v-if="metric?.scheduledSettlementDate"
        >预计结算 {{ metric.scheduledSettlementDate }}</small
      >
      <small v-if="metric?.reportUpdatedAt && !unit"
        >报表 {{ reportTime(metric.reportUpdatedAt) }}</small
      >
      <small v-else-if="metric?.fallback">平台未提供报表日期</small>
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
