<script setup>
import { computed, defineAsyncComponent, ref } from 'vue';
import {
  Search,
  Plus,
  Upload,
  Refresh,
  User,
  Delete,
  Setting,
  Check,
  CircleClose,
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
import { orderColumns } from '../components/orders/orderColumns';
// 弹窗只在打开时挂载，因此不会提前下载编辑表单和图片上传逻辑。
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
  assignee,
  assignBusy,
  deleteBusy,
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
  remove,
} = useOrders();
const storageKey = `my-order-order-columns-${auth.user?.id || 'default'}`;
function savedHiddenColumns() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey));
    return Array.isArray(value) ? value.filter((key) => typeof key === 'string') : [];
  } catch {
    return [];
  }
}
const hiddenColumns = ref(savedHiddenColumns());
const columnDialog = ref(false);
const batchOrderDialog = ref(false);
const batchOrderDraft = ref('');
const exportBusy = ref(false);
const statusDialog = ref(false);
const statusBusy = ref(false);
const statusDraft = ref('');
const statusItems = ref([]);
const advancedFiltersOpen = ref(false);
const operationsOpen = ref(false);
const activeAdvancedFilters = computed(
  () =>
    [
      'trackingWarning',
      'shippingWarning',
      'priceFactorLevel',
      'purchaseChannel',
      'orderStatus',
      'platformOrderStatus',
      'allocatable',
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
const draftColumns = ref([]);
const allColumns = computed(() => orderColumns(meta.fields));
const visibleColumns = computed(() =>
  allColumns.value.filter((field) => !hiddenColumns.value.includes(field.key)),
);
const columnGroups = computed(() => [
  { label: '订单信息', fields: allColumns.value.filter((field) => field.group === 'order') },
  { label: '采购信息', fields: allColumns.value.filter((field) => field.group === 'purchase') },
  {
    label: '其他',
    fields: allColumns.value.filter((field) => !['order', 'purchase'].includes(field.group)),
  },
]);
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
function openColumnDialog() {
  draftColumns.value = visibleColumns.value.map((field) => field.key);
  columnDialog.value = true;
}
function applyColumns() {
  hiddenColumns.value = allColumns.value
    .filter((field) => !draftColumns.value.includes(field.key))
    .map((field) => field.key);
  try {
    localStorage.setItem(storageKey, JSON.stringify(hiddenColumns.value));
  } catch {
    // 浏览器禁用本地存储时仍允许本次页面调整表头。
  }
  columnDialog.value = false;
}
async function exportOrderRows() {
  if (exportBusy.value) return;
  exportBusy.value = true;
  try {
    const file = await orderApi.export(
      { ...filters },
      selected.value.map((row) => row.id),
    );
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    link.href = url;
    link.download = `订单明细-${date}.xlsx`;
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
    <Teleport to="#orders-topbar-warnings">
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
          <el-button :icon="Setting" @click="openColumnDialog">表头选择</el-button
          ><el-button :icon="Refresh" @click="refresh">刷新</el-button>
          <!-- 订单统一由 Walmart API 接入，保留人工新增入口代码。
          <el-button :icon="Plus" @click="edit(null)">新增明细</el-button>
          -->
          <el-button :icon="User" :disabled="!selected.length" @click="openAssign()"
            >分配采购</el-button
          ><el-button
            type="danger"
            plain
            :icon="Delete"
            :disabled="!selected.length || loading"
            :loading="deleteBusy"
            @click="remove()"
            >批量删除</el-button
          >
          <!-- 保留 Excel 订单导入代码，暂不开放入口。
          <el-button type="primary" :icon="Upload" @click="router.push('/imports/new')">导入订单</el-button>
          -->
          <el-button :icon="Download" :loading="exportBusy" @click="exportOrderRows"
            >导出订单</el-button
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
          ><el-select v-model="filters.assignedTo" placeholder="全部采购人员" clearable
            ><el-option label="待分配" value="unassigned" /><el-option
              v-for="user in users.filter((u) => u.active)"
              :key="user.id"
              :label="`${user.username} · ${user.displayName}`"
              :value="user.id"
          /></el-select>
        </div>
        <div v-show="advancedFiltersOpen" class="filter-bar filter-secondary">
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
          <el-select v-model="filters.orderStatus" placeholder="运营订单状态" clearable
            ><el-option
              v-for="status in meta.fieldMap.orderStatus?.options"
              :key="status"
              :label="status"
              :value="status" /></el-select
          ><el-select v-model="filters.allocatable" placeholder="是否可分配" clearable
            ><el-option label="是" value="是" /><el-option label="否" value="否" /></el-select
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
            <el-option label="商品价格" value="purchaseLinkAmount" />
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
              filters.assignedTo = auth.user.id;
              search();
            "
            >只看分配给我的</el-button
          >
        </div>
      </div>
      <div v-if="selected.length" class="selection-bar">
        <span
          >已选中 <strong>{{ selected.length }}</strong> 条商品明细</span
        ><el-button type="primary" size="small" :icon="User" @click="openAssign()"
          >批量分配采购</el-button
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
          :deleting="deleteBusy"
          :show-operations="operationsOpen"
          :warning-now="warningNow"
          @selection-change="selected = $event"
          @edit="edit"
          @assign="openAssign"
          @delete="remove"
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
    v-model:assignee="assignee"
    :count="assignmentItems.length"
    :users="users"
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
  <el-dialog v-model="columnDialog" title="表头选择" width="520px" class="column-settings-dialog">
    <div class="column-settings-toolbar">
      <span class="muted">已勾选 {{ draftColumns.length }} / {{ allColumns.length }} 列</span>
      <div>
        <el-button text :icon="Check" @click="draftColumns = allColumns.map((field) => field.key)"
          >全选</el-button
        >
        <el-button text :icon="CircleClose" @click="draftColumns = []">清除勾选</el-button>
      </div>
    </div>
    <el-checkbox-group v-model="draftColumns" class="column-settings-list">
      <div v-for="group in columnGroups" :key="group.label" class="column-settings-group">
        <strong>{{ group.label }}</strong>
        <div class="column-settings-options">
          <el-checkbox v-for="field in group.fields" :key="field.key" :value="field.key">
            {{ field.label }}
          </el-checkbox>
        </div>
      </div>
    </el-checkbox-group>
    <template #footer>
      <el-button @click="columnDialog = false">取消</el-button>
      <el-button type="primary" @click="applyColumns">应用</el-button>
    </template>
  </el-dialog>
</template>
