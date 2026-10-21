import { amountText, amountUnits, pstDay, yesterdayRange } from './statistics.js';
import { WALMART_ORDER_START_MS } from '../walmart/order-range.js';

export const DAILY_COUNTS = [
  'totalOrders',
  'wfsOrders',
  'reviewed',
  'unallocatable',
  'purchasing',
  'purchaseFailed',
  'virtualShipped',
];
export const DAILY_METRICS = ['totalSales', ...DAILY_COUNTS, 'refundAmount'];

export function dailyDates(now = Date.now()) {
  const end = yesterdayRange(now).end;
  return Array.from({ length: 30 }, (_, i) => pstDay(end - i * 86400000));
}

/** 只读取已保存的官方退款记录，不从取消状态、退货数量或订单金额推算退款。 */
export function refundAmount(line) {
  const refund = line?.refund;
  const charges = refund?.refundCharges?.refundCharge;
  if (!refund?.refundId || !Array.isArray(charges) || !charges.length) return null;
  try {
    let total = 0n;
    for (const entry of charges) {
      const charge = entry.charge;
      const amounts = [charge?.chargeAmount];
      if (charge?.tax != null) amounts.push(charge.tax.taxAmount);
      for (const amount of amounts) {
        if (amount?.currency !== 'USD' || amount.amount == null) return null;
        // 官方退款费用可能为负数；报表展示已退款金额的正数绝对值。
        total += amountUnits(String(amount.amount).replace(/^-/, ''));
      }
    }
    return amountText(total);
  } catch {
    return null;
  }
}

/** 每家店铺一次扫描同时生成 30 天报表；同店铺订单跨 SKU 去重。 */
export function createDailyStatistics(now = Date.now()) {
  const days = new Map(
    dailyDates(now).map((date) => [
      date,
      {
        date,
        orders: new Set(),
        wfs: new Set(),
        sales: 0n,
        refund: 0n,
        refundUnavailable: false,
        reviewed: 0,
        unallocatable: 0,
        purchasing: 0,
        purchaseFailed: 0,
        virtualShipped: 0,
      },
    ]),
  );
  return {
    add(row, rawLine) {
      const time = Number(row.walmart?.orderDate);
      if (!Number.isFinite(time) || time < WALMART_ORDER_START_MS || time > Number(now)) return;
      const day = days.get(pstDay(time));
      if (!day) return;
      day.orders.add(row.order.orderNumber);
      if (['WFS', 'WFSFulfilled'].includes(row.fulfillmentParty))
        day.wfs.add(row.order.orderNumber);
      const statuses = row.walmart?.statuses || [];
      if (!(statuses.length && statuses.every((status) => status === 'Cancelled')))
        day.sales += amountUnits(row.orderAmount);
      const purchase = row.purchase || {};
      if (purchase.reviewStatus === '已审核') day.reviewed++;
      if (purchase.allocatable === '否') day.unallocatable++;
      if (purchase.purchaseStatus === '采购中') day.purchasing++;
      if (purchase.purchaseStatus === '采购失败') day.purchaseFailed++;
      if (row.orderStatus === '已发货，虚拟单号发货') day.virtualShipped++;
      const refund = refundAmount(rawLine);
      if (refund == null) day.refundUnavailable = true;
      else day.refund += amountUnits(refund);
    },
    result() {
      return [...days.values()].map((day) => ({
        date: day.date,
        totalSales: amountText(day.sales),
        totalOrders: day.orders.size,
        wfsOrders: day.wfs.size,
        reviewed: day.reviewed,
        unallocatable: day.unallocatable,
        purchasing: day.purchasing,
        purchaseFailed: day.purchaseFailed,
        virtualShipped: day.virtualShipped,
        refundAmount: day.refundUnavailable ? null : amountText(day.refund),
      }));
    },
  };
}

/** 仅合并本次请求实时计算的授权店铺订单数据，不受平台指标快照时间影响。 */
export function dailyReport(stores, now = Date.now()) {
  const dates = dailyDates(now);
  const dailyStores = [];
  const daily = dates.map((date) => {
    const rows = stores.map((store) => {
      const metric = store.metrics?.daily?.find((row) => row.date === date);
      const row = {
        ...Object.fromEntries(DAILY_METRICS.map((key) => [key, null])),
        ...metric,
        date,
        storeId: store.id,
        name: store.name,
        owner: store.owner,
        ready: Boolean(metric),
        measuredAt: store.measuredAt,
      };
      return row;
    });
    // 日期保持倒序；同一天按销售额排序后再交给前端筛选和分页。
    rows.sort((a, b) => {
      if (a.totalSales == null && b.totalSales != null) return 1;
      if (b.totalSales == null && a.totalSales != null) return -1;
      const difference = amountUnits(b.totalSales) - amountUnits(a.totalSales);
      return (
        (difference > 0n ? 1 : difference < 0n ? -1 : 0) ||
        a.name.localeCompare(b.name, 'zh-CN') ||
        a.storeId - b.storeId
      );
    });
    dailyStores.push(...rows);
    const ready = rows.every((row) => row.ready);
    return {
      date,
      ready,
      ...Object.fromEntries(
        DAILY_COUNTS.map((key) => [
          key,
          ready ? rows.reduce((sum, row) => sum + row[key], 0) : null,
        ]),
      ),
      totalSales: ready
        ? amountText(rows.reduce((sum, row) => sum + amountUnits(row.totalSales), 0n))
        : null,
      refundAmount:
        ready && rows.every((row) => row.refundAmount != null)
          ? amountText(rows.reduce((sum, row) => sum + amountUnits(row.refundAmount), 0n))
          : null,
    };
  });
  return { daily, dailyStores, startDate: dates.at(-1), endDate: dates[0] };
}
