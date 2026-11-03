import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDailyStatistics, dailyDates, dailyReport } from '../src/services/home/daily.js';

const now = Date.parse('2026-11-01T00:00:00-08:00');
function item(order, time, amount, extra = {}) {
  return {
    order: { orderNumber: order },
    walmart: { orderDate: Date.parse(time), statuses: ['Acknowledged'] },
    orderAmount: amount,
    ...extra,
  };
}
function reconciliation(refunds = [], end = '2026-10-31') {
  return {
    version: 2,
    status: 'ok',
    reports: { 11032026: { start: '2026-10-01', end, refunds } },
  };
}
test('最近30个PST自然日含今天，跨月跨年和午夜边界正确', () => {
  const dates = dailyDates(now);
  assert.equal(dates.length, 30);
  assert.equal(dates[0], '2026-11-01');
  assert.equal(dates.at(-1), '2026-10-03');
  assert.equal(dailyDates(Date.parse('2027-01-01T00:00:00-08:00'))[0], '2027-01-01');
  assert.equal(dailyDates(now - 1)[0], '2026-10-31');
  assert.equal(dailyDates(Date.parse('2026-11-01T00:00:00+08:00'))[0], '2026-10-31');
});

test('跨中美日期的订单按 PST 归组，与订单管理出单日期一致', () => {
  const stats = createDailyStatistics(Date.parse('2026-10-21T00:00:00-08:00'));
  stats.add(item('A', '2026-10-19T22:02:10Z', '37.98'));
  stats.add(item('B', '2026-10-20T04:24:48Z', '90.19'));
  stats.add(item('C', '2026-10-20T12:28:11Z', '45.99'));
  stats.add(item('D', '2026-10-20T14:18:43Z', '122.09'));
  const [, oct20, oct19] = stats.result();
  assert.equal(oct20.date, '2026-10-20');
  assert.equal(oct20.totalOrders, 2);
  assert.equal(oct20.totalSales, '168.08');
  assert.equal(oct19.date, '2026-10-19');
  assert.equal(oct19.totalOrders, 2);
  assert.equal(oct19.totalSales, '128.17');
});

test('店铺日报先日期倒序再按金额数值倒序，缺失数据排后，同额按名称稳定排序', () => {
  const makeStore = (id, name, amount) => ({
    id,
    name,
    snapshotDate: '2026-11-01',
    metrics: {
      daily: [
        { date: '2026-11-01', totalSales: amount },
        { date: '2026-10-31', totalSales: '999.00' },
      ],
    },
  });
  const stores = [
    makeStore(2, 'B', '9.50'),
    makeStore(4, 'D', '100.00'),
    makeStore(1, 'A', '9.50'),
    makeStore(3, 'C', '20.00'),
    { id: 5, name: 'Missing' },
    makeStore(6, 'Zero', '0.00'),
  ];
  const rows = dailyReport(stores, now).dailyStores;
  assert.deepEqual(
    rows.slice(0, 6).map((row) => row.storeId),
    [4, 3, 1, 2, 6, 5],
  );
  assert.ok(rows.slice(0, 6).every((row) => row.date === '2026-11-01'));
  assert.equal(rows[6].date, '2026-10-31');
  assert.equal(rows[5].totalSales, null);
  assert.deepEqual(
    stores.map((store) => store.id),
    [2, 4, 1, 3, 5, 6],
  );
});
test('订单和WFS跨SKU去重，状态计明细；销售额排除取消行，按接口日期归组', () => {
  const stats = createDailyStatistics(
    now,
    reconciliation([
      ['A', '0.24'],
      ['B', '0.12'],
    ]),
  );
  const time = '2026-10-31T23:59:59.999-08:00';
  stats.add(
    item('A', time, '0.10', {
      fulfillmentParty: 'WFSFulfilled',
      purchase: { reviewStatus: '已审核', purchaseStatus: '采购中' },
      orderStatus: '已发货，虚拟单号发货',
    }),
  );
  stats.add(
    item('A', time, '0.20', {
      fulfillmentParty: 'WFS',
      purchase: { reviewStatus: '已审核', purchaseStatus: '采购中' },
    }),
  );
  stats.add(
    item('B', time, '100', {
      walmart: { orderDate: Date.parse(time), statuses: ['Cancelled'] },
      purchase: { allocatable: '否', purchaseStatus: '采购失败' },
      orderStatus: '采购失败虚拟单号发货',
    }),
  );
  stats.add(item('TODAY', '2026-11-01T00:00:00-08:00', '999'));
  stats.add(item('TOO-OLD', '2026-10-01T23:59:59-08:00', '999'));
  stats.add(item('NO-DATE', 'invalid', '999'));
  stats.add(item('FUTURE', '2026-11-01T00:00:00.001-08:00', '1000'));
  const [today, day, empty] = stats.result();
  assert.equal(today.totalOrders, 1);
  assert.equal(today.totalSales, '999.00');
  assert.equal(today.refundStatus, 'partial');
  assert.equal(today.refundAmount, '0.00');
  const { refundStatus, refundMessage, refundAsOf, ...values } = day;
  assert.equal(refundStatus, 'ok');
  assert.equal(refundAsOf, '2026-10-31');
  assert.match(refundMessage, /含税/);
  assert.deepEqual(values, {
    date: '2026-10-31',
    totalSales: '0.30',
    totalOrders: 2,
    wfsOrders: 1,
    reviewed: 2,
    unallocatable: 1,
    purchasing: 2,
    purchaseFailed: 1,
    virtualShipped: 1,
    refundAmount: '0.36',
  });
  assert.equal(empty.totalOrders, 0);
  assert.equal(empty.refundAmount, '0.00');
});
test('普通订单缺少退款字段不影响结果；报表未完整获取不视为零，不从取消推断退款', () => {
  const stats = createDailyStatistics(now, reconciliation());
  stats.add(
    item('A', '2026-10-31T12:00:00-08:00', '1', {
      walmart: { orderDate: Date.parse('2026-10-31T12:00:00-08:00'), statuses: ['Cancelled'] },
    }),
  );
  assert.equal(stats.result()[1].refundAmount, '0.00');
  assert.equal(createDailyStatistics(now).result()[1].refundAmount, null);
  const failed = reconciliation();
  failed.status = 'error';
  failed.error = '接口未授权';
  assert.match(createDailyStatistics(now, failed).result()[1].refundMessage, /未授权/);
  assert.equal(createDailyStatistics(now, failed).result()[1].refundStatus, 'partial');
});
test('不同店铺同一订单号各计一次；汇总只包含传入的授权店铺，实时统计不依赖平台快照', () => {
  const stats = createDailyStatistics(now, reconciliation([['SAME', '0.12']]));
  stats.add(item('SAME', '2026-10-31T12:00:00-08:00', '0.10'));
  const stores = [1, 2].map((id) => ({
    id,
    name: `store-${id}`,
    owner: 'owner',
    snapshotDate: '2026-11-01',
    metrics: { daily: stats.result() },
  }));
  assert.equal(dailyReport(stores, now).daily[1].totalOrders, 2);
  assert.equal(dailyReport(stores, now).daily[1].totalSales, '0.20');
  assert.equal(dailyReport(stores, now).daily[1].refundAmount, '0.24');
  assert.equal(dailyReport(stores, now).dailyStores.length, 60);
  assert.equal(dailyReport(stores.slice(0, 1), now).daily[1].totalOrders, 1);
  stores[1].snapshotDate = '2026-10-31';
  assert.equal(dailyReport(stores, now).daily[1].ready, true);
  stores[1].metrics = null;
  const report = dailyReport(stores, now);
  assert.equal(report.daily[1].ready, false);
  assert.equal(report.daily[1].totalOrders, null);
  assert.equal(report.dailyStores[2].totalOrders, 1);
  assert.equal(report.dailyStores[3].totalOrders, null);
  assert.equal(dailyReport([], now).daily[1].totalOrders, 0);
});

test('历史退款仍归原订单日期，未出账期与无报表店铺仅作部分汇总', () => {
  const cached = reconciliation([['A', '12.34']], '2026-10-17');
  cached.status = 'error';
  cached.error = '最新账期暂不可用';
  const stats = createDailyStatistics(now, cached);
  stats.add(item('A', '2026-10-10T12:00:00-08:00', '20'));
  stats.add(item('B', '2026-10-31T12:00:00-08:00', '30'));
  const rows = stats.result();
  assert.equal(rows.find((r) => r.date === '2026-10-10').refundAmount, '12.34');
  assert.equal(rows.find((r) => r.date === '2026-10-31').refundAmount, '0.00');
  assert.equal(rows[0].refundStatus, 'partial');
  assert.equal(rows[0].refundAsOf, '2026-10-17');
  assert.match(rows[0].refundMessage, /并非最终退款为零/);
  const report = dailyReport(
    [
      { id: 1, name: 'A', metrics: { daily: rows } },
      { id: 2, name: 'B', metrics: { daily: createDailyStatistics(now).result() } },
    ],
    now,
  );
  const total = report.daily.find((r) => r.date === '2026-10-10');
  assert.equal(total.refundAmount, '12.34');
  assert.equal(total.refundStatus, 'partial');
  assert.match(total.refundMessage, /1\/2 家/);
  assert.equal(report.dailyStores.find((r) => r.storeId === 2).refundAmount, null);
});
