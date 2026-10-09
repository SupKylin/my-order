import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WALMART_ORDER_START_MS,
  orderRangePatch,
  isOrderInRange,
} from '../src/services/walmart/order-range.js';

test('接收起点为固定美西 10 月 1 日零点，包含边界，拒绝旧单、未来与无效时间', () => {
  assert.equal(WALMART_ORDER_START_MS, Date.parse('2026-10-01T08:00:00Z'));
  const end = WALMART_ORDER_START_MS + 86400000;
  for (const value of [WALMART_ORDER_START_MS, end])
    assert.equal(isOrderInRange({ orderDate: value }, end), true);
  for (const value of [WALMART_ORDER_START_MS - 1, end + 1, null, undefined, 'invalid'])
    assert.equal(isOrderInRange({ orderDate: value }, end), false);
});

test('旧起点只重置一次，已符合范围的店铺保持增量进度', () => {
  for (const oldDate of ['2026-09-01', '2026-10-08']) {
    const patch = orderRangePatch({ startedAt: new Date(oldDate), cursorAt: new Date() });
    assert.equal(patch.startedAt.getTime(), WALMART_ORDER_START_MS);
    assert.equal(patch.cursorAt, null);
    assert.deepEqual(orderRangePatch(patch), {});
  }
});
