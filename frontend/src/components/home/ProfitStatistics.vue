<script setup>
import { computed, ref, watch } from 'vue';
import { money } from '../../utils/format';
const props = defineProps({ report: Object });
const period = ref('week');
const pages = ref([1, 1]);
const sizes = ref([20, 20]);
const data = computed(() => props.report?.profit?.[period.value]);
const groups = computed(() =>
  [false, true].map((third, index) => {
    const rows = (data.value?.rows || []).filter((row) => row.isThirdParty === third);
    return {
      third,
      label: third ? '三方店铺' : '自有店铺',
      rows,
      total: data.value?.totals?.find((t) => t.isThirdParty === third),
      visible: rows.slice(
        (pages.value[index] - 1) * sizes.value[index],
        pages.value[index] * sizes.value[index],
      ),
    };
  }),
);
watch([() => props.report, period], () => {
  pages.value = [1, 1];
});
</script>

<template>
  <section class="profit-panel panel">
    <div class="profit-heading">
      <h2>利润统计</h2>
      <el-radio-group v-model="period" aria-label="利润统计周期">
        <el-radio-button value="week">按周</el-radio-button>
        <el-radio-button value="month">按月</el-radio-button>
      </el-radio-group>
    </div>
    <p class="profit-note">
      按下单日期归组（PST），周一至周日／自然月；仅统计顶部已查询日期范围。利润＝订单金额－订单金额×结算时佣金率－采购成本－Walmart退款净扣款金额＋采购退款金额＋争议成功金额。所有金额仅汇总资料完整、已计算利润的明细；未结算、缺佣金、成本或应填退款金额的明细列入“未计算”。退款归原订单日期，与按退款发生日期统计的“当月退款额”口径不同。
    </p>
    <section v-for="(group, index) in groups" :key="group.label" class="profit-group">
      <div class="profit-group-heading">
        <h3>{{ group.label }}</h3>
        <span
          >利润合计（USD）：<strong>{{ money(group.total?.orderProfit) }}</strong></span
        >
        <span>已计算 {{ group.total?.calculatedItems ?? '—' }} 条</span>
        <span :class="{ incomplete: group.total?.uncomputedItems > 0 }"
          >未计算 {{ group.total?.uncomputedItems ?? '—' }} 条</span
        >
        <span class="muted">取消排除 {{ group.total?.cancelledItems ?? '—' }} 条</span>
        <span>Walmart退款金额（USD）：{{ money(group.total?.walmartRefundAmount) }}</span>
        <span>采购退款（USD）：{{ money(group.total?.purchaseRefundAmount) }}</span>
        <span>争议成功（USD）：{{ money(group.total?.disputeSuccessAmount) }}</span>
      </div>
      <el-table
        :data="group.visible"
        max-height="500"
        empty-text="暂无符合条件的店铺"
        :row-key="(row) => `${row.storeId}:${row.periodStart}`"
      >
        <el-table-column
          :label="period === 'week' ? '统计周（PST）' : '统计月（PST）'"
          min-width="205"
          fixed="left"
        >
          <template #default="{ row }">
            <div>
              {{
                period === 'month'
                  ? row.periodStart.slice(0, 7)
                  : `${row.periodStart} 至 ${row.periodEnd}`
              }}
            </div>
            <small
              v-if="row.statisticStart !== row.periodStart || row.statisticEnd !== row.periodEnd"
              class="muted"
              >所选：{{ row.statisticStart }} 至 {{ row.statisticEnd }}</small
            >
          </template>
        </el-table-column>
        <el-table-column label="店铺 / 所属账号" min-width="175">
          <template #default="{ row }"
            ><div>
              {{ row.name }}
              <el-tag v-if="row.isThirdParty" size="small" type="warning">三方</el-tag>
            </div>
            <small class="muted">{{ row.owner }}</small></template
          >
        </el-table-column>
        <el-table-column
          v-for="[key, label] in [
            ['salesAmount', '已计算订单金额'],
            ['commissionAmount', '佣金金额'],
            ['purchaseCost', '采购成本'],
            ['walmartRefundAmount', 'Walmart退款金额'],
            ['purchaseRefundAmount', '采购退款金额'],
            ['disputeSuccessAmount', '争议成功金额'],
            ['orderProfit', '利润'],
          ]"
          :key="key"
          :label="`${label}（USD）`"
          min-width="165"
          align="right"
        >
          <template #default="{ row }"
            ><span :class="{ loss: key === 'orderProfit' && Number(row[key]) < 0 }">{{
              money(row[key])
            }}</span></template
          >
        </el-table-column>
        <el-table-column label="已计算明细" prop="calculatedItems" width="115" align="right" />
        <el-table-column label="未计算明细" prop="uncomputedItems" width="115" align="right" />
        <el-table-column label="取消排除" prop="cancelledItems" width="105" align="right" />
      </el-table>
      <div class="profit-footer">
        <el-pagination
          v-model:current-page="pages[index]"
          v-model:page-size="sizes[index]"
          :total="group.rows.length"
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          @size-change="pages[index] = 1"
        />
      </div>
    </section>
  </section>
</template>

<style scoped>
.profit-panel {
  padding: 20px;
}
.profit-heading,
.profit-group-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
}
.profit-heading {
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-size: 18px;
}
h3 {
  margin: 0;
  font-size: 15px;
}
.profit-note {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.8;
  margin: 12px 0 20px;
}
.profit-group + .profit-group {
  margin-top: 28px;
}
.profit-group-heading {
  margin-bottom: 12px;
  font-size: 13px;
}
.profit-footer {
  display: flex;
  justify-content: flex-end;
  padding-top: 16px;
  overflow-x: auto;
}
.incomplete {
  color: var(--el-color-warning);
}
.loss {
  color: var(--el-color-danger);
}
</style>
