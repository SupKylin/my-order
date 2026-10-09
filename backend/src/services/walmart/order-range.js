// 业务接入起点：2026-10-01 美西标准时间 00:00，包含当天，不随年份滚动。
export const WALMART_ORDER_START = '2026-10-01T00:00:00-08:00';
export const WALMART_ORDER_START_MS = Date.parse(WALMART_ORDER_START);

/** 旧店铺起点不一致时只重置一次扫描进度，按现有去重规则补拉。 */
export function orderRangePatch(state) {
  if (new Date(state.startedAt).getTime() === WALMART_ORDER_START_MS) return {};
  return { startedAt: new Date(WALMART_ORDER_START_MS), cursorAt: null };
}

export function isOrderInRange(order, end = Date.now()) {
  if (order.orderDate == null) return false;
  const date = Number(order.orderDate);
  return Number.isFinite(date) && date >= WALMART_ORDER_START_MS && date <= end;
}
