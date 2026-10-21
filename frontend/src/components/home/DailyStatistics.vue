<script setup>
import { computed, onMounted, ref } from 'vue';
import { Refresh, Search } from '@element-plus/icons-vue';
import { loadHomeReport } from '../../api/home';
import StoreOwnerSelect from './StoreOwnerSelect.vue';

const props = defineProps({ byStore: Boolean });
const loading = ref(false),
  report = ref(null);
const storeId = ref(null),
  ownerId = ref(null),
  dates = ref([]);
const applied = ref({ storeId: null, ownerId: null, dates: [] });
const page = ref(1),
  pageSize = ref(50);
const columns = [
  ['totalSales', '总销售额（USD）', 155],
  ['totalOrders', '总订单数', 110],
  ['wfsOrders', 'WFS订单数', 115],
  ['reviewed', '已审核', 100],
  ['unallocatable', '不可分配', 110],
  ['purchasing', '采购中', 100],
  ['purchaseFailed', '采购失败', 110],
  ['virtualShipped', '虚拟单号发货', 145],
  ['refundAmount', '退款额（USD）', 150],
];
const filtered = computed(() => {
  const source = (props.byStore ? report.value?.dailyStores : report.value?.daily) || [];
  const ownerStores = new Set(
    (report.value?.stores || [])
      .filter((store) => store.ownerId === applied.value.ownerId)
      .map((store) => store.id),
  );
  return source.filter(
    (row) =>
      (!props.byStore || !applied.value.storeId || row.storeId === applied.value.storeId) &&
      (!props.byStore || !applied.value.ownerId || ownerStores.has(row.storeId)) &&
      (!applied.value.dates?.length ||
        (row.date >= applied.value.dates[0] && row.date <= applied.value.dates[1])),
  );
});
const visible = computed(() =>
  filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value),
);
const incomplete = computed(() => filtered.value.some((row) => !row.ready));
function query() {
  applied.value = {
    storeId: storeId.value,
    ownerId: ownerId.value,
    dates: [...(dates.value || [])],
  };
  page.value = 1;
}
function reset() {
  storeId.value = null;
  ownerId.value = null;
  dates.value = [];
  query();
}
async function load() {
  if (loading.value) return;
  loading.value = true;
  try {
    report.value = await loadHomeReport();
    page.value = Math.min(
      page.value,
      Math.max(1, Math.ceil(filtered.value.length / pageSize.value)),
    );
  } catch {
    // 请求拦截器显示错误，保留上次成功加载的统计。
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>

<template>
  <section v-loading="loading" class="panel management-panel daily-statistics">
    <div class="panel-heading">
      <div>
        <h2>{{ byStore ? '每日店铺订单统计' : '每日订单汇总' }}</h2>
        <p class="daily-description">
          最近 30 天（含今天） · 按美西标准时间 PST（UTC−8）统计 · 进入页面或刷新时实时计算
          <span v-if="byStore"> · 同日按销售额从高到低排列</span>
        </p>
      </div>
      <el-button :icon="Refresh" :loading="loading" @click="load">刷新统计</el-button>
    </div>
    <div class="management-filters">
      <StoreOwnerSelect v-if="byStore" v-model="ownerId" :stores="report?.stores || []" />
      <el-select
        v-if="byStore"
        v-model="storeId"
        class="daily-store-filter"
        clearable
        filterable
        placeholder="全部店铺"
      >
        <el-option
          v-for="store in report?.stores || []"
          :key="store.id"
          :value="store.id"
          :label="store.name"
        />
      </el-select>
      <el-date-picker
        v-model="dates"
        type="daterange"
        value-format="YYYY-MM-DD"
        range-separator="至"
        start-placeholder="统计开始日期"
        end-placeholder="统计结束日期"
        class="daily-date-filter"
      />
      <el-button type="primary" plain :icon="Search" @click="query">查询</el-button>
      <el-button @click="reset">重置</el-button>
      <span v-if="report" class="muted"
        >统计范围：{{ report.startDate }} 至 {{ report.endDate }}</span
      >
    </div>
    <el-alert
      v-if="incomplete"
      class="daily-alert"
      type="info"
      :closable="false"
      show-icon
      title="部分店铺订单统计暂不可用，请点击刷新重试。"
    />
    <div class="management-table-region">
      <el-table
        :data="visible"
        height="100%"
        :row-key="(row) => (byStore ? `${row.date}:${row.storeId}` : row.date)"
        stripe
        empty-text="当前条件下暂无统计数据"
      >
        <el-table-column prop="date" label="统计日期" width="125" fixed="left" />
        <el-table-column
          v-if="byStore"
          prop="name"
          label="店铺名"
          width="150"
          fixed="left"
          show-overflow-tooltip
        />
        <el-table-column label="按订单日期统计" align="center">
          <el-table-column
            v-for="[key, label, width] in columns"
            :key="key"
            :label="label"
            :min-width="width"
            align="right"
          >
            <template #default="{ row }">
              <el-tooltip
                v-if="row[key] == null"
                :content="
                  !row.ready
                    ? '当前店铺订单统计暂不可用，请刷新重试'
                    : '未取得完整的官方实际退款记录，不以取消金额或零替代'
                "
                placement="top"
              >
                <span class="muted">{{ !row.ready ? '等待更新' : '暂不可用' }}</span>
              </el-tooltip>
              <span v-else>{{ row[key] }}</span>
            </template>
          </el-table-column>
        </el-table-column>
      </el-table>
    </div>
    <div class="management-footer daily-footer">
      <span class="muted"
        >订单 / WFS
        按店铺＋客户订单号去重；状态按商品明细计数。销售额排除取消行，退款归原下单日。数据自
        2026-10-01 接入起。</span
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
</template>

<style scoped>
.daily-statistics {
  height: 100%;
  min-height: 0;
}
.daily-description {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.daily-store-filter {
  width: 180px;
}
.daily-date-filter {
  max-width: 310px;
}
.daily-alert {
  flex-shrink: 0;
  margin-bottom: 12px;
}
.daily-footer {
  gap: 16px;
}
.daily-footer > .muted {
  line-height: 1.6;
}
</style>
