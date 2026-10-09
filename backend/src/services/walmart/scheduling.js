export const SYNC_INTERVAL_MS = 20 * 60 * 1000;
// 连接池共 10 个连接；每个任务持有一个店铺锁连接，另需事务和状态查询连接。
export const MAX_SYNC_CONCURRENCY = 3;

/** 每店按持久化的上次启动时间计时，重启不会重新拉取刚同步过的店铺。 */
export function syncDueAt(state) {
  return state.lastRunAt
    ? new Date(state.lastRunAt).getTime() + SYNC_INTERVAL_MS
    : new Date(state.startedAt).getTime();
}

/** 返回到期队列，等待最久的店铺优先；不等待任何一家完成再启动其他店铺。 */
export function dueStores(states, now, busy = () => false) {
  return states
    .filter((state) => state.enabled && !busy(Number(state.storeId)) && syncDueAt(state) <= now)
    .sort((a, b) => syncDueAt(a) - syncDueAt(b) || a.storeId - b.storeId);
}

/** 调度只等待任务被接收；容量由手动和自动任务共享，重叠 tick 合并。 */
export function createSyncDispatcher({ list, launch, activeCount, busy, now = Date.now, onError }) {
  let stopped = false;
  let dispatching = null;
  function tick() {
    if (stopped) return Promise.resolve();
    if (dispatching) return dispatching;
    dispatching = (async () => {
      if (activeCount() >= MAX_SYNC_CONCURRENCY) return;
      const states = await list();
      for (const state of dueStores(states, now(), busy)) {
        if (stopped || activeCount() >= MAX_SYNC_CONCURRENCY) break;
        try {
          await launch(state.storeId);
        } catch (error) {
          onError(error);
        }
      }
    })()
      .catch(onError)
      .finally(() => {
        dispatching = null;
      });
    return dispatching;
  }
  return {
    tick,
    async stop() {
      stopped = true;
      await dispatching;
    },
  };
}
