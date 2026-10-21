import { isPurchaseSuccess } from '../../lib/purchase-timer.js';
import { WALMART_ORDER_START_MS } from '../walmart/order-range.js';

const DAY = 86400000;
const SCALE = 10n ** 20n;
// 与订单列表一致：固定美西标准时间 UTC−8，不随夏令时切换。
export function pstDay(now = Date.now()) {
  return new Date(Number(now) - 8 * 3600000).toISOString().slice(0, 10);
}
export function yesterdayRange(now = Date.now()) {
  const end = Date.parse(`${pstDay(now)}T00:00:00-08:00`);
  return { start: end - DAY, end };
}
export function amountUnits(value) {
  const text = String(value ?? '0');
  if (!/^\d+(\.\d{1,20})?$/.test(text)) throw new Error('订单金额格式无效');
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(20, '0'));
}
export function amountText(value) {
  const cents = (value + SCALE / 200n) / (SCALE / 100n);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

/** 每次聚合只处理一家店铺；金额按商品行相加，订单号跨 SKU 去重。 */
export function createStatistics(now = Date.now()) {
  const yesterday = yesterdayRange(now);
  const orders = new Set(),
    previous = new Set(),
    unshipped = new Set(),
    pending = new Set();
  const cancelled = new Set();
  let sales = 0n,
    previousSales = 0n,
    pendingPurchase = 0,
    purchaseSuccess = 0;
  let missingOrderTime = 0;
  return {
    add(row) {
      const orderTime = Number(row.walmart?.orderDate);
      if (!row.walmart?.orderDate || !Number.isFinite(orderTime)) {
        missingOrderTime++;
        return;
      }
      if (orderTime < WALMART_ORDER_START_MS || orderTime > Number(now)) return;
      const key = row.order.orderNumber;
      const statuses = row.walmart?.statuses || [];
      const isCancelled = statuses.length > 0 && statuses.every((s) => s === 'Cancelled');
      orders.add(key);
      if (statuses.includes('Created')) pending.add(key);
      if (statuses.some((s) => ['Created', 'Acknowledged'].includes(s))) unshipped.add(key);
      if (statuses.includes('Cancelled')) cancelled.add(key);
      const isYesterday = orderTime >= yesterday.start && orderTime < yesterday.end;
      if (isYesterday) previous.add(key);
      if (!isCancelled) {
        sales += amountUnits(row.orderAmount);
        if (isYesterday) previousSales += amountUnits(row.orderAmount);
      }
      if (!row.purchase?.reviewStatus) pendingPurchase++;
      if (isPurchaseSuccess(row.purchase?.purchaseStatus)) purchaseSuccess++;
    },
    result() {
      return {
        totalOrders: orders.size,
        totalSales: amountText(sales),
        yesterdayOrders: previous.size,
        yesterdaySales: amountText(previousSales),
        unshippedOrders: unshipped.size,
        pendingConfirmation: pending.size,
        cancelledOrders: cancelled.size,
        pendingPurchase,
        purchaseSuccess,
        missingOrderTime,
      };
    },
  };
}
