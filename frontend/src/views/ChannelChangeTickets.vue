<script setup>
import { ref, reactive, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { channelChangesApi } from '../api/channel-change-tickets';
import { ElMessage } from 'element-plus';
import { useMeta } from '../stores/meta';
import { useAuth } from '../stores/auth';
import { api } from '../api/http';
import { canAssignChannel } from '../utils/permissions';
import { canEditOrder } from '../utils/orderWritePolicy';
import AssignmentDialog from '../components/orders/AssignmentDialog.vue';
import PurchaseAssignmentSummary from '../components/orders/PurchaseAssignmentSummary.vue';
import StoreOwnerSelect from '../components/home/StoreOwnerSelect.vue';
import BusinessDatePicker from '../components/BusinessDatePicker.vue';
import { fmtDate } from '../utils/format';
import ChannelChangeDrawer from '../components/orders/ChannelChangeDrawer.vue';
const route = useRoute(),
  router = useRouter();
const meta = useMeta();
const exportBusy = ref(false);
const auth = useAuth();
const assignmentAllowed = computed(() => canAssignChannel(auth.user?.role));
const table = ref(null),
  selected = ref([]),
  assignDialog = ref(false),
  assignBusy = ref(false),
  assignOpening = ref(false),
  assignmentChannels = ref([]),
  assignmentItems = ref([]);
const assignmentSummary = ref(null),
  summaryFailed = ref(false),
  clockNow = ref(Date.now());
let clockTimer, serverClock;
function tickClock() {
  clockNow.value = serverClock
    ? serverClock.time + performance.now() - serverClock.received
    : Date.now();
}
const selectable = (row) =>
  assignmentAllowed.value && row.status === 'open' && !row.appliedAt && canEditOrder(row.item);
function clearSelection() {
  table.value?.clearSelection();
  selected.value = [];
}
async function openAssign() {
  if (!assignmentAllowed.value || assignOpening.value || assignBusy.value) return;
  if (!selected.value.length || selected.value.length > 500)
    return ElMessage.warning('请选择 1 至 500 条工单');
  if (selected.value.some((row) => !selectable(row)))
    return ElMessage.warning('只能分配处理中且尚未确认变更的非WFS工单');
  if (selected.value.some((row) => row.item.allocatable !== '是'))
    return ElMessage.warning('所选订单包含未审核或不可分配项，请先将是否可分配设置为“是”');
  assignmentItems.value = selected.value.map(({ id, version }) => ({ id, version }));
  assignOpening.value = true;
  try {
    await meta.load(true);
    assignmentChannels.value = [];
    assignDialog.value = true;
  } finally {
    assignOpening.value = false;
  }
}
async function assign() {
  if (!assignmentAllowed.value || assignBusy.value || !assignmentChannels.value.length) return;
  assignBusy.value = true;
  try {
    const result = await channelChangesApi.batchApply({
      items: assignmentItems.value,
      targetChannels: assignmentChannels.value,
    });
    ElMessage.success(`已确认 ${result.updated} 条工单变更，采购状态已清空`);
    assignDialog.value = false;
    clearSelection();
    await load();
  } finally {
    assignBusy.value = false;
  }
}
function ticketChanged() {
  clearSelection();
  load();
}
async function exportRows() {
  if (exportBusy.value) return;
  exportBusy.value = true;
  try {
    const blob = await channelChangesApi.export(
      { ...applied },
      crypto.randomUUID().replaceAll('-', ''),
    );
    const url = URL.createObjectURL(blob),
      link = document.createElement('a');
    link.href = url;
    link.download = '渠道变更订单.xlsx';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    if (error.response?.data instanceof Blob) {
      try {
        const body = JSON.parse(await error.response.data.text());
        ElMessage.error(body.message || '导出失败');
      } catch {
        ElMessage.error('导出失败，请稍后重试');
      }
    }
  } finally {
    exportBusy.value = false;
  }
}
const emptyFilters = () => ({
  q: '',
  status: '',
  shopNames: [],
  ownerId: null,
  purchaseChannel: [],
  purchaseStatus: [],
  dates: [],
});
const draft = reactive(emptyFilters());
const stores = ref([]),
  optionsLoading = ref(false),
  datePicker = ref(null);
const rows = ref([]),
  total = ref(0),
  openCount = ref(null),
  page = ref(1),
  pageSize = ref(20),
  loading = ref(false),
  failed = ref(false);
let applied = {},
  version = 0;
async function load() {
  const request = ++version;
  loading.value = true;
  try {
    const [result, summary] = await Promise.all([
      channelChangesApi.list({ ...applied, page: page.value, pageSize: pageSize.value }),
      api.get('/orders/purchase-assignment-summary').then(
        (value) => ({ value }),
        () => ({ failed: true }),
      ),
    ]);
    if (request !== version) return;
    const selectedBefore = [...selected.value];
    rows.value = result.rows;
    if (result.serverNow)
      serverClock = { time: Date.parse(result.serverNow), received: performance.now() };
    tickClock();
    summaryFailed.value = Boolean(summary.failed);
    if (!summary.failed) assignmentSummary.value = summary.value;
    total.value = result.total;
    openCount.value = result.openCount;
    failed.value = false;
    await nextTick();
    if (request !== version) return;
    const current = new Map(rows.value.map((row) => [row.id, row]));
    table.value?.clearSelection();
    for (const row of selectedBefore) {
      const latest = current.get(row.id) || row;
      if (selectable(latest)) table.value?.toggleRowSelection(latest, true);
    }
    selected.value = table.value?.getSelectionRows() || [];
  } catch {
    if (request === version) failed.value = true;
  } finally {
    if (request === version) loading.value = false;
  }
}
function search() {
  if (datePicker.value && !datePicker.value.validate(draft.dates)) return;
  clearSelection();
  applied = {
    q: draft.q.trim(),
    status: draft.status,
    shopNames: [...draft.shopNames],
    ownerId: draft.ownerId || undefined,
    purchaseChannel: [...draft.purchaseChannel],
    purchaseStatus: [...draft.purchaseStatus],
    startDate: draft.dates?.[0],
    endDate: draft.dates?.[1],
  };
  page.value = 1;
  load();
}
function reset() {
  Object.assign(draft, emptyFilters());
  search();
}
function open(row) {
  router.push({ path: '/channel-change-tickets', query: { ticket: row.id } });
}
function close() {
  router.replace({ path: '/channel-change-tickets' });
}
async function loadOptions() {
  optionsLoading.value = true;
  try {
    stores.value = (await channelChangesApi.options()).stores;
    await meta.load(true);
  } catch {
    // 请求失败保留已有选项，由统一拦截器提示。
  } finally {
    optionsLoading.value = false;
  }
}
function refresh() {
  clearSelection();
  load();
  loadOptions();
}
onMounted(() => {
  refresh();
  clockTimer = setInterval(tickClock, 1000);
});
onBeforeUnmount(() => {
  version++;
  clearInterval(clockTimer);
});
</script>
<template>
  <section class="change-page">
    <div class="heading">
      <h2>
        渠道变更工单 <el-tag type="info">{{ total }} 条</el-tag>
        <el-tag type="warning" title="统计已查询条件下的全部处理中工单，不受工单状态筛选和分页影响"
          >处理中 {{ openCount ?? '—' }} 条</el-tag
        >
      </h2>
      <div class="actions">
        <el-button
          v-if="assignmentAllowed"
          :disabled="!selected.length || loading || assignBusy"
          :loading="assignOpening"
          @click="openAssign"
          >批量分配采购渠道</el-button
        >
        <el-button :loading="exportBusy" :disabled="loading" @click="exportRows">导出订单</el-button
        ><el-button :loading="loading || optionsLoading" @click="refresh">刷新</el-button>
      </div>
    </div>
    <div class="filters">
      <el-input
        v-model="draft.q"
        clearable
        maxlength="191"
        placeholder="搜索店铺、订单号、SKU或商品名称"
        @keyup.enter="search"
      />
      <el-select
        v-model="draft.shopNames"
        multiple
        filterable
        clearable
        collapse-tags
        collapse-tags-tooltip
        :loading="optionsLoading"
        placeholder="全部店铺"
        aria-label="渠道变更店铺筛选"
      >
        <el-option
          v-for="store in stores"
          :key="store.id"
          :value="store.name"
          :label="store.name + (store.isThirdParty ? '（三方）' : '')"
        />
      </el-select>
      <StoreOwnerSelect v-model="draft.ownerId" :stores="stores" />
      <el-select
        v-model="draft.purchaseChannel"
        multiple
        filterable
        clearable
        collapse-tags
        collapse-tags-tooltip
        placeholder="采购渠道"
        aria-label="采购渠道筛选"
      >
        <el-option label="未分配" :value="true" />
        <el-option
          v-for="option in meta.fieldMap.purchaseChannel?.options"
          :key="option"
          :label="option"
          :value="option"
        />
      </el-select>
      <el-select
        v-model="draft.purchaseStatus"
        multiple
        filterable
        clearable
        collapse-tags
        collapse-tags-tooltip
        placeholder="采购状态"
        aria-label="采购状态筛选"
      >
        <el-option label="未填写（空值）" :value="true" />
        <el-option
          v-for="option in meta.fieldMap.purchaseStatus?.options"
          :key="option"
          :label="option"
          :value="option"
        />
      </el-select>
      <BusinessDatePicker
        ref="datePicker"
        policy="recordDate"
        v-model="draft.dates"
        type="daterange"
        value-format="YYYY-MM-DD"
        start-placeholder="创建开始日期（北京时间）"
        end-placeholder="创建结束日期（北京时间）"
        range-separator="至"
        class="created-date-filter"
      />
      <el-select v-model="draft.status" clearable placeholder="全部工单状态"
        ><el-option label="处理中" value="open" /><el-option label="已关闭" value="completed"
      /></el-select>
      <el-button type="primary" :loading="loading" @click="search">查询</el-button
      ><el-button :disabled="loading" @click="reset">重置</el-button>
    </div>
    <el-alert
      v-if="failed"
      title="工单加载失败，当前保留上次结果，请刷新重试"
      type="warning"
      :closable="false"
    />
    <div v-if="selected.length" class="actions">
      <span>已跨页选中 {{ selected.length }} 条工单</span>
      <el-button link :disabled="assignBusy" @click="clearSelection">取消勾选</el-button>
    </div>
    <el-table
      ref="table"
      v-loading="loading"
      :data="rows"
      row-key="id"
      class="ticket-table"
      height="100%"
      @selection-change="selected = $event"
    >
      <el-table-column
        v-if="assignmentAllowed"
        type="selection"
        width="46"
        fixed
        reserve-selection
        :selectable="selectable"
      />
      <el-table-column prop="id" label="工单编号" width="90" />
      <el-table-column prop="item.shopName" label="店铺" min-width="150" />
      <el-table-column prop="item.orderNumber" label="订单号" min-width="175" />
      <el-table-column prop="item.walmartSku" label="Walmart SKU" min-width="155" />
      <el-table-column label="变更前采购渠道" min-width="170"
        ><template #default="{ row }">{{
          row.beforeChannels.join(' / ') || '未分配'
        }}</template></el-table-column
      >
      <el-table-column label="目标采购渠道" min-width="170"
        ><template #default="{ row }">{{
          row.targetChannels.join(' / ') || '待分配'
        }}</template></el-table-column
      >
      <el-table-column label="当前采购渠道" min-width="170"
        ><template #default="{ row }">{{
          row.item.purchaseChannel.join(' / ') || '未分配'
        }}</template></el-table-column
      >
      <el-table-column prop="item.purchaseStatus" label="采购状态" min-width="160" />
      <el-table-column label="变更执行" min-width="120"
        ><template #default="{ row }"
          ><el-tag :type="row.appliedAt ? 'success' : 'info'">{{
            row.appliedAt ? '已变更' : '未变更'
          }}</el-tag></template
        ></el-table-column
      >
      <el-table-column label="工单状态" width="100"
        ><template #default="{ row }"
          ><el-tag :type="row.status === 'open' ? 'warning' : 'info'">{{
            row.status === 'open' ? '处理中' : '已关闭'
          }}</el-tag></template
        ></el-table-column
      >
      <el-table-column prop="creatorName" label="创建人" min-width="110" />
      <el-table-column label="创建时间（北京）" min-width="175"
        ><template #default="{ row }">{{ fmtDate(row.createdAt, true) }}</template></el-table-column
      >
      <el-table-column label="最近更新（北京）" min-width="175"
        ><template #default="{ row }">{{
          fmtDate(row.lastActivityAt, true)
        }}</template></el-table-column
      >
      <el-table-column label="操作" fixed="right" width="100"
        ><template #default="{ row }"
          ><div class="actions">
            <el-button link type="primary" @click="open(row)">查看工单</el-button>
          </div></template
        ></el-table-column
      >
    </el-table>
    <div class="footer">
      <span v-if="summaryFailed">今日分配加载失败，请刷新重试</span>
      <PurchaseAssignmentSummary v-else :summary="assignmentSummary" :now="clockNow" />
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :page-sizes="[20, 50, 100]"
        :total="total"
        layout="total, sizes, prev, pager, next"
        @current-change="load"
        @size-change="
          page = 1;
          load();
        "
      />
    </div>
  </section>
  <AssignmentDialog
    v-if="assignmentAllowed && assignDialog"
    v-model="assignDialog"
    v-model:channels="assignmentChannels"
    :count="assignmentItems.length"
    :assign-busy="assignBusy"
    :description="`为选中的 ${assignmentItems.length} 条工单批量确认渠道变更，并写回申请的采购信息、清空采购状态和原采购成功时间。任一工单校验失败则整批不修改。`"
    @submit="assign"
  />
  <ChannelChangeDrawer
    v-if="route.query.ticket"
    :ticket-id="route.query.ticket"
    @close="close"
    @changed="ticketChanged"
  />
</template>
<style scoped>
.change-page {
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  padding: 20px;
  background: white;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.heading,
.filters,
.footer,
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.heading,
.footer {
  justify-content: space-between;
}
h2 {
  margin: 0;
  font-size: 18px;
}
.filters .el-input {
  width: 360px;
  max-width: 100%;
}
.filters .el-select {
  width: 160px;
}
.filters .created-date-filter {
  flex: 0 1 390px;
  max-width: 100%;
}
.filters .store-owner-select {
  width: 210px;
}
.filters .el-button + .el-button {
  margin: 0;
}
.ticket-table {
  flex: 1;
  min-height: 200px;
}
.footer > span {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
