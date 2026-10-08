import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nextScheduledStore,
  storeSpacing,
  SYNC_INTERVAL_MS,
} from '../src/services/walmart/scheduling.js';
import { readCatalogCache, CATALOG_TTL_MS } from '../src/services/walmart/catalog-cache.js';
import { OrderItem } from '../src/models.js';

test('20 店铺错峰一分钟，按持久化时间恢复且失败任务需等待下轮，忙碌和暂停店铺跳过', () => {
  const now = Date.now();
  const states = Array.from({ length: 20 }, (_, index) => ({
    storeId: index + 1,
    enabled: true,
    startedAt: new Date(now - 2 * SYNC_INTERVAL_MS),
    lastRunAt: new Date(now - SYNC_INTERVAL_MS + index * 60000),
    status: 'failed',
  }));
  assert.equal(storeSpacing(states.length), 60000);
  assert.equal(nextScheduledStore(states, now - 1), undefined);
  assert.equal(nextScheduledStore(states, now).storeId, 1);
  assert.equal(
    nextScheduledStore(states, now, () => true),
    undefined,
  );
  states[0].lastRunAt = new Date(now);
  assert.equal(nextScheduledStore(states, now + 60000).storeId, 2);
  states[1].enabled = false;
  assert.equal(nextScheduledStore(states, now + 60000), undefined);
  assert.equal(nextScheduledStore(states, now + 120000).storeId, 3);
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
