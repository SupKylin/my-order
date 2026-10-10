import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue';
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
  const loading = ref(false),
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
  const stats = reactive({ total: 0, unassigned: 0, inProgress: 0, afterSales: 0, shops: [] });
  const shippingDates = ref([]);
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
  const syncAfterResume = () => {
    if (!document.hidden && !loading.value && !editor.value && !selected.value.length)
      load(true).catch(() => {});
  };
  const filters = reactive({
    q: '',
    orderNumbers: '',
    shopNames: [],
    orderStatus: '',
    platformOrderStatus: '',
    fulfillmentParty: '',
    purchaseStatus: '',
    purchaseChannel: '',
    priceFactorLevel: '',
    priceType: 'purchaseLinkAmount',
    minPrice: '',
    maxPrice: '',
    storeOwnerId: '',
    allocatable: '',
    supervisorConfirmed: '',
    afterSales: '',
    settlement: '',
    startDate: '',
    endDate: '',
    shipStartDate: '',
    shipEndDate: '',
    shippingWarning: '',
    trackingWarning: '',
    page: 1,
    pageSize: 20,
  });
  const dates = ref([]),
    shipDates = ref([]),
    table = ref();
  /** 只读取当前筛选页；重新查询后清理旧的多选状态。 */
  async function load(background = false) {
    loading.value = true;
    try {
      const result = await orderApi.list({ ...filters, background: background === true });
      if (result.serverNow) {
        serverClock = { time: Date.parse(result.serverNow), received: performance.now() };
        tickClock();
      }
      rows.value = result.rows;
      total.value = result.total;
      shippingDates.value = result.shippingDates || [];
      selected.value = [];
    } finally {
      loading.value = false;
    }
  }
  async function refresh() {
    await load();
    Object.assign(stats, await orderApi.dashboard());
  }
  async function search() {
    filters.page = 1;
    await load();
  }
  async function reset() {
    Object.assign(filters, {
      q: '',
      orderNumbers: '',
      shopNames: [],
      orderStatus: '',
      platformOrderStatus: '',
      fulfillmentParty: '',
      purchaseStatus: '',
      purchaseChannel: '',
      priceFactorLevel: '',
      priceType: 'purchaseLinkAmount',
      minPrice: '',
      maxPrice: '',
      storeOwnerId: '',
      allocatable: '',
      supervisorConfirmed: '',
      afterSales: '',
      settlement: '',
      startDate: '',
      endDate: '',
      shipStartDate: '',
      shipEndDate: '',
      shippingWarning: '',
      trackingWarning: '',
      page: 1,
    });
    dates.value = [];
    shipDates.value = [];
    await load();
  }
  async function cardFilter(kind) {
    Object.assign(filters, { purchaseChannel: '', purchaseStatus: '', page: 1 });
    filters.afterSales = '';
    if (kind === 'unassigned') filters.purchaseChannel = true;
    if (kind === 'progress') filters.purchaseStatus = '采购中';
    if (kind === 'afterSales') filters.afterSales = '是';
    await load();
  }
  async function edit(row) {
    if (row && !canEditOrder(row)) return ElMessage.warning('WFS 订单只读，不能修改');
    editing.value = row ? await api.get(`/orders/${row.id}`) : null;
    editor.value = true;
  }
  async function openAssign(row) {
    // 单行分配独立于表格勾选，避免取消分配弹框后批量删除使用了错误的选择。
    assignmentItems.value = row ? [row] : [...selected.value];
    if (assignmentItems.value.some((item) => !canEditOrder(item)))
      return ElMessage.warning('WFS 订单不能分配采购渠道，请重新选择');
    if (!assignmentItems.value.length) return ElMessage.warning('请先勾选商品明细');
    await meta.load(true);
    assignmentChannels.value = [];
    assignDialog.value = true;
  }
  /** 分配携带每条明细的版本，冲突时由后端拒绝整批覆盖。 */
  async function assign() {
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
  watch(dates, (value) => {
    filters.startDate = value?.[0] || '';
    filters.endDate = value?.[1] || '';
  });
  watch(
    () => route.query.assignedTo,
    async (value) => {
      filters.purchaseChannel = value === 'unassigned' ? true : '';
      await search();
    },
  );
  onMounted(async () => {
    // 数量和明细颜色共用时钟，跨过截止时间时一起更新，无需再次请求全部记录。
    warningTimer = setInterval(tickClock, 1000);
    document.addEventListener('visibilitychange', syncAfterResume);
    await meta.load();
    users.value = await api.get('/order-owners');
    // 兼容旧采购分配页面书签，重定向后仍可查看待分配记录。
    if (route.query.assignedTo === 'unassigned') filters.purchaseChannel = true;
    await refresh();
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
    document.removeEventListener('visibilitychange', syncAfterResume);
  });

  return {
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
    cardFilter,
    edit,
    openAssign,
    assign,
    remove,
  };
}
