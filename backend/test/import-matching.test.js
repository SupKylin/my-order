import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderIdentityKey } from '../src/lib/order-identity.js';
import { matchImportRows } from '../src/lib/import-matching.js';

const row = (orderNumber, walmartSku, shopName, purchaseChannel, purchaseSku) => ({
  patch: { orderNumber, walmartSku, shopName, purchaseChannel, purchaseSku },
});
const item = (id, orderNumber, walmartSku, shopName, purchaseChannel, purchaseSku) => ({
  id,
  orderNumber,
  walmartSku,
  shopName,
  purchaseChannel,
  purchaseSku,
});
const ids = (rows, existing, kind = 'order') =>
  matchImportRows(rows, existing, kind).map((target) => target?.id ?? null);

test('三项完全匹配，渠道变化不改变目标，不匹配其他订单', () => {
  assert.deepEqual(
    ids(
      [
        row('A', '001', '店1', ['Y']),
        row('A', '002', '店1'),
        row('A', '001', '店2'),
        row('B', '001', '店1'),
      ],
      [item(1, 'A', '001', '店1', ['X'])],
    ),
    [1, null, null, null],
  );
});

test('空值只匹配对应空值，不回退到同订单其他组合', () => {
  assert.deepEqual(
    ids(
      [row('A'), row('A', '', '店1'), row('A', '001'), row('A', '002', '店2')],
      [item(1, 'A', null, ''), item(2, 'A', null, '店1'), item(3, 'A', '001', null)],
    ),
    [1, 2, 3, null],
  );
});

test('重复组合按创建顺序消费一次，多出新增，其他组合保留', () => {
  assert.deepEqual(
    ids(
      [row('A', 'S', '店'), row('A', 'T', '店'), row('A', 'S', '店'), row('A', 'S', '店')],
      [
        item(1, 'A', 'S', '店'),
        item(2, 'A', 'S', '店'),
        item(3, 'A', 'T', '店'),
        item(4, 'A', 'S', '别店'),
      ],
    ),
    [1, 3, 2, null],
  );
});

test('去除首尾空格，保留前导零和大小写，分隔符不会碰撞', () => {
  assert.equal(
    orderIdentityKey({ sku: ' 001 ', shopName: ' 店 ' }),
    orderIdentityKey({ sku: '001', shopName: '店' }),
  );
  for (const [a, b] of [
    [{ sku: '001' }, { sku: '1' }],
    [{ sku: 'ABC' }, { sku: 'abc' }],
    [
      { sku: 'a+b', shopName: 'c' },
      { sku: 'a', shopName: 'b+c' },
    ],
    [{ shopName: 'Shop' }, { shopName: 'shop' }],
  ])
    assert.notEqual(orderIdentityKey(a), orderIdentityKey(b));
  assert.notEqual(
    orderIdentityKey({ walmartSku: null, sku: '旧值', shopName: '店' }),
    orderIdentityKey({ walmartSku: '旧值', shopName: '店' }),
  );
});

test('采购 SKU 为空也匹配同一目标，仅按店铺、订单号、WalmartSku 更新', () => {
  const existing = [item(1, 'A', 'W-1', '店', null, 'P-1')];
  assert.deepEqual(
    ids(
      [
        row('A', 'W-1', '店', null, ''),
        row('A', 'W-1', '店', null, 'P-2'),
        row('A', 'W-2', '店', null, 'P-1'),
        row('A', 'W-1', '别店', null, 'P-1'),
      ],
      existing,
      'purchase',
    ),
    [1, 1, null, null],
  );
});

test('采购导入遇到多条三项相同的旧明细时跳过，不用采购 SKU 消除歧义', () => {
  assert.deepEqual(
    ids(
      [
        row('A', 'W', '店', null, 'P-2'),
        row('A', 'W', '店', null, 'P-1'),
        row('A', 'W', '店', null, 'P-3'),
      ],
      [item(1, 'A', 'W', '店', null, 'P-1'), item(2, 'A', 'W', '店', null, 'P-2')],
      'purchase',
    ),
    [null, null, null],
  );
});
