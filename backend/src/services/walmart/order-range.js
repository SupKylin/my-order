// 业务接入起点：2026-10-01 美西标准时间 00:00，包含当天，不随年份滚动。
export const WALMART_ORDER_START = '2026-10-01T00:00:00-08:00';
export const WALMART_ORDER_START_MS = Date.parse(WALMART_ORDER_START);
export const ORDER_LOOKBACK_MS = 48 * 60 * 60 * 1000;
export const RECONCILE_LOOKBACK_MS = 7 * 86400000;
export const RECONCILE_INTERVAL_MS = 86400000;

/** 首次升级全量补查，之后滚动回查；停机较久时仍从旧游标覆盖缺口。 */
export function syncOrderRange(state, end = Date.now()) {
  const floor = Math.max(WALMART_ORDER_START_MS, new Date(state.startedAt).getTime());
  const cursor = state.cursorAt ? new Date(state.cursorAt).getTime() : floor;
  const reconciled = state.lastReconciledAt ? new Date(state.lastReconciledAt).getTime() : null;
  const mode = !reconciled
    ? 'backfill'
    : end - reconciled >= RECONCILE_INTERVAL_MS
      ? 'reconcile'
      : 'recent';
  const window = mode === 'recent' ? ORDER_LOOKBACK_MS : RECONCILE_LOOKBACK_MS;
  const start = mode === 'backfill' ? floor : Math.max(floor, Math.min(cursor, end) - window);
  return { mode, start: new Date(start), end: new Date(end) };
}

/** 旧店铺起点不一致时只重置一次扫描进度，按现有去重规则补拉。 */
export function orderRangePatch(state) {
  if (new Date(state.startedAt).getTime() === WALMART_ORDER_START_MS) return {};
  return { startedAt: new Date(WALMART_ORDER_START_MS), cursorAt: null, lastReconciledAt: null };
}

export function isOrderInRange(order, end = Date.now()) {
  if (order.orderDate == null) return false;
  const date = Number(order.orderDate);
  return Number.isFinite(date) && date >= WALMART_ORDER_START_MS && date <= end;
}
