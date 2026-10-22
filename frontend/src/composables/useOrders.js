import { ref, reactive, computed, nextTick, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { orderApi } from '../api/orders';
import { api } from '../api/http';
import { useMeta } from '../stores/meta';
import { useAuth } from '../stores/auth';
import { countShippingWarnings } from '../utils/shippingWarning';
import { canEditOrder } from '../utils/orderWritePolicy';

/** 统一管理订单查询、编辑与采购分配，每次页面挂载独立创建状态。 */
export function useOrders() {
  const route = useRoute(),
    router = useRouter(),
    meta = useMeta(),
    auth = useAuth();
  const listLoading = ref(false),
    initializing = ref(true),
    refreshing = ref(false),
    opening = ref(false),
    rows = ref([]),
    total = ref(0),
    selected = ref([]),
    users = ref([]),
    editing = ref(null),
    editor = ref(false),
    assignDialog = ref(false),
    assignmentItems = ref([]),
    assignmentChannels = ref([]),
    assignBusy = ref(false),
    deleteBusy = ref(false);
  // 列表、初始化和手动刷新分开计时，避免并行请求提前撤掉遮罩。
  const loading = computed(
    () => listLoading.value || initializing.value || refreshing.value || opening.value,
  );
  const stats = reactive({ total: 0, unassigned: 0, inProgress: 0, afterSales: 0, shops: [] });
  const shippingDates = ref([]);
  const assignmentSummary = ref(null);
  const warningNow = ref(Date.now());
  let serverClock = null;
  const tickClock = () => {
    warningNow.value = serverClock
      ? serverClock.time + (performance.now() - serverClock.received)
      : Date.now();
  };
  const shippingCounts = computed(() =>
    countShippingWarnings(shippingDates.value, warningNow.value),
  );
  let warningTimer;
  const filters = reactive({
    q: '',
    orderNumbers: '',
    shopNames: [],
    orderStatus: [],
    platformOrderStatus: '',
    cancellationIntent: '',
    fulfillmentParty: '',
    shippingMode: '',
    purchasePlatforms: [],
    purchaseStatus: [],
    purchaseChannel: [],
    priceFactorLevel: [],
    priceType: 'purchaseLinkAmount',
    minPrice: '',
    maxPrice: '',
    storeOwnerId: '',
    allocatable: '',
    reviewStatus: '',
    supplierAssignmentStatus: '',
    afterSales: '',
    settlement: '',
    startDate: '',
    endDate: '',
    shipStartDate: '',
    shipEndDate: '',
    purchaseAssignedStartTime: '',
    purchaseAssignedEndTime: '',
    shippingWarning: '',
    trackingWarning: [],
    page: 1,
    pageSize: 20,
  });
  const dates = ref([]),
    shipDates = ref([]),
    purchaseAssignedDates = ref([]),
    table = ref();
  // 草稿筛选与已查询条件分开，翻页、刷新和导出不会应用尚未确认的条件。
  const snapshotFilters = () => JSON.parse(JSON.stringify(filters));
  const appliedFilters = ref(snapshotFilters());
  let loadGeneration = 0;
  function clearSelection() {
    selected.value = [];
    table.value?.clearSelection();
  }
  /** 翻页保留勾选；只接受最后一次请求，避免较慢的旧查询覆盖新结果。 */
  async function load(background = false) {
    const generation = ++loadGeneration;
    listLoading.value = true;
    try {
      const result = await orderApi.list({
        ...appliedFilters.value,
        page: filters.page,
        pageSize: filters.pageSize,
        background: background === true,
      });
      if (generation !== loadGeneration) return;
      if (result.serverNow) {
        serverClock = { time: Date.parse(result.serverNow), received: performance.now() };
        tickClock();
      }
      rows.value = result.rows;
      total.value = result.total;
      shippingDates.value = result.shippingDates || [];
      assignmentSummary.value = result.purchaseAssignmentSummary || null;
      await nextTick();
      table.value?.syncSelection();
    } finally {
      if (generation === loadGeneration) listLoading.value = false;
    }
  }
  async function refresh() {
    if (refreshing.value) return;
    refreshing.value = true;
    try {
      clearSelection();
      await load();
      Object.assign(stats, await orderApi.dashboard());
    } finally {
      refreshing.value = false;
    }
  }
  async function search() {
    if (loading.value) return;
    filters.page = 1;
    appliedFilters.value = snapshotFilters();
    clearSelection();
    await load();
  }
  let pageLoadPending = false;
  async function changePage() {
    if (pageLoadPending) return;
    pageLoadPending = true;
    await nextTick();
    pageLoadPending = false;
    await load();
  }
  async function changePageSize() {
    filters.page = 1;
    await changePage();
  }
  async function reset() {
    if (loading.value) return;
    Object.assign(filters, {
      q: '',
      orderNumbers: '',
      shopNames: [],
      orderStatus: [],
      platformOrderStatus: '',
      cancellationIntent: '',
      fulfillmentParty: '',
      shippingMode: '',
      purchasePlatforms: [],
      purchaseStatus: [],
      purchaseChannel: [],
      priceFactorLevel: [],
      priceType: 'purchaseLinkAmount',
      minPrice: '',
      maxPrice: '',
      storeOwnerId: '',
      allocatable: '',
      reviewStatus: '',
      supplierAssignmentStatus: '',
      afterSales: '',
      settlement: '',
      startDate: '',
      endDate: '',
      shipStartDate: '',
      shipEndDate: '',
      purchaseAssignedStartTime: '',
      purchaseAssignedEndTime: '',
      shippingWarning: '',
      trackingWarning: [],
      page: 1,
    });
    dates.value = [];
    shipDates.value = [];
    purchaseAssignedDates.value = [];
    await search();
  }
  async function cardFilter(kind) {
    Object.assign(filters, { purchaseChannel: [], purchaseStatus: [], page: 1 });
    filters.afterSales = '';
    if (kind === 'unassigned') filters.purchaseChannel = [true];
    if (kind === 'progress') filters.purchaseStatus = ['采购中'];
    if (kind === 'afterSales') filters.afterSales = '是';
  }
  async function edit(row) {
    if (opening.value) return;
    if (row && !canEditOrder(row)) return ElMessage.warning('WFS 订单只读，不能修改');
    opening.value = true;
    try {
      editing.value = row ? await api.get(`/orders/${row.id}`) : null;
      editor.value = true;
    } finally {
      opening.value = false;
    }
  }
  async function openAssign(row) {
    if (opening.value) return;
    // 单行分配独立于表格勾选，避免取消分配弹框后批量删除使用了错误的选择。
    assignmentItems.value = row ? [row] : [...selected.value];
    if (assignmentItems.value.some((item) => !canEditOrder(item)))
      return ElMessage.warning('WFS 订单不能分配采购渠道，请重新选择');
    if (!assignmentItems.value.length) return ElMessage.warning('请先勾选商品明细');
    if (assignmentItems.value.some((item) => item.allocatable !== '是'))
      return ElMessage.warning('所选订单包含未审核或不可分配项，请先将是否可分配设置为“是”');
    opening.value = true;
    try {
      await meta.load(true);
      assignmentChannels.value = [];
      assignDialog.value = true;
    } finally {
      opening.value = false;
    }
  }
  /** 分配携带每条明细的版本，冲突时由后端拒绝整批覆盖。 */
  async function assign() {
    if (assignBusy.value) return;
    if (!assignmentChannels.value.length) return ElMessage.warning('请先选择采购渠道');
    assignBusy.value = true;
    try {
      await orderApi.assign(
        assignmentItems.value.map((item) => ({ id: item.id, version: item.version })),
        assignmentChannels.value,
      );
      ElMessage.success('采购渠道已分配');
      assignDialog.value = false;
      await refresh();
    } finally {
      assignBusy.value = false;
    }
  }
  async function remove(row) {
    if (deleteBusy.value) return;
    // 使用确认框打开时的选择及版本快照，避免后续选择变化影响删除目标。
    const entries = (row ? [row] : selected.value).map(({ id, version }) => ({ id, version }));
    if (!entries.length) return ElMessage.warning('请先勾选商品明细');
    deleteBusy.value = true;
    try {
      try {
        await ElMessageBox.confirm(
          `确定删除${row ? `订单 ${row.orderNumber} 的这条商品明细` : `选中的 ${entries.length} 条商品明细`}？关联采购记录也会删除，此操作不可撤销。`,
          row ? '删除商品明细' : '批量删除商品明细',
          {
            type: 'warning',
            confirmButtonText: '确认删除',
            cancelButtonText: '取消',
            confirmButtonClass: 'el-button--danger',
          },
        );
      } catch {
        return;
      }
      const result = row
        ? await orderApi.remove(entries[0].id, entries[0].version)
        : await orderApi.removeMany(entries);
      ElMessage.success(`已删除 ${result.deleted} 条商品明细`);
      filters.page = Math.min(
        filters.page,
        Math.max(1, Math.ceil((total.value - result.deleted) / filters.pageSize)),
      );
      table.value?.clearSelection();
      await refresh();
    } finally {
      deleteBusy.value = false;
    }
  }
  watch(
    shipDates,
    (value) => {
      filters.shipStartDate = value?.[0] || '';
      filters.shipEndDate = value?.[1] || '';
    },
    { flush: 'sync' },
  );
  watch(
    dates,
    (value) => {
      filters.startDate = value?.[0] || '';
      filters.endDate = value?.[1] || '';
    },
    { flush: 'sync' },
  );
  watch(
    purchaseAssignedDates,
    (value) => {
      // 日期区间转换为北京时间整天边界，沿用后端精确时间筛选。
      filters.purchaseAssignedStartTime = value?.[0] ? `${value[0]} 00:00:00` : '';
      filters.purchaseAssignedEndTime = value?.[1] ? `${value[1]} 23:59:59` : '';
    },
    { flush: 'sync' },
  );
  watch(
    () => route.query.assignedTo,
    (value) => {
      filters.purchaseChannel = value === 'unassigned' ? [true] : [];
    },
  );
  onMounted(async () => {
    // 数量和明细颜色共用时钟，跨过截止时间时一起更新，无需再次请求全部记录。
    warningTimer = setInterval(tickClock, 1000);
    try {
      await meta.load();
      users.value = await api.get('/order-owners');
      // 兼容旧采购分配页面书签，重定向后仍可查看待分配记录。
      if (route.query.assignedTo === 'unassigned') filters.purchaseChannel = [true];
      appliedFilters.value = snapshotFilters();
      await refresh();
    } finally {
      initializing.value = false;
    }
  });
  watch(
    () => auth.user?.role,
    async (role, previous) => {
      if (!role || role === previous) return;
      rows.value = [];
      selected.value = [];
      users.value = await api.get('/order-owners');
      await refresh();
    },
  );
  onUnmounted(() => {
    clearInterval(warningTimer);
    loadGeneration += 1;
  });

  return {
    router,
    meta,
    auth,
    loading,
    opening,
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
    deleteBusy,
    stats,
    shippingCounts,
    assignmentSummary,
    warningNow,
    filters,
    appliedFilters,
    dates,
    shipDates,
    table,
    purchaseAssignedDates,
    load,
    refresh,
    search,
    changePageSize,
    changePage,
    reset,
    cardFilter,
    edit,
    openAssign,
    assign,
    remove,
  };
}
