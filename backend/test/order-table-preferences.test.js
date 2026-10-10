import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateOrderTablePreferences } from '../src/lib/order-table-preferences.js';
import { orderedColumns } from '../../frontend/src/utils/orderTablePreferences.js';

test('列排序保持固定列、去重并容纳后续新增字段', () => {
  const columns = ['shopName', 'orderNumber', 'orderDate', 'tax', 'newColumn'].map((key) => ({
    key,
  }));
  const preferences = { order: ['tax', 'removed', 'orderNumber', 'tax', 'orderDate'] };
  assert.deepEqual(
    orderedColumns(columns, preferences).map((column) => column.key),
    ['shopName', 'orderNumber', 'tax', 'orderDate', 'newColumn'],
  );
  assert.deepEqual(orderedColumns(columns, null), columns);
});

test('偏好只接受主表已知列，拒绝重复、非法结构和超长输入', () => {
  for (const input of [
    null,
    {},
    [],
    { order: 'tax', hidden: [] },
    { order: ['passwordHash'], hidden: [] },
    { order: ['tax', 'tax'], hidden: [] },
    { order: [], hidden: ['productName'] },
    { order: [], hidden: ['tax', 'tax'] },
    { order: Array(1000).fill('tax'), hidden: [] },
  ])
    assert.throws(() => validateOrderTablePreferences(input));
  assert.deepEqual(
    validateOrderTablePreferences({ order: ['tax', 'orderNumber'], hidden: ['tax'], userId: 9 }),
    { order: ['shopName', 'orderNumber', 'tax'], hidden: ['tax'] },
  );
});
