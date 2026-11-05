<script setup>
import { computed } from 'vue';
import { useMeta } from '../../stores/meta';
import { fmtDate, fmtBeijingDate, money } from '../../utils/format';
import { CHINA_UTC_OFFSET } from '../../utils/businessTime';
import { shippingRemainingHours, shippingWarningLabels } from '../../utils/shippingWarning';
import { purchaseWarning, confirmationTime } from '../../utils/purchaseWarning';
import { imageValues as parseImageValues } from '../../utils/image-values';
const props = defineProps({
  row: { type: Object, required: true },
  field: { type: Object, required: true },
  warning: String,
  warningNow: { type: Number, required: true },
});
const trackingWarning = computed(() => purchaseWarning(props.row, props.warningNow));
const showCancellationIntent = computed(
  () => props.row.platformOrderStatus === '已确认' && props.row.walmart?.intentToCancel === true,
);
const meta = useMeta();
const value = computed(() => props.row[props.field.key]);
const imageList = computed(() => parseImageValues(value.value));
const imagePreviewUrls = computed(() => imageList.value.map((path) => meta.imageUrl(path)));
const shippingHours = computed(() => shippingRemainingHours(value.value, props.warningNow));
const factorLabels = { low: '低', medium: '平', high: '高' };
const purchaseTag = computed(() => {
  const status = value.value;
  if (!status) return 'info';
  if (status.includes('失败') || status.includes('砍单')) return 'danger';
  return status.includes('成功') ? 'success' : 'warning';
});
const safeLink = computed(() => (/^https?:\/\//i.test(value.value || '') ? value.value : ''));
</script>
<template>
  <div
    v-if="field.key === 'orderNumber'"
    class="order-number-cell"
    :class="{ 'has-cancellation-intent': showCancellationIntent }"
  >
    <span class="mono order-number-text">{{ value ?? '—' }}</span>
    <span v-if="showCancellationIntent" class="cancellation-intent-badge">
      <el-tag
        type="danger"
        effect="dark"
        size="small"
        title="Walmart 已标记客户申请取消；请先核实取消申请再继续采购。申请不代表订单已正式取消。"
        >客户申请取消</el-tag
      >
    </span>
    <span
      v-if="factorLabels[row.priceFactorLevel]"
      class="price-factor-badge"
      :class="`price-factor-${row.priceFactorLevel}`"
      :title="`价格系数：${row.priceFactor}（${factorLabels[row.priceFactorLevel]}）`"
      :aria-label="`价格系数${factorLabels[row.priceFactorLevel]}`"
      >{{ factorLabels[row.priceFactorLevel] }}</span
    >
    <router-link
      v-if="row.purchaseAfterSale"
      :to="{ path: '/purchase-after-sales', query: { ticket: row.purchaseAfterSale.id } }"
      @click.stop
    >
      <el-tag
        :type="row.purchaseAfterSale.status === 'completed' ? 'success' : 'warning'"
        size="small"
        >{{ row.purchaseAfterSale.status === 'completed' ? '售后完毕' : '采购售后' }}</el-tag
      >
    </router-link>
    <span v-else-if="row.afterSales === '是'" class="after-sales-badge">售后</span>
    <el-tag
      v-if="row.addressRisk"
      type="danger"
      size="small"
      :title="row.addressRiskNote || '收件地址与风险地址库匹配'"
      >风险地址</el-tag
    >
  </div>
  <template v-else-if="field.key === 'shopName'">
    <span>{{ value ?? '—' }}</span>
    <el-tag v-if="row.storeIsThirdParty" size="small" type="warning" style="margin-left: 4px"
      >三方</el-tag
    >
  </template>
  <template v-else-if="field.key === 'returnStatuses'">
    <span v-if="!value?.length" class="muted">—</span>
    <el-tag
      v-for="status in value || []"
      :key="status"
      size="small"
      :type="status === '已退款' ? 'danger' : status === '已取消' ? 'info' : 'warning'"
      style="margin: 2px 4px 2px 0"
      title="展开商品明细查看退货退款详情"
      >{{ status }}</el-tag
    >
  </template>
  <template v-else-if="field.type === 'image'">
    <div v-if="imageList.length" class="order-cell-images">
      <el-image
        :src="meta.imageUrl(imageList[0], true)"
        :preview-src-list="imagePreviewUrls"
        fit="contain"
        preview-teleported
        lazy
        class="order-cell-image"
        ><template #error><span class="muted">加载失败</span></template></el-image
      >
      <el-tag v-if="imageList.length > 1" class="order-cell-image-count" size="small" type="info"
        >+{{ imageList.length - 1 }}</el-tag
      >
    </div>
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
  <div v-else-if="field.key === 'purchaseStatus'" class="purchase-status-cell">
    <el-tag :type="purchaseTag" effect="light" round>{{ value || '待填写' }}</el-tag>
    <span
      v-if="trackingWarning"
      class="purchase-wait-badge"
      :class="`purchase-wait-${trackingWarning.level}`"
      :title="
        row.purchaseConfirmedAt
          ? `采购成功时间：${confirmationTime(row.purchaseConfirmedAt)}（北京时间）；连续计时，含夜间和周末`
          : '状态计时尚未初始化，请联系管理员完成升级'
      "
      >{{ trackingWarning.text }}</span
    >
  </div>
  <template v-else-if="field.type === 'storeOwner'">
    <span v-if="row.storeOwner" class="person-cell"
      ><i>{{ row.storeOwner.displayName.slice(0, 1) }}</i
      >{{ row.storeOwner.displayName }}</span
    >
    <span v-else class="muted">未绑定</span>
  </template>
  <template v-else-if="['reviewStatus', 'supplierAssignmentStatus'].includes(field.key)">
    <el-tag :type="value === '不可分配' ? 'danger' : value ? 'success' : 'info'" size="small">
      {{ value || (field.key === 'reviewStatus' ? '未审核' : '未分配') }}
    </el-tag>
  </template>
  <template v-else-if="field.key === 'allocatable'">
    <el-tag v-if="value" :type="value === '是' ? 'success' : 'danger'" size="small">{{
      value
    }}</el-tag>
    <span v-else class="muted">—</span>
  </template>
  <span v-else-if="['purchaseConfirmedAt', 'purchaseAssignedAt'].includes(field.key)">{{
    fmtBeijingDate(value)
  }}</span>
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
  <span
    v-else
    :class="{
      mono: [
        'orderNumber',
        'walmartSku',
        'purchaseSku',
        'trackingNumber',
        'platformTrackingNumber',
      ].includes(field.key),
    }"
    >{{ value ?? '—' }}</span
  >
</template>
