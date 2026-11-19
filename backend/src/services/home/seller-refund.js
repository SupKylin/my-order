import { pstDay } from './statistics.js';
import { moneyUnits, moneyText } from '../../lib/order-profit.js';

export const SELLER_REFUND_VERSION = 1;
const keyOf = (order, sku, po) => JSON.stringify([String(order), String(sku), String(po)]);

/** 一次建立店铺索引；只用 Refund 的贷借项，不把争议赔付混入退款。 */
export function sellerRefundLookup(cache) {
  const groups = new Map();
  const transactions = new Map();
  const invalidOrders = new Set();
  const reports = Object.values(cache?.reports || {});
  const ready =
    cache?.status === 'ok' &&
    reports.length > 0 &&
    reports.every(
      (r) =>
        r.sellerRefundVersion === SELLER_REFUND_VERSION &&
        Array.isArray(r.sellerRefundRows) &&
        r.sellerRefundRows.every((row) => row.order),
    ) &&
    (cache.availableDates || []).every((date) => cache.reports?.[date]);
  for (const report of reports) {
    for (const row of report.sellerRefundRows || []) {
      if (!row.sku || !row.po || !row.transaction) invalidOrders.add(row.order);
      const key = keyOf(row.order, row.sku, row.po);
      if (!groups.has(key)) groups.set(key, { net: 0n, customer: 0n, through: '', invalid: false });
      const group = groups.get(key);
      // 同一交易包含多类金额；只对同一交易同一费用项去重，金额冲突则不自动使用。
      const identity = JSON.stringify([key, row.orderLine || '', row.transaction, row.type]);
      const amount = moneyUnits(row.amount);
      if (!row.transaction || !row.order || !row.sku || !row.po || amount == null) {
        group.invalid = true;
        continue;
      }
      if (transactions.has(identity)) {
        if (transactions.get(identity) !== amount) group.invalid = true;
        continue;
      }
      transactions.set(identity, amount);
      group.net -= amount;
      if (row.customer) group.customer -= amount;
      if (report.end > group.through) group.through = report.end;
    }
  }
  return (item) => {
    if (!ready || invalidOrders.has(String(item.order?.orderNumber))) return null;
    const lines = (item.returnInfo?.lines || []).filter((line) => line.status === '已退款');
    if (!lines.length) return null;
    const expected = new Map(),
      seen = new Map();
    for (const line of lines) {
      const identity = JSON.stringify([line.returnOrderId, line.lineNumber]);
      const amount = moneyUnits(line.amount);
      if (
        !line.returnOrderId ||
        !line.lineNumber ||
        !line.purchaseOrderId ||
        !line.sku ||
        line.currency !== 'USD' ||
        amount == null ||
        amount < 0n
      )
        return null;
      const key = keyOf(item.order?.orderNumber, line.sku, line.purchaseOrderId);
      const signature = JSON.stringify([key, amount.toString(), line.completedAt]);
      if (seen.has(identity)) {
        if (seen.get(identity) !== signature) return null;
        continue;
      }
      seen.set(identity, signature);
      const completed = Date.parse(line.completedAt);
      if (
        !Number.isFinite(completed) ||
        !groups.get(key)?.through ||
        pstDay(completed) > groups.get(key).through
      )
        return null;
      expected.set(key, (expected.get(key) || 0n) + amount);
    }
    let net = 0n,
      through = '';
    for (const [key, amount] of expected) {
      const group = groups.get(key);
      // 防止只出了一部分退款报表时用旧净额覆盖本商品全部退款。
      if (
        !group ||
        group.invalid ||
        group.net < 0n ||
        moneyText(group.customer) !== moneyText(amount)
      )
        return null;
      net += group.net;
      if (group.through > through) through = group.through;
    }
    return { amount: moneyText(net), through };
  };
}
