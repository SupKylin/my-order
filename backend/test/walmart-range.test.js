import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WALMART_ORDER_START_MS,
  orderRangePatch,
  isOrderInRange,
  syncOrderRange,
  ORDER_LOOKBACK_MS,
  RECONCILE_LOOKBACK_MS,
  RECONCILE_INTERVAL_MS,
} from '../src/services/walmart/order-range.js';

test('接收起点为固定美西 10 月 1 日零点，包含边界，拒绝旧单、未来与无效时间', () => {
  assert.equal(WALMART_ORDER_START_MS, Date.parse('2026-10-01T08:00:00Z'));
  const end = WALMART_ORDER_START_MS + 86400000;
  for (const value of [WALMART_ORDER_START_MS, end])
    assert.equal(isOrderInRange({ orderDate: value }, end), true);
  for (const value of [WALMART_ORDER_START_MS - 1, end + 1, null, undefined, 'invalid'])
    assert.equal(isOrderInRange({ orderDate: value }, end), false);
});

test('升级首次全范围补查，48 小时回查与每日 7 天核对均保留断线缺口', () => {
  const end = WALMART_ORDER_START_MS + 30 * 86400000;
  const state = { startedAt: new Date(WALMART_ORDER_START_MS), cursorAt: new Date(end - 1200000) };
  assert.deepEqual(syncOrderRange(state, end), {
    mode: 'backfill',
    start: new Date(WALMART_ORDER_START_MS),
    end: new Date(end),
  });
  state.lastReconciledAt = new Date(end - 1000);
  assert.equal(
    syncOrderRange(state, end).start.getTime(),
    state.cursorAt.getTime() - ORDER_LOOKBACK_MS,
  );
  assert.equal(syncOrderRange(state, end).mode, 'recent');
  state.lastReconciledAt = new Date(end - RECONCILE_INTERVAL_MS);
  assert.equal(syncOrderRange(state, end).mode, 'reconcile');
  assert.equal(
    syncOrderRange(state, end).start.getTime(),
    state.cursorAt.getTime() - RECONCILE_LOOKBACK_MS,
  );
  state.cursorAt = new Date(end - 10 * 86400000);
  assert.ok(syncOrderRange(state, end).start < state.cursorAt);
  state.cursorAt = new Date(WALMART_ORDER_START_MS);
  assert.equal(syncOrderRange(state, end).start.getTime(), WALMART_ORDER_START_MS);
});

test('旧起点只重置一次，已符合范围的店铺保持增量进度', () => {
  for (const oldDate of ['2026-09-01', '2026-10-08']) {
    const patch = orderRangePatch({ startedAt: new Date(oldDate), cursorAt: new Date() });
    assert.equal(patch.startedAt.getTime(), WALMART_ORDER_START_MS);
    assert.equal(patch.cursorAt, null);
    assert.deepEqual(orderRangePatch(patch), {});
  }
});
