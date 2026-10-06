import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { orderApi } from '../api/orders';
import { userApi } from '../api/users';
import { useMeta } from '../stores/meta';
import { useAuth } from '../stores/auth';
import { countShippingWarnings } from '../utils/shippingWarning';

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
    assignee = ref(''),
    assignBusy = ref(false),
    deleteBusy = ref(false);
  const stats = reactive({ total: 0, unassigned: 0, inProgress: 0, afterSales: 0, shops: [] });
  const shippingDates = ref([]);
  const warningNow = ref(Date.now());
  const shippingCounts = computed(() =>
    countShippingWarnings(shippingDates.value, warningNow.value),
  );
  let warningTimer;
  const filters = reactive({
    q: '',
    shopName: '',
    orderStatus: '',
    purchaseStatus: '',
    purchaseChannel: '',
    priceFactorLevel: '',
    priceType: 'purchaseLinkAmount',
    minPrice: '',
    maxPrice: '',
    assignedTo: '',
    allocatable: '',
    settlement: '',
    startDate: '',
    endDate: '',
    shipStartDate: '',
    shipEndDate: '',
    page: 1,
    pageSize: 20,
  });
  const dates = ref([]),
    shipDates = ref([]),
    table = ref();
  const afterSales = ref('');
  /** 只读取当前筛选页；重新查询后清理旧的多选状态。 */
  async function load() {
    loading.value = true;
    try {
      const result = await orderApi.list({ ...filters, afterSales: afterSales.value });
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
      shopName: '',
      orderStatus: '',
      purchaseStatus: '',
      purchaseChannel: '',
      priceFactorLevel: '',
      priceType: 'purchaseLinkAmount',
      minPrice: '',
      maxPrice: '',
      assignedTo: '',
      allocatable: '',
      settlement: '',
      startDate: '',
      endDate: '',
      shipStartDate: '',
      shipEndDate: '',
      page: 1,
    });
    dates.value = [];
    shipDates.value = [];
    afterSales.value = '';
    await load();
  }
  async function cardFilter(kind) {
    Object.assign(filters, { assignedTo: '', purchaseStatus: '', page: 1 });
    afterSales.value = '';
    if (kind === 'unassigned') filters.assignedTo = 'unassigned';
    if (kind === 'progress') filters.purchaseStatus = '采购中';
    if (kind === 'afterSales') afterSales.value = '是';
    await load();
  }
  function edit(row) {
    editing.value = row ? { ...row } : null;
    editor.value = true;
  }
  async function openAssign(row) {
    // 单行分配独立于表格勾选，避免取消分配弹框后批量删除使用了错误的选择。
    assignmentItems.value = row ? [row] : [...selected.value];
    if (!assignmentItems.value.length) return ElMessage.warning('请先勾选商品明细');
    users.value = await userApi.list();
    assignee.value = '';
    assignDialog.value = true;
  }
  /** 分配携带每条明细的版本，冲突时由后端拒绝整批覆盖。 */
  async function assign() {
    if (assignee.value === '') return ElMessage.warning('请先选择采购人员或明确选择取消分配');
    assignBusy.value = true;
    try {
      await orderApi.assign(
        assignmentItems.value.map((item) => ({ id: item.id, version: item.version })),
        assignee.value === 'unassign' ? null : assignee.value,
      );
      ElMessage.success(assignee.value === 'unassign' ? '已取消采购分配' : '采购人员已分配');
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
      filters.assignedTo = value === 'unassigned' ? 'unassigned' : '';
      await search();
    },
  );
  onMounted(async () => {
    // 数量和明细颜色共用时钟，跨过截止时间时一起更新，无需再次请求全部记录。
    warningTimer = setInterval(() => (warningNow.value = Date.now()), 1000);
    await meta.load();
    users.value = await userApi.list();
    // 兼容旧采购分配页面书签，重定向后仍可查看待分配记录。
    if (route.query.assignedTo === 'unassigned') filters.assignedTo = 'unassigned';
    await refresh();
  });
  onUnmounted(() => clearInterval(warningTimer));

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
    cardFilter,
    edit,
    openAssign,
    assign,
    remove,
  };
}
