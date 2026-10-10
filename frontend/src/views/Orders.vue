<script setup>
import { computed, defineAsyncComponent, ref } from 'vue';
import {
  Search,
  Plus,
  Upload,
  Refresh,
  User,
  Setting,
  Download,
  CopyDocument,
  EditPen,
  ArrowDown,
  ArrowUp,
} from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { useOrders } from '../composables/useOrders';
import { orderApi } from '../api/orders';
import OrderTable from '../components/orders/OrderTable.vue';
import { canEditOrder } from '../utils/orderWritePolicy';
import { useOrderTablePreferences } from '../composables/useOrderTablePreferences';
import { orderColumns } from '../components/orders/orderColumns';
// 弹窗只在打开时挂载，因此不会提前下载编辑表单和图片上传逻辑。
const OrderColumnSettings = defineAsyncComponent(
  () => import('../components/orders/OrderColumnSettings.vue'),
);
const OrderEditor = defineAsyncComponent(() => import('../components/OrderEditor.vue'));
const AssignmentDialog = defineAsyncComponent(
  () => import('../components/orders/AssignmentDialog.vue'),
);
const {
  router,
  meta,
  auth,
  loading,
  rows,
  total,
  selected,
  users,
  editing,
  editor,
  assignDialog,
  assignmentItems,
  assignmentChannels,
  assignBusy,
  stats,
  shippingCounts,
  warningNow,
  filters,
  dates,
  shipDates,
  table,
  load,
  refresh,
  search,
  reset,
  edit,
  openAssign,
  assign,
} = useOrders();
const columnDialog = ref(false);
const batchOrderDialog = ref(false);
const batchOrderDraft = ref('');
const exportBusy = ref(false);
const exportMessage = ref('');
const statusDialog = ref(false);
const statusBusy = ref(false);
const statusDraft = ref('');
const statusItems = ref([]);
const advancedFiltersOpen = ref(false);
const operationsOpen = ref(true);
const activeAdvancedFilters = computed(
  () =>
    [
      'trackingWarning',
      'shippingWarning',
      'priceFactorLevel',
      'purchaseChannel',
      'orderStatus',
      'platformOrderStatus',
      'fulfillmentParty',
      'allocatable',
      'supervisorConfirmed',
      'afterSales',
      'settlement',
      'startDate',
      'endDate',
      'shipStartDate',
      'shipEndDate',
      'minPrice',
      'maxPrice',
    ].filter((key) => filters[key] !== '').length,
);
const allColumns = computed(() => orderColumns(meta.fields));
const {
  ordered: orderedColumns,
  visible: visibleColumns,
  ready: columnsReady,
  saving: columnsSaving,
  save: saveColumns,
  load: loadColumns,
} = useOrderTablePreferences(auth, allColumns);
const batchOrderCount = computed(
  () => new Set(filters.orderNumbers.trim().split(/\s+/).filter(Boolean)).size,
);
function openBatchOrderDialog() {
  batchOrderDraft.value = filters.orderNumbers;
  batchOrderDialog.value = true;
}
async function applyBatchOrderSearch() {
  const numbers = [...new Set(batchOrderDraft.value.trim().split(/\s+/).filter(Boolean))];
  if (numbers.length > 200 || numbers.some((number) => number.length > 191))
    return ElMessage.warning('单次最多查询 200 个订单号，每个订单号最多 191 个字符');
  filters.orderNumbers = numbers.join(' ');
  filters.q = '';
  batchOrderDialog.value = false;
  await search();
}
async function openColumnDialog() {
  await meta.load();
  if (!columnsReady.value) await loadColumns();
  if (columnsReady.value) columnDialog.value = true;
}
async function applyColumns(value) {
  if (await saveColumns(value)) {
    columnDialog.value = false;
    ElMessage.success('表头设置已保存到当前账号');
  }
}
async function exportOrderRows(purchaseTemplate = false) {
  if (exportBusy.value) return;
  exportBusy.value = true;
  exportMessage.value = '正在查询符合筛选条件的订单…';
  // HTTP 站点也可使用，不依赖仅安全上下文提供的 crypto.randomUUID。
  const exportId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
  let polling = true;
  let timer;
  const poll = async () => {
    try {
      const state = await orderApi.exportProgress(exportId);
      if (!polling) return;
      if (state.stage === 'images')
        exportMessage.value = `正在准备图片 ${state.completedImages}/${state.imageCount}，已整理 ${state.completedRows}/${state.totalRows} 条订单`;
      if (state.stage === 'packing')
        exportMessage.value = `正在生成 Excel，共 ${state.totalRows} 条订单…`;
      if (state.stage === 'done') exportMessage.value = '文件已生成，正在下载…';
    } catch {
      /* 进度请求失败不影响正在执行的文件下载。 */
    }
    if (polling) timer = setTimeout(poll, 1000);
  };
  timer = setTimeout(poll, 700);
  try {
    const file = await orderApi.export({ ...filters }, purchaseTemplate, exportId);
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    link.href = url;
    link.download = `${purchaseTemplate ? '采购信息填写模板' : '订单明细'}-${date}.xlsx`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (error) {
    let message = '导出失败，请稍后重试';
    try {
      message = JSON.parse(await error.response?.data?.text()).message || message;
    } catch {
      if (error.code === 'ECONNABORTED') message = '导出超时，请缩小筛选范围后重试';
    }
    ElMessage.error(message);
  } finally {
    polling = false;
    clearTimeout(timer);
    exportMessage.value = '';
    exportBusy.value = false;
  }
}
async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // HTTP 测试站或剪贴板权限受限时，尝试浏览器的复制命令。
    }
  }
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
  } finally {
    input.remove();
  }
}
async function copyTrackingNumbers() {
  const selectedIds = new Set(selected.value.map((row) => row.id));
  const numbers = rows.value
    .filter((row) => selectedIds.has(row.id))
    .map((row) => String(row.trackingNumber ?? '').trim())
    .filter(Boolean);
  if (!numbers.length) return ElMessage.warning('所选明细均未填写物流单号');
  try {
    await writeClipboard(numbers.join('\n'));
    const skipped = selected.value.length - numbers.length;
    ElMessage.success(
      `已复制 ${numbers.length} 个物流单号${skipped ? `，跳过 ${skipped} 条未填写的明细` : ''}`,
    );
  } catch {
    ElMessage.error('复制失败，请检查浏览器剪贴板权限');
  }
}
function openStatusDialog() {
  if (selected.value.some((item) => !canEditOrder(item)))
    return ElMessage.warning('WFS 订单不能修改状态，请重新选择');
  statusItems.value = selected.value.map(({ id, version }) => ({ id, version }));
  if (!statusItems.value.length) return ElMessage.warning('请先勾选商品明细');
  statusDraft.value = '';
  statusDialog.value = true;
}
async function submitStatus() {
  if (!statusDraft.value) return ElMessage.warning('请选择运营订单状态');
  if (statusBusy.value) return;
  statusBusy.value = true;
  try {
    const result = await orderApi.updateStatus(statusItems.value, statusDraft.value);
    statusDialog.value = false;
    table.value?.clearSelection();
    ElMessage.success(`已更新 ${result.updated} 条商品明细的运营订单状态`);
    await refresh();
  } finally {
    statusBusy.value = false;
  }
}
</script>
<template>
  <div class="orders-page">
    <!-- Wait for the authenticated layout to mount its warning anchor. -->
    <Teleport to="#orders-topbar-warnings" defer>
      <div class="shipping-legend">
        <strong>发货预警：</strong>
        <span class="shipping-badge shipping-yellow"
          >黄色≤48小时（{{ shippingCounts.yellow }} 条）</span
        >
        <span>·</span>
        <span class="shipping-badge shipping-orange"
          >橙色≤24小时（{{ shippingCounts.orange }} 条）</span
        >
        <span>·</span>
        <span class="shipping-badge shipping-red">红色=已逾期（{{ shippingCounts.red }} 条）</span>
        <span
          class="muted shipping-legend-note"
          title="仅统计当前筛选中平台订单状态为已确认的明细，以平台发货日期后一天 15:00（北京时间）为截止时间"
          >仅已确认订单，以平台发货日期后一天 15:00（北京时间）为截止时间</span
        >
      </div>
    </Teleport>
    <div v-if="exportBusy" role="status" aria-live="polite" class="muted">{{ exportMessage }}</div>
    <section class="panel orders-panel">
      <div class="panel-heading">
        <div class="orders-heading-title">
          <h2>
            订单商品明细<span class="count-label">{{ total }} 条</span>
          </h2>
          <el-button
            type="primary"
            class="advanced-filter-toggle"
            :icon="advancedFiltersOpen ? ArrowUp : ArrowDown"
            :aria-expanded="advancedFiltersOpen"
            @click="advancedFiltersOpen = !advancedFiltersOpen"
            >{{ advancedFiltersOpen ? '收起筛选' : '更多筛选'
            }}{{ activeAdvancedFilters ? ` (${activeAdvancedFilters})` : '' }}</el-button
          >
        </div>
        <div class="button-row">
          <el-button
            type="primary"
            plain
            :icon="EditPen"
            :aria-expanded="operationsOpen"
            @click="operationsOpen = !operationsOpen"
            >{{ operationsOpen ? '收起操作' : '展开操作' }}</el-button
          >
          <el-button :icon="Setting" @click="openColumnDialog">表头设置</el-button
          ><el-button :icon="Refresh" @click="refresh">刷新</el-button>
          <!-- 订单统一由 Walmart API 接入，保留人工新增入口代码。
          <el-button :icon="Plus" @click="edit(null)">新增明细</el-button>
          -->
          <el-button :icon="User" :disabled="!selected.length" @click="openAssign()"
            >批量分配采购渠道</el-button
          >
          <!-- 保留 Excel 订单导入代码，暂不开放入口。
          <el-button type="primary" :icon="Upload" @click="router.push('/imports/new')">导入订单</el-button>
          -->
          <el-button :icon="Download" :loading="exportBusy" @click="exportOrderRows()"
            >导出订单</el-button
          >
          <el-button :icon="Download" :loading="exportBusy" @click="exportOrderRows(true)"
            >导出数据填写采购信息</el-button
          >
        </div>
      </div>
      <div class="orders-filters">
        <div class="filter-bar">
          <el-input
            v-model="filters.q"
            :prefix-icon="Search"
            clearable
            placeholder="搜索订单号、WalmartSku、采购Sku、商品或物流单号"
            class="search-input"
            @keyup.enter="search"
          /><el-button :icon="Search" @click="openBatchOrderDialog"
            >批量订单号{{ batchOrderCount ? ` (${batchOrderCount})` : '' }}</el-button
          ><el-select
            v-model="filters.shopNames"
            placeholder="全部店铺"
            aria-label="店铺多选筛选"
            clearable
            filterable
            multiple
            collapse-tags
            collapse-tags-tooltip
            ><el-option
              v-for="shop in stats.shops"
              :key="shop"
              :label="shop"
              :value="shop" /></el-select
          ><el-select v-model="filters.purchaseStatus" placeholder="采购状态" clearable
            ><el-option
              v-for="status in meta.fieldMap.purchaseStatus?.options"
              :key="status"
              :label="status"
              :value="status" /></el-select
          ><el-select v-model="filters.storeOwnerId" placeholder="店铺所属账号" clearable filterable
            ><el-option label="未绑定" value="unbound" /><el-option
              v-for="user in users"
              :key="user.id"
              :label="`${user.username} · ${user.displayName}`"
              :value="user.id"
          /></el-select>
        </div>
        <div v-show="advancedFiltersOpen" class="filter-bar filter-secondary">
          <el-select
            v-model="filters.fulfillmentParty"
            placeholder="履约方"
            aria-label="履约方筛选"
            clearable
            @change="search"
          >
            <el-option label="WFS" value="WFS" />
            <el-option label="卖家履约（SellerFulfilled）" value="SellerFulfilled" />
            <el-option label="第三方履约（3PLFulfilled）" value="3PLFulfilled" />
          </el-select>
          <el-select
            v-model="filters.trackingWarning"
            placeholder="未出跟踪号"
            aria-label="未出跟踪号筛选"
            clearable
            @change="search"
          >
            <el-option label="未出跟踪号（全部）" value="all" />
            <el-option label="待填单号（不足24小时）" value="waiting" />
            <el-option label="黄色提醒（24至48小时）" value="yellow" />
            <el-option label="强制处理（满48小时）" value="red" />
          </el-select>
          <el-select
            v-model="filters.shippingWarning"
            placeholder="全部发货预警"
            aria-label="发货预警筛选"
            class="shipping-warning-filter"
            clearable
            @change="search"
          >
            <el-option label="24小时内发货（橙色）" value="orange" />
            <el-option label="已逾期（红色）" value="red" />
          </el-select>
          <el-select
            v-model="filters.priceFactorLevel"
            placeholder="价格系数等级"
            aria-label="价格系数等级"
            clearable
            @change="search"
          >
            <el-option label="低（< 0.8）" value="low" />
            <el-option label="平（0.8 ≤ 系数 < 0.85）" value="medium" />
            <el-option label="高（≥ 0.85）" value="high" />
          </el-select>
          <el-select v-model="filters.purchaseChannel" placeholder="采购渠道" clearable filterable>
            <el-option label="未分配" :value="true" />
            <el-option
              v-for="channel in meta.fieldMap.purchaseChannel?.options"
              :key="channel"
              :label="channel"
              :value="channel"
            />
          </el-select>
          <el-select
            v-model="filters.platformOrderStatus"
            placeholder="平台订单状态"
            aria-label="平台订单状态筛选"
            clearable
            @change="search"
          >
            <el-option
              v-for="status in ['待确认', '已确认', '已发货', '已取消', '已送达']"
              :key="status"
              :label="status"
              :value="status"
            />
          </el-select>
          <el-select
            v-model="filters.supervisorConfirmed"
            placeholder="主管确认"
            aria-label="主管确认筛选"
            clearable
          >
            <el-option
              v-for="option in meta.fieldMap.supervisorConfirmed?.options"
              :key="option"
              :label="option"
              :value="option"
            />
          </el-select>
          <el-select v-model="filters.orderStatus" placeholder="运营订单状态" clearable
            ><el-option
              v-for="status in meta.fieldMap.orderStatus?.options"
              :key="status"
              :label="status"
              :value="status" /></el-select
          ><el-select v-model="filters.allocatable" placeholder="是否可分配" clearable
            ><el-option label="是" value="是" /><el-option label="否" value="否" /><el-option
              label="未分配"
              value="empty" /></el-select
          ><el-select v-model="filters.afterSales" placeholder="是否售后" clearable
            ><el-option label="是" value="是" /><el-option label="否" value="否" /></el-select
          ><el-select v-model="filters.settlement" placeholder="结算情况" clearable
            ><el-option label="已结算" value="已结算" /><el-option
              label="未结算"
              value="未结算" /></el-select
          ><el-date-picker
            v-model="dates"
            type="daterange"
            value-format="YYYY-MM-DD"
            start-placeholder="出单开始日期"
            end-placeholder="出单结束日期"
            range-separator="至"
          /><el-date-picker
            v-model="shipDates"
            type="daterange"
            value-format="YYYY-MM-DD"
            start-placeholder="平台发货开始日期"
            end-placeholder="平台发货结束日期"
            range-separator="至"
          />
        </div>
        <div v-show="advancedFiltersOpen" class="filter-bar filter-price">
          <el-select v-model="filters.priceType" aria-label="价格类型">
            <el-option label="采购商品链接金额" value="purchaseLinkAmount" />
            <el-option label="订单金额" value="orderAmount" />
            <el-option label="采购限价" value="purchaseLimit" />
          </el-select>
          <div class="price-range-inputs">
            <el-input
              v-model="filters.minPrice"
              aria-label="最低价格"
              inputmode="decimal"
              clearable
              placeholder="最低价格"
              @keyup.enter="search"
            />
            <span class="price-range-separator">至</span>
            <el-input
              v-model="filters.maxPrice"
              aria-label="最高价格"
              inputmode="decimal"
              clearable
              placeholder="最高价格"
              @keyup.enter="search"
            />
          </div>
        </div>
        <div class="filter-actions">
          <el-button type="primary" plain :icon="Search" @click="search">查询</el-button>
          <el-button text @click="reset">重置</el-button>
          <el-button
            text
            type="primary"
            @click="
              filters.storeOwnerId = auth.user.id;
              search();
            "
            >只看我的店铺</el-button
          >
        </div>
      </div>
      <div v-if="selected.length" class="selection-bar">
        <span
          >已选中 <strong>{{ selected.length }}</strong> 条商品明细</span
        ><el-button type="primary" size="small" :icon="User" @click="openAssign()"
          >批量分配采购渠道</el-button
        ><el-button size="small" :icon="EditPen" @click="openStatusDialog"
          >批量更改运营订单状态</el-button
        ><el-button size="small" :icon="CopyDocument" @click="copyTrackingNumbers"
          >复制物流单号</el-button
        ><el-button text size="small" @click="table.clearSelection()">取消选择</el-button>
      </div>
      <div class="order-table-region">
        <OrderTable
          ref="table"
          :columns="visibleColumns"
          :rows="rows"
          :loading="loading"
          :show-operations="operationsOpen"
          :warning-now="warningNow"
          @selection-change="selected = $event"
          @edit="edit"
          @assign="openAssign"
        />
      </div>
      <div class="table-footer">
        <span class="muted">订单来源：Walmart 官方接口 · 采购导入仅更新已有明细</span
        ><el-pagination
          v-model:current-page="filters.page"
          v-model:page-size="filters.pageSize"
          :total="total"
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          @current-change="load"
          @size-change="search"
        />
      </div>
    </section>
  </div>
  <OrderEditor v-if="editor" v-model="editor" :item="editing" @saved="refresh" />
  <AssignmentDialog
    v-if="assignDialog"
    v-model="assignDialog"
    v-model:channels="assignmentChannels"
    :count="assignmentItems.length"
    :assign-busy="assignBusy"
    @submit="assign"
  />
  <el-dialog
    v-model="statusDialog"
    title="批量更改运营订单状态"
    width="460px"
    :close-on-click-modal="!statusBusy"
    :close-on-press-escape="!statusBusy"
    :show-close="!statusBusy"
  >
    <p class="dialog-description">将选中的 {{ statusItems.length }} 条商品明细更改为：</p>
    <el-select
      v-model="statusDraft"
      placeholder="选择运营订单状态"
      aria-label="批量选择运营订单状态"
      filterable
      style="width: 100%"
    >
      <el-option
        v-for="status in meta.fieldMap.orderStatus?.options"
        :key="status"
        :label="status"
        :value="status"
      />
    </el-select>
    <template #footer>
      <el-button :disabled="statusBusy" @click="statusDialog = false">取消</el-button>
      <el-button type="primary" :loading="statusBusy" @click="submitStatus">确认更改</el-button>
    </template>
  </el-dialog>
  <el-dialog
    v-model="batchOrderDialog"
    title="批量搜索订单号"
    width="520px"
    class="batch-order-dialog"
  >
    <el-input
      v-model="batchOrderDraft"
      type="textarea"
      :rows="8"
      resize="vertical"
      placeholder="粘贴订单号，用换行或空格分隔"
      aria-label="批量订单号"
    />
    <template #footer>
      <el-button @click="batchOrderDialog = false">取消</el-button>
      <el-button @click="batchOrderDraft = ''">清空</el-button>
      <el-button type="primary" @click="applyBatchOrderSearch">查询</el-button>
    </template>
  </el-dialog>
  <OrderColumnSettings
    v-if="columnDialog"
    :columns="orderedColumns"
    :visible="visibleColumns"
    :saving="columnsSaving"
    @close="columnDialog = false"
    @save="applyColumns"
  />
</template>
