<script setup>
import { ref, reactive, onMounted, onBeforeUnmount } from 'vue';
import { api } from '../api/http';
import { fmtDate } from '../utils/format';
import BusinessDatePicker from '../components/BusinessDatePicker.vue';

function defaultDates() {
  const now = Date.now(),
    day = 86400000;
  const midnight = Math.floor((now + 8 * 3600000) / day) * day;
  return [30, 1].map((days) => new Date(midnight - days * day).toISOString().slice(0, 10));
}
const datePicker = ref(null);
const draft = reactive({ dates: defaultDates(), channels: [] });
const result = ref(null),
  loading = ref(false),
  failed = ref(false);
const page = ref(1),
  pageSize = ref(20);
let applied = { startDate: draft.dates[0], endDate: draft.dates[1], channels: [] };
let generation = 0;
const columns = [
  ['total', '总采购单数'],
  ['inProgress', '采购中单数'],
  ['failed', '采购失败单数'],
  ['success', '采购成功单数'],
  ['other', '其他状态单数'],
  ['successRate', '采购成功率'],
  ['failureRate', '采购失败率'],
  ['inProgressRate', '采购中占比'],
];
const cards = [...columns, ['unassigned', '未分配采购单数'], ['unassignedRate', '未分配占比']];
const numberText = (value, key) =>
  value == null
    ? '—'
    : key.endsWith('Rate')
      ? `${Number(value).toFixed(2)}%`
      : Number(value).toLocaleString('zh-CN');
const delayed = (row) => new Date(row.capturedAt) - new Date(row.scheduledAt) >= 60000;
async function load() {
  const version = ++generation;
  loading.value = true;
  failed.value = false;
  try {
    const data = await api.get('/purchase-statistics', {
      params: {
        ...applied,
        channels: JSON.stringify(applied.channels),
        page: page.value,
        pageSize: pageSize.value,
      },
    });
    if (version === generation) result.value = data;
  } catch {
    if (version === generation) {
      failed.value = true;
      result.value = null;
    }
  } finally {
    if (version === generation) loading.value = false;
  }
}
function search() {
  if (datePicker.value && !datePicker.value.validate(draft.dates)) return;
  const dates = draft.dates?.length === 2 ? draft.dates : defaultDates();
  applied = { startDate: dates[0], endDate: dates[1], channels: [...draft.channels] };
  page.value = 1;
  load();
}
function reset() {
  draft.dates = defaultDates();
  draft.channels = [];
  search();
}
function resize() {
  page.value = 1;
  load();
}
onMounted(load);
onBeforeUnmount(() => generation++);
</script>

<template>
  <section class="purchase-statistics" v-loading="loading">
    <header class="statistics-heading">
      <div>
        <h2>采购统计汇总</h2>
        <p>每天北京时间24点保存累计采购情况，历史快照不随后续操作变化。</p>
      </div>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </header>
    <div class="statistics-filters">
      <BusinessDatePicker
        ref="datePicker"
        policy="purchaseStatistics"
        v-model="draft.dates"
        type="daterange"
        value-format="YYYY-MM-DD"
        start-placeholder="统计开始日期"
        end-placeholder="统计结束日期"
        range-separator="至"
        aria-label="采购统计日期范围"
      />
      <el-select
        v-model="draft.channels"
        multiple
        filterable
        clearable
        collapse-tags
        collapse-tags-tooltip
        placeholder="全部采购渠道"
        aria-label="采购统计渠道筛选"
      >
        <el-option
          v-for="channel in result?.channels || []"
          :key="channel"
          :value="channel"
          :label="channel"
        />
      </el-select>
      <el-button type="primary" :disabled="loading" @click="search">查询</el-button>
      <el-button :disabled="loading" @click="reset">重置</el-button>
      <span class="hint">最晚可查询昨日（北京时间），今天的数据将在24点生成。</span>
    </div>
    <el-alert v-if="failed" type="error" title="统计加载失败，请点击刷新重试" :closable="false" />
    <template v-else>
      <section class="summary-panel">
        <div class="summary-heading">
          <h3>整体汇总</h3>
          <span v-if="result?.summary"
            >统计日 {{ result.summary.date }} · 采集于
            {{ fmtDate(result.summary.capturedAt, true) }}（北京时间）
            <el-tag v-if="delayed(result.summary)" type="warning" size="small"
              >延迟采集，以实际采集时刻为准</el-tag
            >
          </span>
          <span v-else>暂无快照</span>
        </div>
        <p class="hint">
          取日期范围内最新一期，按商品明细去重；不受采购渠道筛选影响，不累计多天快照。
        </p>
        <div class="statistics-cards">
          <div v-for="[key, label] in cards" :key="key" class="statistics-card">
            <span>{{ label }}</span
            ><strong>{{ numberText(result?.summary?.[key], key) }}</strong>
          </div>
        </div>
      </section>
      <section class="channel-panel">
        <div class="summary-heading">
          <h3>每日渠道采购情况</h3>
          <span>{{ result?.total || 0 }} 条 · {{ result?.snapshotCount || 0 }} 期快照</span>
        </div>
        <el-table
          :data="result?.rows || []"
          stripe
          max-height="600"
          :row-key="(row) => JSON.stringify([row.date, row.channel])"
          class="statistics-table"
        >
          <el-table-column prop="date" label="统计日期" width="120" fixed />
          <el-table-column prop="channel" label="采购渠道" min-width="150" />
          <el-table-column
            v-for="[key, label] in columns"
            :key="key"
            :prop="key"
            :label="label"
            min-width="125"
            align="right"
          >
            <template #default="{ row }">{{ numberText(row[key], key) }}</template>
          </el-table-column>
          <el-table-column label="实际采集时间（北京）" min-width="210">
            <template #default="{ row }"
              >{{ fmtDate(row.capturedAt, true)
              }}<el-tag v-if="delayed(row)" size="small" type="warning">延迟采集</el-tag></template
            >
          </el-table-column>
          <template #empty
            ><el-empty
              :image-size="70"
              :description="
                result?.snapshotCount
                  ? '所选渠道暂无统计数据'
                  : '所选日期暂无快照，上线后于北京时间24点开始生成'
              "
          /></template>
        </el-table>
        <div class="statistics-footer">
          <p class="hint">
            排除WFS及平台已取消明细。多渠道各计1条，渠道合计可能大于整体。其他状态包含空值及取消采购；占比以各自总采购单数为分母。
          </p>
          <el-pagination
            v-model:current-page="page"
            v-model:page-size="pageSize"
            :page-sizes="[20, 50, 100]"
            :total="result?.total || 0"
            layout="total, sizes, prev, pager, next"
            :disabled="loading"
            @current-change="load"
            @size-change="resize"
          />
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.purchase-statistics {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
}
.statistics-heading,
.summary-heading,
.statistics-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
h2,
h3 {
  margin: 0;
}
h2 {
  font-size: 20px;
}
h3 {
  font-size: 16px;
}
.statistics-heading p,
.hint,
.summary-heading > span {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.7;
}
.statistics-heading p {
  margin: 8px 0 0;
}
.statistics-filters {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
}
.statistics-filters :deep(.el-date-editor) {
  flex: 0 1 320px;
  max-width: 100%;
}
.statistics-filters .el-select {
  width: 240px;
}
.statistics-filters .el-button + .el-button {
  margin-left: 0;
}
.summary-panel,
.channel-panel {
  padding: 20px;
  border-radius: 8px;
  background: var(--el-bg-color);
  min-width: 0;
}
.statistics-cards {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
}
.statistics-card {
  padding: 16px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}
.statistics-card span {
  display: block;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.statistics-card strong {
  display: block;
  margin-top: 10px;
  font-size: 23px;
  font-variant-numeric: tabular-nums;
}
.statistics-table {
  margin-top: 16px;
}
.statistics-footer {
  margin-top: 16px;
}
.statistics-footer .hint {
  flex: 1 1 380px;
  margin: 0;
}
@media (max-width: 1200px) {
  .statistics-cards {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
@media (max-width: 700px) {
  .purchase-statistics {
    padding: 12px;
  }
  .statistics-cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .statistics-footer :deep(.el-pagination) {
    max-width: 100%;
    overflow-x: auto;
  }
}
</style>
