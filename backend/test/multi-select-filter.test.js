import test from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';
import { buildFilters } from '../src/services/orders.js';

test('状态多选兼容 GET JSON、导出数组和旧单选，空数组不限制结果', () => {
  const values = ['采购中', '采购失败'];
  const filters = buildFilters({
    purchaseStatus: JSON.stringify([...values, values[0]]),
    orderStatus: ['已签收', '砍单'],
  });
  assert.deepEqual(filters.include[1].where.purchaseStatus, { [Op.in]: values });
  assert.deepEqual(filters.where.orderStatus, { [Op.in]: ['已签收', '砍单'] });
  assert.equal(
    buildFilters({ purchaseStatus: '采购中' }).include[1].where.purchaseStatus,
    '采购中',
  );
  const empty = buildFilters({
    purchaseStatus: '[]',
    orderStatus: [],
    trackingWarning: [],
    priceFactorLevel: '[]',
  });
  assert.equal(empty.where.orderStatus, undefined);
  assert.deepEqual(empty.include[1].where, {});
  assert.deepEqual(empty.where[Op.and], [{}]);
});

test('多选拒绝非法格式和等级，不将全部提醒误作不限订单', () => {
  for (const key of [
    'purchaseChannel',
    'purchaseStatus',
    'orderStatus',
    'trackingWarning',
    'priceFactorLevel',
  ]) {
    for (const value of ['[bad', [null], [1], {}, [''], Array(201).fill('x')])
      assert.throws(() => buildFilters({ [key]: value }), /筛选.*无效/);
  }
  assert.throws(() => buildFilters({ trackingWarning: ['all', 'invalid'] }), /筛选无效/);
  assert.throws(() => buildFilters({ priceFactorLevel: ['low', 'invalid'] }), /筛选无效/);
  assert.deepEqual(
    buildFilters({ trackingWarning: ['all', 'red'] }),
    buildFilters({ trackingWarning: 'all' }),
  );
});
