import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dueStores,
  createSyncDispatcher,
  MAX_SYNC_CONCURRENCY,
  SYNC_INTERVAL_MS,
} from '../src/services/walmart/scheduling.js';
import { readCatalogCache, CATALOG_TTL_MS } from '../src/services/walmart/catalog-cache.js';
import { OrderItem } from '../src/models.js';

test('按持久化时间恢复，失败任务等待下轮，忙碌和暂停店铺跳过', () => {
  const now = Date.now();
  const states = Array.from({ length: 20 }, (_, index) => ({
    storeId: index + 1,
    enabled: true,
    startedAt: new Date(now - 2 * SYNC_INTERVAL_MS),
    lastRunAt: new Date(now - SYNC_INTERVAL_MS + index * 60000),
    status: 'failed',
  }));
  assert.equal(dueStores(states, now - 1).length, 0);
  assert.equal(dueStores(states, now)[0].storeId, 1);
  assert.equal(dueStores(states, now, () => true).length, 0);
  states[0].lastRunAt = new Date(now);
  assert.equal(dueStores(states, now + 60000)[0].storeId, 2);
  states[1].enabled = false;
  assert.equal(dueStores(states, now + 60000).length, 0);
  assert.equal(dueStores(states, now + 120000)[0].storeId, 3);
});

test('26 店铺填满 3 个名额；慢店铺不阻塞其他店铺，重叠 tick 不重复启动', async () => {
  const now = Date.now();
  const states = Array.from({ length: 26 }, (_, index) => ({
    storeId: index + 1,
    enabled: true,
    startedAt: new Date(now - SYNC_INTERVAL_MS),
  }));
  const active = new Set();
  const launched = [];
  const dispatcher = createSyncDispatcher({
    list: async () => states,
    launch: async (id) => {
      active.add(id);
      launched.push(id);
      states[id - 1].lastRunAt = new Date(now);
      assert.ok(active.size <= MAX_SYNC_CONCURRENCY);
    },
    activeCount: () => active.size,
    busy: (id) => active.has(id),
    now: () => now,
    onError: (error) => assert.fail(error.message),
  });
  await Promise.all([dispatcher.tick(), dispatcher.tick(), dispatcher.tick()]);
  assert.deepEqual(launched, [1, 2, 3]);
  // 1 号一直不完成，其他两个名额仍能处理完剩余店铺。
  while (launched.length < states.length) {
    for (const id of active) if (id !== 1) active.delete(id);
    await dispatcher.tick();
  }
  assert.equal(new Set(launched).size, 26);
  await dispatcher.stop();
  active.clear();
  await dispatcher.tick();
  assert.equal(launched.length, 26);
});

test('一个店铺启动失败不阻塞其他店铺；停止会等待待完成的调度读取', async () => {
  let resolveList;
  let calls = 0;
  const errors = [];
  const states = [1, 2].map((storeId) => ({ storeId, enabled: true, startedAt: new Date(0) }));
  const dispatcher = createSyncDispatcher({
    list: async () => states,
    activeCount: () => 0,
    busy: () => false,
    launch: async (id) => {
      calls++;
      if (id === 1) throw new Error('failed');
    },
    onError: (e) => errors.push(e.message),
  });
  await dispatcher.tick();
  assert.equal(calls, 2);
  assert.deepEqual(errors, ['failed']);
  const stopping = createSyncDispatcher({
    list: () =>
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    activeCount: () => 0,
    busy: () => false,
    launch: async () => assert.fail('停止后不能启动任务'),
    onError: assert.fail,
  });
  const tick = stopping.tick();
  const stop = stopping.stop();
  resolveList(states);
  await Promise.all([tick, stop]);
});

test('规格缓存隔离店铺，过期/失败/未来时间不命中，读取不延长有效期，空属性也缓存', async (t) => {
  const now = Date.now();
  const snapshot = {
    storeId: 2,
    attributes: [],
    variantFetchedAt: new Date(now - 1000).toISOString(),
    variantError: null,
  };
  let stored = snapshot;
  t.mock.method(OrderItem, 'findAll', async (query) => {
    assert.deepEqual(query.where, { shopName: 'STORE', walmartSku: 'SKU' });
    return [{ walmart: stored }];
  });
  const store = { id: 2, systemStoreName: 'STORE' };
  const hit = await readCatalogCache(store, 'SKU', now);
  assert.deepEqual(hit.item.variantGroupInfo.groupingAttributes, []);
  assert.equal(hit.fetchedAt, snapshot.variantFetchedAt);
  for (const patch of [
    { storeId: 3 },
    { variantError: 'failed' },
    { variantFetchedAt: null },
    { variantFetchedAt: new Date(now - CATALOG_TTL_MS).toISOString() },
    { variantFetchedAt: new Date(now + 1).toISOString() },
  ]) {
    stored = { ...snapshot, ...patch };
    assert.equal(await readCatalogCache(store, 'SKU', now), null);
  }
});
