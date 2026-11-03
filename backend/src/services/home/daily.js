import { amountText, amountUnits, pstDay, yesterdayRange } from './statistics.js';
import { WALMART_ORDER_START_MS } from '../walmart/order-range.js';
import { reconciliationTotals } from './reconciliation.js';

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

/** 每家店铺一次扫描同时生成 30 天报表；同店铺订单跨 SKU 去重。 */
export function createDailyStatistics(now = Date.now(), reconciliation) {
  const refunds = reconciliationTotals(reconciliation);
  const days = new Map(
    dailyDates(now).map((date) => [
      date,
      {
        date,
        orders: new Set(),
        wfs: new Set(),
        sales: 0n,
        refund: 0n,
        reviewed: 0,
        unallocatable: 0,
        purchasing: 0,
        purchaseFailed: 0,
        virtualShipped: 0,
      },
    ]),
  );
  return {
    add(row) {
      const time = Number(row.walmart?.orderDate);
      if (!Number.isFinite(time) || time < WALMART_ORDER_START_MS || time > Number(now)) return;
      const day = days.get(pstDay(time));
      if (!day) return;
      if (!day.orders.has(row.order.orderNumber))
        day.refund += amountUnits(refunds.amount(row.order.orderNumber));
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
        ...refunds.state(day.date),
        refundAmount: ['ok', 'partial'].includes(refunds.state(day.date).refundStatus)
          ? amountText(day.refund)
          : null,
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
    const refundReady = ready && rows.every((row) => row.refundAmount != null);
    const refundAvailable = ready && rows.some((row) => row.refundAmount != null);
    const refundComplete = refundReady && rows.every((row) => row.refundStatus === 'ok');
    const unavailable = rows.some((row) => row.refundStatus === 'unavailable');
    const cutoffs = rows
      .map((row) => row.refundAsOf)
      .filter(Boolean)
      .sort();
    return {
      date,
      ready,
      refundStatus: refundComplete
        ? 'ok'
        : refundAvailable
          ? 'partial'
          : unavailable
            ? 'unavailable'
            : 'pending',
      refundAsOf: cutoffs[0] || null,
      refundMessage: refundComplete
        ? `实际退款（含税），各店铺报表最早覆盖至 ${cutoffs[0] || date}，后续退款随官方报表更新`
        : refundAvailable
          ? `仅汇总已取得报表中的实际退款（含税）；${rows.filter((row) => row.refundAmount != null).length}/${rows.length} 家有可用报表，最新账期截止日在 ${cutoffs[0]} 至 ${cutoffs.at(-1)} 之间。缺失及未出账期未计入，0 不代表最终退款为零，请查看店铺明细。`
          : `有 ${rows.filter((row) => row.refundAmount == null).length} 家店铺${unavailable ? '财务对账数据未完整获取' : '尚待官方财务报表覆盖该日期'}，请查看店铺明细`,
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
        refundReady || refundAvailable
          ? amountText(rows.reduce((sum, row) => sum + amountUnits(row.refundAmount), 0n))
          : null,
    };
  });
  return { daily, dailyStores, startDate: dates.at(-1), endDate: dates[0] };
}
