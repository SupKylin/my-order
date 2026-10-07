<script setup>
import { computed } from 'vue';
import { useMeta } from '../../stores/meta';
import { fmtDate, money } from '../../utils/format';
import { CHINA_UTC_OFFSET } from '../../utils/businessTime';
import { shippingRemainingHours, shippingWarningLabels } from '../../utils/shippingWarning';
const props = defineProps({
  row: { type: Object, required: true },
  field: { type: Object, required: true },
  warning: String,
  warningNow: { type: Number, required: true },
});
const meta = useMeta();
const value = computed(() => props.row[props.field.key]);
const shippingHours = computed(() => shippingRemainingHours(value.value, props.warningNow));
const factorLabels = { low: '低', medium: '平', high: '高' };
const purchaseTag = computed(() => {
  const status = value.value;
  if (!status) return 'info';
  if (status.includes('失败') || status === '砍单') return 'danger';
  return status.includes('成功') ? 'success' : 'warning';
});
const safeLink = computed(() => (/^https?:\/\//i.test(value.value || '') ? value.value : ''));
</script>
<template>
  <div v-if="field.key === 'orderNumber'" class="order-number-cell">
    <span class="mono order-number-text">{{ value ?? '—' }}</span>
    <span
      v-if="factorLabels[row.priceFactorLevel]"
      class="price-factor-badge"
      :class="`price-factor-${row.priceFactorLevel}`"
      :title="`价格系数：${row.priceFactor}（${factorLabels[row.priceFactorLevel]}）`"
      :aria-label="`价格系数${factorLabels[row.priceFactorLevel]}`"
      >{{ factorLabels[row.priceFactorLevel] }}</span
    >
  </div>
  <template v-else-if="field.type === 'image'">
    <el-image
      v-if="value"
      :src="meta.imageUrl(value, true)"
      :preview-src-list="[meta.imageUrl(value)]"
      fit="contain"
      preview-teleported
      lazy
      class="order-cell-image"
      ><template #error><span class="muted">加载失败</span></template></el-image
    >
    <span v-else class="muted">—</span>
  </template>
  <template v-else-if="field.key === 'platformShipDate'">
    <div>{{ fmtDate(value) }}</div>
    <span
      v-if="warning"
      class="shipping-badge"
      :class="`shipping-${warning}`"
      :title="`截止：${fmtDate(value)} 后一天 15:00（北京时间 UTC${CHINA_UTC_OFFSET}）`"
      >{{ warning === 'red' ? shippingWarningLabels.red : shippingHours }}</span
    >
  </template>
  <el-tag v-else-if="field.key === 'purchaseStatus'" :type="purchaseTag" effect="light" round>{{
    value || '待填写'
  }}</el-tag>
  <template v-else-if="field.type === 'assignee'">
    <span v-if="row.assignee" class="person-cell"
      ><i>{{ row.assignee.username.slice(0, 1) }}</i
      >{{ row.assignee.username }}</span
    >
    <span v-else class="muted">待分配</span>
  </template>
  <template v-else-if="field.key === 'allocatable'">
    <el-tag v-if="value" :type="value === '是' ? 'success' : 'danger'" size="small">{{
      value
    }}</el-tag>
    <span v-else class="muted">—</span>
  </template>
  <span v-else-if="field.type === 'date' || field.type === 'datetime'">{{
    fmtDate(value, field.type === 'datetime')
  }}</span>
  <span v-else-if="field.type === 'money'">{{ money(value) }}</span>
  <span v-else-if="field.type === 'multiselect'">{{ value?.join(' / ') || '—' }}</span>
  <a
    v-else-if="field.type === 'url' && safeLink"
    :href="safeLink"
    target="_blank"
    rel="noopener noreferrer"
    >{{ value }}</a
  >
  <span v-else :class="{ mono: ['orderNumber', 'sku', 'trackingNumber'].includes(field.key) }">{{
    value ?? '—'
  }}</span>
</template>
