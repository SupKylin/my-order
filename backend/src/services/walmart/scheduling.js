export const SYNC_INTERVAL_MS = 20 * 60 * 1000;

/** 每店按持久化的上次启动时间计时，重启不会重新拉取刚同步过的店铺。 */
export function syncDueAt(state) {
  return state.lastRunAt
    ? new Date(state.lastRunAt).getTime() + SYNC_INTERVAL_MS
    : new Date(state.startedAt).getTime();
}

/** 先处理等待最久的店铺；每次只启动一个，避免长任务结束后集中补跑。 */
export function nextScheduledStore(states, now, busy = () => false) {
  return states
    .filter((state) => state.enabled && !busy(Number(state.storeId)) && syncDueAt(state) <= now)
    .sort((a, b) => syncDueAt(a) - syncDueAt(b) || a.storeId - b.storeId)[0];
}

export function storeSpacing(storeCount) {
  return SYNC_INTERVAL_MS / Math.max(1, storeCount);
}
