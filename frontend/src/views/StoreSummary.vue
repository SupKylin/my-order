<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { Refresh, Search } from '@element-plus/icons-vue';
import DailyStatistics from '../components/home/DailyStatistics.vue';
import StoreOverview from '../components/home/StoreOverview.vue';
import StoreOwnerSelect from '../components/home/StoreOwnerSelect.vue';
import ProfitStatistics from '../components/home/ProfitStatistics.vue';
import { loadHomeReport } from '../api/home';
import BusinessDatePicker from '../components/BusinessDatePicker.vue';

const report = ref(null),
  loading = ref(false);
const draft = reactive({ dates: [], storeIds: [], ownerId: null });
const datePicker = ref(null);
const applied = ref({ scope: 'summary', storeIds: [], ownerId: null });
const stores = computed(() => report.value?.storeOptions || []);
let requestVersion = 0;
async function load() {
  const version = ++requestVersion;
  loading.value = true;
  try {
    const data = await loadHomeReport(applied.value);
    if (version !== requestVersion) return;
    report.value = data;
    if (!applied.value.startDate) {
      applied.value = { ...applied.value, startDate: data.startDate, endDate: data.endDate };
      draft.dates = [data.startDate, data.endDate];
    }
  } catch {
    // 拦截器提示错误，保留完整的上次结果，不混用新旧数据。
  } finally {
    if (version === requestVersion) loading.value = false;
  }
}
function query() {
  if (datePicker.value && !datePicker.value.validate(draft.dates)) return;
  applied.value = {
    scope: 'summary',
    storeIds: [...draft.storeIds],
    ownerId: draft.ownerId || null,
    startDate: draft.dates?.[0],
    endDate: draft.dates?.[1],
  };
  load();
}
function reset() {
  Object.assign(draft, { dates: [], storeIds: [], ownerId: null });
  query();
}
onMounted(load);
</script>

<template>
  <div class="overview-scroll" v-loading="loading">
    <section class="summary-filters panel">
      <div class="summary-heading">
        <h1>店铺汇总</h1>
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新统计</el-button>
      </div>
      <div class="global-filters">
        <BusinessDatePicker
          ref="datePicker"
          policy="storeSummary"
          v-model="draft.dates"
          type="daterange"
          value-format="YYYY-MM-DD"
          range-separator="至"
          start-placeholder="统计开始日期（PST）"
          end-placeholder="统计结束日期（PST）"
        />
        <StoreOwnerSelect v-model="draft.ownerId" :stores="stores" />
        <el-select
          v-model="draft.storeIds"
          multiple
          collapse-tags
          collapse-tags-tooltip
          filterable
          clearable
          placeholder="全部店铺"
          aria-label="全局店铺筛选"
          class="global-store-select"
        >
          <el-option
            v-for="store in stores"
            :key="store.id"
            :value="store.id"
            :label="`${store.name}${store.isThirdParty ? '（三方）' : ''}`"
          />
        </el-select>
        <el-button :icon="Search" type="primary" plain :loading="loading" @click="query"
          >查询</el-button
        >
        <el-button :disabled="loading" @click="reset">重置</el-button>
      </div>
      <p>
        点击查询后统一应用全部列表和汇总；订单按所选 PST
        自然日实时统计。绩效及财务数据按各自平台周期展示。
      </p>
    </section>
    <StoreOverview :report="report" />
    <StoreOverview :report="report" third-party />
    <ProfitStatistics :report="report" />
    <div class="daily-section">
      <DailyStatistics by-store managed :shared-report="report" />
    </div>
  </div>
</template>

<style scoped>
.overview-scroll {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable;
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding-right: 8px;
}
.overview-scroll > * {
  flex: 0 0 auto;
  min-width: 0;
}
.summary-filters {
  padding: 16px;
}
.summary-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}
.summary-heading h1 {
  margin: 0;
  font-size: 20px;
}
.global-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.global-filters :deep(.el-date-editor) {
  flex: 0 1 360px;
  width: 360px;
  max-width: 100%;
}
.global-store-select {
  width: 240px;
  max-width: 100%;
}
.summary-filters p {
  margin: 12px 0 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.daily-section {
  height: max(680px, calc(100vh - 180px));
}
</style>
