<script setup>
import { computed, onMounted, ref } from 'vue';
import { Refresh, Search } from '@element-plus/icons-vue';
import { loadHomeReport } from '../../api/home';
import RemoteMetric from './RemoteMetric.vue';
import StoreOwnerSelect from './StoreOwnerSelect.vue';
import { settlementSummary } from '../../utils/settlement-summary';
import { PLATFORM_TIME_ZONE } from '../../utils/businessTime';
const loading = ref(false),
  stores = ref([]),
  today = ref('');
const keyword = ref(''),
  appliedKeyword = ref(''),
  ownerId = ref(null),
  appliedOwnerId = ref(null),
  page = ref(1),
  pageSize = ref(20);
const filtered = computed(() =>
  stores.value.filter(
    (row) =>
      (!appliedOwnerId.value || row.ownerId === appliedOwnerId.value) &&
      [row.name, row.walmartName, row.owner].some((value) =>
        value?.toLowerCase().includes(appliedKeyword.value.toLowerCase()),
      ),
  ),
);
const visible = computed(() =>
  filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value),
);
const ready = computed(() => filtered.value.filter((row) => row.metrics));
const incomplete = computed(
  () => filtered.value.filter((row) => row.snapshotDate !== today.value).length,
);
const settlement = computed(() => settlementSummary(filtered.value, today.value));
const cards = computed(() => [
  { label: '店铺', value: filtered.value.length, note: `已统计 ${ready.value.length} 家` },
  { label: '累计订单', value: sum('totalOrders'), note: '客户订单号去重' },
  {
    label: '累计销售额（USD）',
    value: moneySum('totalSales'),
    note: '商品金额 + 运费，排除取消商品行',
  },
  { label: '昨日订单', value: sum('yesterdayOrders'), note: '美西标准时间前一天' },
  { label: '昨日销售额（USD）', value: moneySum('yesterdaySales'), note: '美西标准时间前一天' },
  {
    label: '待结算金额汇总（USD）',
    value: settlement.value.value,
    note: `已获取 ${settlement.value.available} 家 · 未获取 ${settlement.value.missing} 家 · 历史金额 ${settlement.value.historical} 家`,
    persistentNote: true,
  },
]);
const columns = [
  ['unshippedOrders', '未发货订单', '订单'],
  ['totalOrders', '总订单量', '订单'],
  ['totalSales', '总销售额（USD）', '金额'],
  ['yesterdayOrders', '昨日订单量', '订单'],
  ['yesterdaySales', '昨日销售额（USD）', '金额'],
  ['pendingConfirmation', '待确认数', '订单'],
  ['pendingPurchase', '待采购数', '商品明细'],
  ['cancelledOrders', '取消订单数', '订单'],
  ['purchaseSuccess', '采购成功数', '商品明细'],
];
const performance = [
  ['otd', '准时送达率 · 30天'],
  ['vtr', '有效追踪率 · 30天'],
  ['cancellations', '取消率 · 30天'],
  ['srr', '回复率 · 30天'],
  ['negativeFeedback', '差评率 · 60天'],
  ['returns', '退货率 · 60天'],
  ['itemNotReceived', '未收到商品率 · 60天'],
  ['lateShipment', '货运延误率 · 30天'],
];
function sum(key) {
  return ready.value.length ? ready.value.reduce((sum, row) => sum + row.metrics[key], 0) : '—';
}
function moneySum(key) {
  if (!ready.value.length) return '—';
  const cents = ready.value.reduce(
    (sum, row) => sum + BigInt(row.metrics[key].replace('.', '')),
    0n,
  );
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}
function query() {
  appliedKeyword.value = keyword.value.trim();
  appliedOwnerId.value = ownerId.value;
  page.value = 1;
}
function reset() {
  keyword.value = '';
  ownerId.value = null;
  query();
}
function time(value) {
  return value
    ? new Date(value).toLocaleString('zh-CN', { timeZone: PLATFORM_TIME_ZONE, hour12: false })
    : '等待更新';
}
async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    const data = await loadHomeReport();
    stores.value = data.stores;
    today.value = data.today;
    page.value = Math.min(
      page.value,
      Math.max(1, Math.ceil(filtered.value.length / pageSize.value)),
    );
  } catch {
    /* 错误由请求拦截器提示，保留上次成功加载的统计。 */
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>
<template>
  <section v-loading="loading" class="home-page">
    <div class="home-intro">
      <div>
        <h1>店铺概况与绩效</h1>
        <p>订单数据进入页面或刷新时实时统计 · 按美西标准时间 PST（UTC−8）归组</p>
      </div>
      <el-button :icon="Refresh" :loading="loading" @click="load">刷新统计</el-button>
    </div>
    <div class="home-cards">
      <article v-for="card in cards" :key="card.label">
        <span>{{ card.label }}</span
        ><strong>{{ card.value }}</strong
        ><small :class="{ 'persistent-note': card.persistentNote }">{{ card.note }}</small>
      </article>
    </div>
    <section class="panel management-panel home-table-panel">
      <div class="panel-heading">
        <h2>
          店铺统计 <span class="pill">{{ filtered.length }} 家</span>
        </h2>
        <span class="muted">{{
          incomplete
            ? `${incomplete} 家平台指标尚无今日快照；订单数据已实时统计`
            : '订单实时统计 · 平台指标为今日快照'
        }}</span>
      </div>
      <div class="management-filters">
        <el-input
          v-model="keyword"
          class="management-keyword"
          clearable
          placeholder="系统店铺名、Walmart 店铺名或所属账号"
          @keyup.enter="query"
        />
        <StoreOwnerSelect v-model="ownerId" :stores="stores" />
        <el-button type="primary" plain :icon="Search" @click="query">查询</el-button>
        <el-button @click="reset">重置</el-button>
        <span class="muted"
          >在线 SKU、绩效与待结算金额仍每日 PST 00:00 更新；悬停指标可查看数据时间。</span
        >
      </div>
      <div class="management-table-region">
        <el-table :data="visible" height="100%" row-key="id" empty-text="暂无可查看的店铺">
          <el-table-column label="店铺 / 所属账号" fixed="left" width="190">
            <template #default="{ row }"
              ><div class="home-store">
                <strong>{{ row.name }}</strong
                ><small>{{ row.walmartName }}</small
                ><small>{{ row.owner }}</small>
              </div></template
            >
          </el-table-column>
          <el-table-column label="在线 SKU" width="130"
            ><template #default="{ row }"
              ><RemoteMetric :metric="row.remote.publishedSku" /></template
          ></el-table-column>
          <el-table-column label="待结算金额（USD）" width="205"
            ><template #default="{ row }"><RemoteMetric :metric="row.remote.settlement" /></template
          ></el-table-column>
          <el-table-column label="店铺绩效 · 卖家责任口径">
            <el-table-column
              v-for="[key, label] in performance"
              :key="key"
              :label="label"
              width="150"
              ><template #default="{ row }"
                ><RemoteMetric :metric="row.remote[key]" unit="%" /></template
            ></el-table-column>
          </el-table-column>
          <el-table-column
            v-for="[key, label, unit] in columns"
            :key="key"
            :label="label"
            :min-width="unit === '金额' ? 165 : 125"
            align="right"
          >
            <template #header
              ><span>{{ label }}</span
              ><small v-if="unit !== '金额'" class="home-unit">{{ unit }}</small></template
            >
            <template #default="{ row }">{{ row.metrics?.[key] ?? '—' }}</template>
          </el-table-column>
          <el-table-column label="数据时间（PST）" width="260"
            ><template #default="{ row }">
              <div class="home-store">
                <span>订单统计：{{ time(row.measuredAt) }}</span
                ><small>平台采集：{{ time(row.remoteMeasuredAt) }}</small
                ><small v-if="row.snapshotDate !== today">{{
                  row.snapshotDate ? '平台指标为历史快照，等待更新' : '平台指标等待采集'
                }}</small>
                <small v-if="row.metrics?.missingOrderTime"
                  >{{ row.metrics.missingOrderTime }} 条缺少接口下单时间，未计入</small
                >
              </div>
            </template></el-table-column
          >
        </el-table>
      </div>
      <div class="management-footer">
        <span class="muted"
          >未发货：待确认或已确认；待采购：未审核明细。绩效均按卖家责任口径，统计周期见列名；待结算金额以平台报表时间为准。</span
        >
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="filtered.length"
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          @size-change="page = 1"
        />
      </div>
    </section>
  </section>
</template>
<style scoped>
.home-page {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.home-intro {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}
.home-intro h1 {
  font-size: 20px;
  margin: 0 0 4px;
}
.home-intro p {
  margin: 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.home-cards {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 12px;
}
.home-cards article {
  padding: 16px;
  border-radius: 8px;
  background: white;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.home-cards span,
.home-cards small {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.home-cards strong {
  font-size: 24px;
  color: var(--el-text-color-primary);
  overflow-wrap: anywhere;
}
.home-table-panel {
  flex: 1;
  height: auto;
}
.home-store {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.home-store small,
.home-unit {
  color: var(--el-text-color-secondary);
  font-size: 11px;
  font-weight: normal;
}
.home-unit {
  display: block;
}
@media (max-width: 1000px) {
  .home-cards {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-height: 700px) {
  .home-cards article {
    padding: 8px 12px;
    gap: 2px;
  }
  .home-cards small:not(.persistent-note) {
    display: none;
  }
  .home-page {
    gap: 10px;
  }
}
@media (max-width: 650px) {
  .home-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .home-cards strong {
    font-size: 19px;
  }
}
</style>
