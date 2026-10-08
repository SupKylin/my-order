<script setup>
defineProps({ value: { type: Object, required: true } });
const labels = {
  Created: '待确认',
  Acknowledged: '已确认',
  Shipped: '已发货',
  Delivered: '已送达',
  Cancelled: '已取消',
};
const time = (value) =>
  value == null
    ? '—'
    : new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Etc/GMT+8',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(value));
</script>
<template>
  <div class="walmart-details">
    <p>
      Walmart 状态：{{
        value.statuses?.map((status) => labels[status] || status).join(' / ') || '未返回'
      }}
      · PO {{ value.purchaseOrderId }} · 商品行 {{ value.lineNumber }}
    </p>
    <div class="variant-list">
      <el-tag
        v-for="(attribute, index) in value.attributes || []"
        :key="`${attribute.name}-${index}`"
        type="success"
        >{{ attribute.name }}：{{ attribute.value }}</el-tag
      >
      <span v-if="!value.attributes?.length">{{
        value.variantError ? '变体查询失败，待重试' : '接口未返回结构化变体属性'
      }}</span>
    </div>
    <p v-if="value.variantGroupId">变体组：{{ value.variantGroupId }}</p>
    <p v-if="value.variantError" class="muted">{{ value.variantError }}；已有属性保留上次结果。</p>
    <p>
      预计发货：{{ time(value.estimatedShipDate) }} · 预计送达：{{
        time(value.estimatedDeliveryDate)
      }}（PST / UTC−8）
    </p>
    <p class="muted">时间直接转换自接口；变体属性来自商品接口，不从标题推断。</p>
  </div>
</template>
<style scoped>
.walmart-details {
  margin-top: 12px;
  overflow-wrap: anywhere;
}
.variant-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.variant-list :deep(.el-tag) {
  height: auto;
  white-space: normal;
}
</style>
