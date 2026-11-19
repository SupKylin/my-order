<script setup>
import { computed } from 'vue';
import { money } from '../../utils/format';
import { useMeta } from '../../stores/meta';
import { currentFinanceConfig } from '../../utils/purchaseCost';

const props = defineProps({ row: { type: Object, required: true } });
const meta = useMeta();
const settled = computed(() => props.row.settlement === '已结算');
const reference = computed(() => currentFinanceConfig(props.row, meta.purchaseChannels));
const commissionRate = computed(() =>
  settled.value ? props.row.commissionRate : reference.value.commissionRate,
);
const purchaseDiscount = computed(() =>
  settled.value ? props.row.purchaseDiscount : reference.value.purchaseDiscount,
);
</script>
<template>
  <section class="profit-details" aria-label="利润核算">
    <h4>利润核算 <small>金额单位：USD</small></h4>
    <div class="profit-values">
      <div>
        <label>订单金额</label><strong>{{ money(row.orderAmount) }}</strong>
      </div>
      <div>
        <label>{{ settled ? '店铺佣金（结算时）' : '店铺佣金（当前）' }}</label
        ><strong>{{ commissionRate == null ? '—' : `${commissionRate}%` }}</strong>
        <small>{{ settled ? '使用结算时保存的店铺佣金率' : reference.commissionMessage }}</small>
      </div>
      <div>
        <label>佣金金额</label><strong>{{ money(row.commissionAmount) }}</strong>
      </div>
      <div>
        <label>采购折扣</label><strong>{{ purchaseDiscount ?? '—' }}</strong>
        <small>{{ settled ? '使用结算时保存的采购折扣' : reference.discountMessage }}</small>
      </div>
      <div>
        <label>采购成本</label><strong>{{ money(row.purchaseCost) }}</strong>
      </div>
      <div :title="row.walmartRefundMessage">
        <label>Walmart退款金额</label><strong>{{ money(row.walmartRefundAmount) }}</strong
        ><small>{{ row.walmartRefundMessage }}</small>
      </div>
      <div :title="row.purchaseRefundMessage">
        <label>采购退款金额</label><strong>{{ money(row.purchaseRefundAmount) }}</strong
        ><small>{{ row.purchaseRefundMessage }}</small>
      </div>
      <div>
        <label>争议成功金额</label><strong>{{ money(row.disputeSuccessAmount) }}</strong
        ><small>未填写按0计算，在订单编辑中维护</small>
      </div>
      <div class="profit-result">
        <label>订单利润</label
        ><strong :class="{ loss: Number(row.orderProfit) < 0 }">{{
          row.orderProfit == null ? '未计算' : money(row.orderProfit)
        }}</strong>
      </div>
    </div>
    <p class="formula">
      订单利润＝订单金额－订单金额×佣金－采购成本－卖家退款净扣款＋采购退款金额＋争议成功金额
    </p>
    <p v-if="row.orderProfit == null" class="incomplete">{{ row.profitMessage }}</p>
  </section>
</template>
<style scoped>
.profit-details {
  margin-top: 16px;
  padding: 16px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}
h4 {
  margin: 0 0 16px;
  font-size: 14px;
}
h4 small {
  margin-left: 8px;
  font-weight: 400;
}
.profit-values {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 18px 24px;
}
.profit-values > div {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
label,
small,
.formula {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.6;
}
strong {
  color: var(--el-text-color-primary);
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.profit-result strong {
  font-size: 18px;
  font-weight: 600;
}
.formula {
  margin: 16px 0 0;
}
.loss {
  color: var(--el-color-danger);
}
.incomplete {
  margin: 8px 0 0;
  color: var(--el-color-warning);
  font-size: 12px;
}
</style>
