<script setup>
defineProps({ value: { type: Object, required: true } });
const time = (value) =>
  value && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Etc/GMT+8',
        dateStyle: 'short',
        timeStyle: 'medium',
        hourCycle: 'h23',
      }).format(new Date(value))
    : '—';
</script>
<template>
  <section class="return-details">
    <h4>退货退款详情</h4>
    <p class="muted">
      时间为 PST（UTC−8） · 最近同步：{{ time(value.fetchedAt) }} · 金额含税，申请金额不代表已退款
    </p>
    <div
      v-for="line in value.lines"
      :key="`${line.returnOrderId}-${line.lineNumber}`"
      class="return-line"
    >
      <p>
        <strong>{{ line.status }}</strong> · 退货单 {{ line.returnOrderId }} · 商品行
        {{ line.lineNumber }} · 数量 {{ line.quantity ?? '—' }}
      </p>
      <p>申请时间：{{ time(line.requestedAt) }} · 退款完成时间：{{ time(line.completedAt) }}</p>
      <p class="muted">
        退款状态：{{ line.refundStatus || '未返回' }} · 退货状态：{{ line.returnStatus || '未返回'
        }}<span v-if="line.reason"> · 原因：{{ line.reason }}</span>
      </p>
    </div>
  </section>
</template>
<style scoped>
.return-details {
  margin-top: 16px;
  overflow-wrap: anywhere;
}
.return-details h4 {
  margin: 0 0 8px;
}
.return-line {
  padding: 8px 0;
}
.return-line + .return-line {
  border-top: 1px solid var(--el-border-color-lighter);
}
.return-line p {
  margin: 4px 0;
}
</style>
