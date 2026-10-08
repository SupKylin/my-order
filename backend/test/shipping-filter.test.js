import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Op } from 'sequelize';
import { buildFilters, listOrders } from '../src/services/orders.js';
import { OrderItem } from '../src/models.js';
import { shippingWindow } from '../src/lib/shipping-window.js';
import { shippingWarning } from '../../frontend/src/utils/shippingWarning.js';

test('服务端日期边界与橙红预警一致，覆盖截止毫秒、24小时、跨年及夏令时日期', () => {
  for (const date of ['2026-01-01', '2026-03-08', '2026-07-15', '2026-11-01', '2026-12-31']) {
    const deadline = Date.parse(`${date}T00:00:00+08:00`) + 86400000 + 15 * 3600000;
    for (const delta of [-86400001, -86400000, -1, 0, 1, 1000, 86400000]) {
      const now = deadline + delta;
      const { first, last } = shippingWindow(now);
      for (let days = -3; days <= 3; days++) {
        const shipDate = new Date(Date.parse(date) + days * 86400000).toISOString().slice(0, 10);
        const expected = shippingWarning(shipDate, now);
        assert.equal(shipDate < first, expected === 'red', `${date} ${delta} ${shipDate}`);
        assert.equal(shipDate >= first && shipDate <= last, expected === 'orange');
      }
    }
  }
});

test('预警与日期、价格、渠道取交集，清空预警恢复原筛选，拒绝非法值', () => {
  const now = Date.parse('2026-10-06T12:00:00+08:00');
  for (const level of ['orange', 'red']) {
    const result = buildFilters(
      {
        shippingWarning: level,
        shipStartDate: '2026-10-01',
        shipEndDate: '2026-10-10',
        priceFactorLevel: 'low',
        priceType: 'orderAmount',
        minPrice: '10',
        purchaseChannel: '渠道A',
      },
      now,
    );
    assert.deepEqual(result.where.platformShipDate, {
      [Op.gte]: '2026-10-01',
      [Op.lte]: '2026-10-10',
    });
    assert.deepEqual(result.where.orderAmount, { [Op.gte]: '10.00' });
    assert.equal(result.where[Op.and].length, 4);
    assert.equal(result.where[Op.and][3].platformOrderStatus, '已确认');
    assert.deepEqual(
      result.where[Op.and][3].platformShipDate,
      level === 'red'
        ? { [Op.lt]: '2026-10-05' }
        : { [Op.gte]: '2026-10-05', [Op.lte]: '2026-10-05' },
    );
    assert.ok(result.include[1].where[Op.and]);
  }
  assert.equal(buildFilters({ shippingWarning: '' }, now).where[Op.and], undefined);
  assert.equal(buildFilters({}, now).where.platformOrderStatus, undefined);
  assert.throws(() => buildFilters({ shippingWarning: 'unknown' }), /发货预警筛选无效/);
});

test('分页和预警统计复用同一时刻生成的条件，统计不受分页限制', async (t) => {
  let rowQuery, statsQuery;
  t.mock.method(OrderItem, 'findAndCountAll', async (query) => {
    rowQuery = query;
    return { rows: [], count: 7 };
  });
  t.mock.method(OrderItem, 'findAll', async (query) => {
    statsQuery = query;
    return [{ platformShipDate: '2026-10-06', count: '7' }];
  });
  const result = await listOrders({ shippingWarning: 'orange', page: 2, pageSize: 1 });
  assert.equal(rowQuery.limit, 1);
  assert.equal(rowQuery.offset, 1);
  assert.equal(statsQuery.where[Op.and][0], rowQuery.where);
  assert.equal(statsQuery.limit, undefined);
  assert.deepEqual(statsQuery.where[Op.and][1], {
    platformShipDate: { [Op.ne]: null },
    platformOrderStatus: '已确认',
  });
  assert.equal(result.total, 7);
  assert.deepEqual(result.shippingDates, [{ date: '2026-10-06', count: 7 }]);
});

test('未选择预警筛选时列表包含全部状态，但顶部预警数量仅统计已确认', async (t) => {
  t.mock.method(OrderItem, 'findAndCountAll', async (query) => {
    assert.equal(query.where.platformOrderStatus, undefined);
    assert.equal(query.where[Op.and], undefined);
    return { rows: [], count: 12 };
  });
  t.mock.method(OrderItem, 'findAll', async (query) => {
    assert.equal(query.where[Op.and][1].platformOrderStatus, '已确认');
    return [{ platformShipDate: '2026-10-06', count: '2' }];
  });
  const result = await listOrders({});
  assert.equal(result.total, 12);
  assert.deepEqual(result.shippingDates, [{ date: '2026-10-06', count: 2 }]);
});
