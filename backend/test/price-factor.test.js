import test from 'node:test';
import assert from 'node:assert/strict';
import { priceFactorLevel } from '../src/lib/price-factor.js';
import { serializeItem } from '../src/models.js';
import { buildFilters } from '../src/services/orders.js';

test('价格系数边界和长小数不舍入，0.8 为平、0.85 为高', () => {
  for (const [value, expected] of [
    ['0', 'low'],
    ['-1', 'low'],
    ['0.799999999999999999999999999999999999', 'low'],
    ['0.8', 'medium'],
    ['.8', 'medium'],
    ['+000.8000', 'medium'],
    ['0.849999999999999999999999999999999999', 'medium'],
    ['0.85', 'high'],
    ['.85000', 'high'],
    ['  +000.9  ', 'high'],
    ['1', 'high'],
    ['001.00', 'high'],
    ['999999999999999999999999999999999999', 'high'],
  ]) {
    assert.equal(priceFactorLevel(value), expected, value);
  }
});

test('空值和自由文本不被归为低，部分数字和百分数不猜测转换', () => {
  for (const value of [null, undefined, '', '  ', '待定', '0.8待定', '80%', 'NaN', '1e0'])
    assert.equal(priceFactorLevel(value), null, String(value));
});

test('派生标记不修改订单号或原始价格系数', () => {
  const source = { order: { orderNumber: '000123-ABC' }, purchase: { priceFactor: '0.85' } };
  const before = structuredClone(source);
  const row = serializeItem(source);
  assert.equal(row.orderNumber, '000123-ABC');
  assert.equal(row.priceFactor, '0.85');
  assert.equal(row.priceFactorLevel, 'high');
  assert.deepEqual(source, before);
});

test('拒绝无效等级筛选', () => {
  assert.throws(() => buildFilters({ priceFactorLevel: 'unknown' }), /价格系数等级筛选无效/);
});
