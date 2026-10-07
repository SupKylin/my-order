import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';
import { buildFilters } from '../src/services/orders.js';

test('批量订单号按空白拆分、去重并完整匹配，店铺多选与其他条件取交集', () => {
  const filters = buildFilters({
    orderNumbers: ' 001  002\n001\t003 ',
    shopNames: JSON.stringify(['店铺 A', '店铺 B', '店铺 A']),
    purchaseStatus: '采购中',
    q: '商品',
  });
  assert.deepEqual(filters.where['$order.orderNumber$'], { [Op.in]: ['001', '002', '003'] });
  assert.deepEqual(filters.where.shopName, { [Op.in]: ['店铺 A', '店铺 B'] });
  assert.ok(filters.where[Op.or]);
  assert.equal(filters.include[1].where.purchaseStatus, '采购中');
  assert.deepEqual(buildFilters({ shopNames: ['店铺 A'] }).where.shopName, {
    [Op.in]: ['店铺 A'],
  });
  assert.equal(buildFilters({ shopName: '旧单选店铺' }).where.shopName, '旧单选店铺');
});

test('空批量条件不限制列表，非法列表和超量订单号被拒绝', () => {
  assert.equal(buildFilters({ orderNumbers: '  \n ', shopNames: '[]' }).where.shopName, undefined);
  assert.equal(buildFilters({ orderNumbers: '  \n ' }).where['$order.orderNumber$'], undefined);
  assert.throws(
    () =>
      buildFilters({
        orderNumbers: Array(201)
          .fill('A')
          .map((_, i) => i)
          .join(' '),
      }),
    /200/,
  );
  assert.throws(() => buildFilters({ orderNumbers: ['A'] }), /批量订单号格式无效/);
  assert.throws(() => buildFilters({ shopNames: 'bad-json' }), /店铺筛选格式无效/);
  assert.throws(() => buildFilters({ shopNames: [3] }), /店铺筛选格式无效/);
});
