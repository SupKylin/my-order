import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';
import { buildFilters } from '../src/services/orders.js';

test('价格类型映射到对应表格字段，单端和双端均包含边界', () => {
  const cases = [
    ['purchaseLinkAmount', 'purchase', { minPrice: '0' }, { [Op.gte]: '0.00' }],
    ['orderAmount', 'item', { maxPrice: '20' }, { [Op.lte]: '20.00' }],
    [
      'purchaseLimit',
      'purchase',
      { minPrice: '20', maxPrice: '30' },
      { [Op.gte]: '20.00', [Op.lte]: '30.00' },
    ],
  ];
  for (const [priceType, group, range, expected] of cases) {
    const filters = buildFilters({ priceType, ...range, shopName: 'Shop A' });
    assert.equal(filters.where.shopName, 'Shop A');
    const target = group === 'item' ? filters.where : filters.include[1].where;
    assert.deepEqual(target[priceType], expected);
  }
});

test('高精度金额按十进制校验上下限，不经浮点转换', () => {
  assert.doesNotThrow(() =>
    buildFilters({
      priceType: 'orderAmount',
      minPrice: '0.12345678901234567890',
      maxPrice: '0.12345678901234567891',
    }),
  );
  assert.throws(
    () =>
      buildFilters({
        priceType: 'orderAmount',
        minPrice: '0.12345678901234567891',
        maxPrice: '0.12345678901234567890',
      }),
    /最低价格不能高于最高价格/,
  );
});

test('拒绝无效类型、负数、非数字和缺失价格类型', () => {
  for (const query of [
    { priceType: 'priceFactor', minPrice: '1' },
    { priceType: 'orderAmount', minPrice: '-1' },
    { priceType: 'orderAmount', maxPrice: 'NaN' },
    { minPrice: '1' },
  ]) {
    assert.throws(() => buildFilters(query));
  }
});
