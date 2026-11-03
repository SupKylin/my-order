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

test('采购状态空值与已选状态取并集，与渠道筛选取交集', () => {
  const empty = buildFilters({ purchaseStatusEmpty: true }).include[1].where;
  const conditions = empty[Op.and][0][Op.or];
  assert.equal(conditions.length, 2);
  assert.deepEqual(conditions[0], { purchaseStatus: null });
  assert.equal(conditions[1].attribute.col, 'purchase.purchaseStatus');
  assert.deepEqual(conditions[1].logic, { [Op.regexp]: '^[[:space:]]*$' });
  assert.equal(empty.purchaseStatus, undefined);
  const combined = buildFilters({
    purchaseStatus: JSON.stringify(['采购中', '采购失败']),
    purchaseStatusEmpty: 'true',
    purchaseChannel: ['渠道甲'],
    purchaseChannelEmpty: true,
  }).include[1].where;
  assert.deepEqual(combined[Op.and][0][Op.or][2], {
    purchaseStatus: { [Op.in]: ['采购中', '采购失败'] },
  });
  assert.equal(combined[Op.or].length, 3);
  assert.deepEqual(
    buildFilters({ purchaseStatus: '采购中', purchaseStatusEmpty: false }).include[1].where,
    { purchaseStatus: '采购中' },
  );
  assert.deepEqual(buildFilters({ purchaseStatusEmpty: 'false' }).include[1].where, {});
});
