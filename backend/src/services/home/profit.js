import { dailyDates } from './daily.js';
import { pstDay } from './statistics.js';
import { WALMART_ORDER_START_MS } from '../walmart/order-range.js';
import { itemProfit, isCancelledItem, moneyUnits, moneyText } from '../../lib/order-profit.js';

const DAY = 86400000;
function period(date, type) {
  if (type === 'month') {
    const start = date.slice(0, 7) + '-01';
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return { start, end: new Date(d.getTime() - DAY).toISOString().slice(0, 10) };
  }
  const d = new Date(`${date}T00:00:00Z`);
  const startMs = d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY;
  return {
    start: new Date(startMs).toISOString().slice(0, 10),
    end: new Date(startMs + 6 * DAY).toISOString().slice(0, 10),
  };
}
const counts = ['eligibleItems', 'calculatedItems', 'uncomputedItems', 'cancelledItems'];
const blank = () => ({
  eligibleItems: 0,
  calculatedItems: 0,
  uncomputedItems: 0,
  cancelledItems: 0,
  sales: 0n,
  commission: 0n,
  cost: 0n,
  walmartRefund: 0n,
  purchaseRefund: 0n,
  dispute: 0n,
  profit: 0n,
});
function result(row) {
  const available = row.calculatedItems > 0 || row.eligibleItems === 0;
  return {
    ...Object.fromEntries(counts.map((key) => [key, row[key]])),
    salesAmount: available ? moneyText(row.sales) : null,
    commissionAmount: available ? moneyText(row.commission) : null,
    purchaseCost: available ? moneyText(row.cost) : null,
    walmartRefundAmount: available ? moneyText(row.walmartRefund) : null,
    purchaseRefundAmount: available ? moneyText(row.purchaseRefund) : null,
    disputeSuccessAmount: available ? moneyText(row.dispute) : null,
    orderProfit: available ? moneyText(row.profit) : null,
  };
}

/** 与订单列表共用利润公式；只累计资料完整的明细，未计算及取消条数单独展示。 */
export function createProfitStatistics(now = Date.now(), range = null) {
  const dates = dailyDates(now, range);
  const days = new Set(dates);
  const groups = Object.fromEntries(['week', 'month'].map((type) => [type, new Map()]));
  for (const date of dates)
    for (const type of ['week', 'month']) {
      const p = period(date, type);
      if (!groups[type].has(p.start))
        groups[type].set(p.start, { ...p, ...blank(), statisticStart: date, statisticEnd: date });
      const row = groups[type].get(p.start);
      if (date < row.statisticStart) row.statisticStart = date;
      if (date > row.statisticEnd) row.statisticEnd = date;
    }
  return {
    add(item) {
      const time = Number(item.walmart?.orderDate);
      if (
        !Number.isFinite(time) ||
        time < WALMART_ORDER_START_MS ||
        time > Number(now) ||
        !days.has(pstDay(time))
      )
        return;
      const calculation = itemProfit(item);
      for (const type of ['week', 'month']) {
        const row = groups[type].get(period(pstDay(time), type).start);
        if (isCancelledItem(item)) {
          row.cancelledItems++;
          continue;
        }
        row.eligibleItems++;
        if (calculation.orderProfit == null) {
          row.uncomputedItems++;
          continue;
        }
        row.calculatedItems++;
        row.sales += moneyUnits(item.orderAmount);
        row.commission += moneyUnits(calculation.commissionAmount);
        row.cost += moneyUnits(item.purchase.purchaseCost);
        row.walmartRefund += moneyUnits(calculation.walmartRefundAmount) ?? 0n;
        row.purchaseRefund += moneyUnits(calculation.purchaseRefundAmount) ?? 0n;
        row.dispute += moneyUnits(calculation.disputeSuccessAmount) ?? 0n;
        row.profit += moneyUnits(calculation.orderProfit);
      }
    },
    result() {
      return Object.fromEntries(
        ['week', 'month'].map((type) => [
          type,
          [...groups[type].values()].map((row) => ({
            periodStart: row.start,
            periodEnd: row.end,
            statisticStart: row.statisticStart,
            statisticEnd: row.statisticEnd,
            ...result(row),
          })),
        ]),
      );
    },
  };
}
export function profitReport(stores) {
  return Object.fromEntries(
    ['week', 'month'].map((type) => {
      const rows = stores
        .flatMap((store) =>
          (store.metrics?.profit?.[type] || []).map((row) => ({
            ...row,
            storeId: store.id,
            name: store.name,
            owner: store.owner,
            isThirdParty: Boolean(store.isThirdParty),
          })),
        )
        .sort(
          (a, b) =>
            b.periodStart.localeCompare(a.periodStart) ||
            a.name.localeCompare(b.name, 'zh-CN') ||
            a.storeId - b.storeId,
        );
      const totals = [false, true].map((isThirdParty) => {
        const total = blank();
        for (const row of rows.filter((entry) => entry.isThirdParty === isThirdParty)) {
          for (const key of counts) total[key] += row[key];
          for (const [key, field] of [
            ['sales', 'salesAmount'],
            ['commission', 'commissionAmount'],
            ['cost', 'purchaseCost'],
            ['walmartRefund', 'walmartRefundAmount'],
            ['purchaseRefund', 'purchaseRefundAmount'],
            ['dispute', 'disputeSuccessAmount'],
            ['profit', 'orderProfit'],
          ])
            total[key] += moneyUnits(row[field]) ?? 0n;
        }
        return { isThirdParty, ...result(total) };
      });
      return [type, { rows, totals }];
    }),
  );
}
