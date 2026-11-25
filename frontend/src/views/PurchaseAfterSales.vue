<script setup>
import { ref, reactive, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { afterSalesApi } from '../api/purchase-after-sales';
import { useAuth } from '../stores/auth';
import { useMeta } from '../stores/meta';
import { fmtDate } from '../utils/format';
import AfterSaleDrawer from '../components/orders/AfterSaleDrawer.vue';
import StoreOwnerSelect from '../components/home/StoreOwnerSelect.vue';
import { canManageProcurement } from '../utils/permissions';
import BusinessDatePicker from '../components/BusinessDatePicker.vue';
import LossMarkDialog from '../components/orders/LossMarkDialog.vue';
import { canEditOrder } from '../utils/orderWritePolicy';

const route = useRoute(),
  router = useRouter(),
  auth = useAuth(),
  meta = useMeta();
const draft = reactive({
  q: '',
  status: '',
  supplierFeedback: '',
  shopNames: [],
  dates: [],
  ownerId: null,
  purchaseChannel: [],
  purchaseStatus: [],
});
const stores = ref([]),
  optionsLoading = ref(false),
  openCount = ref(null),
  unfeedbackCount = ref(null);
const rows = ref([]),
  total = ref(0),
  page = ref(1),
  pageSize = ref(20),
  loading = ref(false);
const drawer = ref(null);
const table = ref(null),
  selected = ref([]),
  lossItems = ref(null),
  lossValue = ref(true);
const selectable = (row) => canEditOrder(row.item);
function clearSelection() {
  table.value?.clearSelection();
  selected.value = [];
}
function openLossMark(tickets, value) {
  if (loading.value) return;
  if (!tickets.length || tickets.length > 500) return ElMessage.warning('请选择 1 至 500 条工单');
  if (tickets.some((row) => !selectable(row))) return ElMessage.warning('WFS 订单不能修改亏损标记');
  lossItems.value = tickets.map(({ item }) => ({ id: item.id, version: item.version }));
  lossValue.value = value;
}
function lossSaved(updated) {
  const changes = new Map(updated.map((item) => [item.id, item]));
  for (const row of new Set([...rows.value, ...selected.value]))
    if (changes.has(row.item.id)) Object.assign(row.item, changes.get(row.item.id));
  lossItems.value = null;
  clearSelection();
}
const datePicker = ref(null);
let applied = {},
  listVersion = 0;
const canFeedback = computed(() => canManageProcurement(auth.user?.role));
const feedbackBusy = reactive(new Set());
async function markFeedback(row) {
  if (
    !canFeedback.value ||
    row.supplierFeedback ||
    !row.item.manualEditable ||
    feedbackBusy.has(row.id)
  )
    return;
  feedbackBusy.add(row.id);
  try {
    const result = await afterSalesApi.feedback(row.id);
    Object.assign(row, result);
    ElMessage.success('已标记反馈供应商');
    await loadList();
    await drawer.value?.refresh(row.id);
  } catch {
    /* 统一请求提示，失败保留原标记。 */
  } finally {
    feedbackBusy.delete(row.id);
  }
}

async function loadList() {
  const version = ++listVersion;
  loading.value = true;
  try {
    const data = await afterSalesApi.list({
      ...applied,
      page: page.value,
      pageSize: pageSize.value,
    });
    if (version === listVersion) {
      const selectedBefore = [...selected.value];
      rows.value = data.rows;
      total.value = data.total;
      openCount.value = data.openCount ?? null;
      unfeedbackCount.value = data.unfeedbackCount ?? null;
      await nextTick();
      if (version !== listVersion) return;
      const current = new Map(rows.value.map((row) => [row.id, row]));
      table.value?.clearSelection();
      for (const row of selectedBefore) {
        const latest = current.get(row.id) || row;
        if (selectable(latest)) table.value?.toggleRowSelection(latest, true);
      }
      selected.value = table.value?.getSelectionRows() || [];
    }
  } catch {
    if (version === listVersion) {
      clearSelection();
      rows.value = [];
      total.value = 0;
      openCount.value = null;
      unfeedbackCount.value = null;
    }
  } finally {
    if (version === listVersion) loading.value = false;
  }
}
function search() {
  if (loading.value) return;
  if (datePicker.value && !datePicker.value.validate(draft.dates)) return;
  clearSelection();
  applied = {
    q: draft.q.trim(),
    status: draft.status,
    supplierFeedback: draft.supplierFeedback,
    shopNames: [...draft.shopNames],
    purchaseChannel: [...draft.purchaseChannel],
    purchaseStatus: [...draft.purchaseStatus],
    ownerId: draft.ownerId || undefined,
    startDate: draft.dates?.[0],
    endDate: draft.dates?.[1],
  };
  page.value = 1;
  loadList();
}
function reset() {
  Object.assign(draft, {
    q: '',
    status: '',
    supplierFeedback: '',
    shopNames: [],
    dates: [],
    ownerId: null,
    purchaseChannel: [],
    purchaseStatus: [],
  });
  search();
}
function resize() {
  page.value = 1;
  loadList();
}
function open(row) {
  router.push({ path: '/purchase-after-sales', query: { ticket: row.id } });
}
function close() {
  router.replace({ path: '/purchase-after-sales' });
}
async function loadOptions() {
  optionsLoading.value = true;
  try {
    stores.value = (await afterSalesApi.options()).stores;
    await meta.load(true);
  } catch {
    /* 保留已有选项，错误由统一拦截器提示。 */
  } finally {
    optionsLoading.value = false;
  }
}
function refresh() {
  clearSelection();
  loadList();
  loadOptions();
}
onMounted(refresh);
onBeforeUnmount(() => {
  listVersion++;
});
</script>

<template>
  <section class="after-sale-page">
    <div class="after-sale-heading">
      <h2>
        采购售后 <el-tag type="info" size="small">{{ total }} 条</el-tag>
        <el-tag
          type="warning"
          size="small"
          class="open-count"
          title="按已查询的店铺、创建日期、所属账号、关键词、采购渠道、采购状态和反馈筛选统计全部处理中工单，不受售后状态筛选和分页影响"
          >处理中 {{ openCount ?? '—' }} 条</el-tag
        >
        <el-tag
          type="danger"
          size="small"
          class="unfeedback-count"
          title="统计其他已查询条件下的全部未反馈工单，包含已完毕工单，不受售后状态、是否已反馈供应商筛选及分页影响"
          >未反馈 {{ unfeedbackCount ?? '—' }} 条</el-tag
        >
      </h2>
      <div class="after-sale-toolbar">
        <span v-if="selected.length">已选 {{ selected.length }} 条</span>
        <el-button
          type="danger"
          plain
          :disabled="!selected.length || loading"
          @click="openLossMark(selected, true)"
          >批量标记亏损</el-button
        >
        <el-button :disabled="!selected.length || loading" @click="openLossMark(selected, false)"
          >批量取消亏损标记</el-button
        >
        <el-button :loading="loading || optionsLoading" @click="refresh">刷新</el-button>
      </div>
    </div>
    <div class="after-sale-filters">
      <el-input
        v-model="draft.q"
        clearable
        placeholder="搜索店铺名、订单号、SKU或商品名称"
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
        aria-label="采购售后店铺筛选"
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
      <el-select v-model="draft.status" clearable placeholder="全部售后状态"
        ><el-option label="处理中" value="open" /><el-option label="售后完毕" value="completed"
      /></el-select>
      <el-select
        v-model="draft.supplierFeedback"
        clearable
        placeholder="是否已反馈供应商"
        aria-label="是否已反馈供应商筛选"
      >
        <el-option label="全部" value="" />
        <el-option label="是" value="yes" />
        <el-option label="否" value="no" />
      </el-select>
      <el-button type="primary" plain :loading="loading" @click="search">查询</el-button
      ><el-button :disabled="loading" @click="reset">重置</el-button>
    </div>
    <div class="after-sale-table">
      <el-table
        ref="table"
        :data="rows"
        v-loading="loading"
        height="100%"
        row-key="id"
        :row-class-name="({ row }) => (row.item.isLoss ? 'loss-mark-row' : '')"
        @selection-change="selected = $event"
      >
        <el-table-column
          type="selection"
          width="46"
          fixed
          :selectable="selectable"
          reserve-selection
        />
        <el-table-column label="店铺名" min-width="180"
          ><template #default="{ row }"
            >{{ row.item.shopName }}
            <el-tag v-if="row.item.storeIsThirdParty" size="small" type="warning"
              >三方</el-tag
            ></template
          ></el-table-column
        >
        <el-table-column prop="item.orderNumber" label="订单号" min-width="190">
          <template #default="{ row }"
            >{{ row.item.orderNumber }}
            <el-tag v-if="row.item.isLoss" type="danger" effect="dark" size="small">亏损</el-tag>
          </template>
        </el-table-column>
        <el-table-column
          prop="item.walmartSku"
          label="Walmart SKU"
          min-width="180"
          show-overflow-tooltip
        />
        <el-table-column label="采购渠道" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">{{
            row.item.purchaseChannel?.join(' / ') || '未分配'
          }}</template>
        </el-table-column>
        <el-table-column label="采购状态" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">{{ row.item.purchaseStatus?.trim() || '未填写' }}</template>
        </el-table-column>
        <el-table-column label="售后状态" width="120"
          ><template #default="{ row }"
            ><el-tag :type="row.status === 'open' ? 'warning' : 'success'">{{
              row.status === 'open' ? '处理中' : '售后完毕'
            }}</el-tag></template
          ></el-table-column
        >
        <el-table-column label="采购退款金额" min-width="150" align="right">
          <template #default="{ row }">{{ row.purchaseRefundAmount ?? '未填写' }}</template>
        </el-table-column>
        <el-table-column prop="creatorName" label="发起人" width="120" />
        <el-table-column label="是否已反馈供应商" min-width="160">
          <template #default="{ row }">
            <el-tag
              :type="row.supplierFeedback ? 'success' : 'info'"
              :title="
                row.supplierFeedback
                  ? `${row.supplierFeedbackName || ''} · ${fmtDate(row.supplierFeedbackAt, true)}（北京时间）`
                  : ''
              "
              >{{ row.supplierFeedback ? '是' : '否' }}</el-tag
            >
          </template>
        </el-table-column>
        <el-table-column label="创建时间（北京）" width="185"
          ><template #default="{ row }">{{
            fmtDate(row.createdAt, true)
          }}</template></el-table-column
        >
        <el-table-column label="最后更新（北京）" width="185"
          ><template #default="{ row }">{{
            fmtDate(row.lastActivityAt, true)
          }}</template></el-table-column
        >
        <el-table-column label="操作" fixed="right" :min-width="canFeedback ? 230 : 190">
          <template #default="{ row }">
            <div class="after-sale-row-actions">
              <el-button link type="primary" @click="open(row)">查看工单</el-button>
              <el-button
                v-if="selectable(row)"
                link
                :type="row.item.isLoss ? 'info' : 'danger'"
                @click="openLossMark([row], !row.item.isLoss)"
              >
                {{ row.item.isLoss ? '取消亏损标记' : '标记亏损' }}
              </el-button>
              <el-button
                v-if="canFeedback && row.item.manualEditable"
                link
                type="primary"
                :loading="feedbackBusy.has(row.id)"
                :disabled="row.supplierFeedback"
                @click="markFeedback(row)"
                >已反馈</el-button
              >
            </div>
          </template>
        </el-table-column>
        <template #empty
          ><el-empty description="暂无采购售后工单，可从订单列表发起" :image-size="80"
        /></template>
      </el-table>
    </div>
    <div class="after-sale-footer">
      <span>工单按商品明细建立，沟通记录永久保留</span
      ><el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[20, 50, 100]"
        :disabled="loading"
        layout="total, sizes, prev, pager, next"
        @current-change="loadList"
        @size-change="resize"
      />
    </div>
  </section>
  <AfterSaleDrawer
    ref="drawer"
    :ticket-id="route.query.ticket"
    @close="close"
    @changed="loadList"
  />
  <LossMarkDialog
    v-if="lossItems"
    :items="lossItems"
    :is-loss="lossValue"
    @close="lossItems = null"
    @saved="lossSaved"
  />
</template>
<style scoped>
.after-sale-page {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: white;
  border-radius: 8px;
  padding: 16px;
  gap: 16px;
}
.after-sale-heading,
.after-sale-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.after-sale-heading {
  flex-wrap: wrap;
}
.after-sale-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.after-sale-toolbar .el-button {
  margin-left: 0;
}
.after-sale-table :deep(.el-table__body tr.loss-mark-row > td.el-table__cell) {
  background-color: #fef0f0;
  color: #c45656;
}
h2 {
  margin: 0;
  font-size: 16px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.after-sale-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.after-sale-filters .el-input {
  width: 360px;
  max-width: 100%;
}
.after-sale-filters .el-select {
  width: 160px;
}
.after-sale-filters .created-date-filter {
  flex: 0 1 390px;
  max-width: 100%;
}
.after-sale-filters .store-owner-select {
  width: 210px;
}
.after-sale-filters .el-button + .el-button {
  margin-left: 0;
}
.after-sale-table {
  flex: 1;
  min-height: 0;
}
.after-sale-row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.after-sale-row-actions .el-button + .el-button {
  margin-left: 0;
}
.after-sale-footer {
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
</style>
