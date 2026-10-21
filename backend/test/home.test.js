import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStatistics, pstDay, yesterdayRange } from '../src/services/home/statistics.js';
import {
  parseRemoteMetric,
  fetchRemoteMetrics,
  REMOTE_METRICS,
} from '../src/services/home/remote.js';
import { snapshotDue, snapshotSource } from '../src/services/home/index.js';

const now = Date.parse('2026-10-19T00:00:00-08:00');
function row(
  order,
  time,
  amount,
  statuses = ['Acknowledged'],
  reviewStatus = null,
  purchaseStatus = '',
) {
  return {
    order: { orderNumber: order },
    walmart: { orderDate: Date.parse(time), statuses },
    orderAmount: amount,
    purchase: { reviewStatus, purchaseStatus },
  };
}
test('美西标准时间跨日边界不受服务器本地时区影响', () => {
  assert.equal(pstDay(now - 1), '2026-10-18');
  assert.equal(pstDay(now), '2026-10-19');
  assert.deepEqual(yesterdayRange(now), { start: now - 86400000, end: now });
  assert.equal(pstDay(Date.parse('2026-10-20T16:00:00Z')), '2026-10-20');
  assert.equal(pstDay(Date.parse('2026-07-01T07:30:00Z')), '2026-06-30');
});
test('按订单去重、明细计采购、精确累加金额、排除取消行销售额', () => {
  const stats = createStatistics(now);
  const yesterday = '2026-10-18T00:00:00-08:00';
  stats.add(row('A', yesterday, '0.10', ['Created']));
  stats.add(row('A', yesterday, '0.20', ['Acknowledged'], '已审核', '采购成功（未出跟踪号）'));
  stats.add(row('A', yesterday, '99', ['Cancelled'], '不可分配'));
  stats.add(
    row(
      'B',
      '2026-10-18T23:59:59.999-08:00',
      '6.99',
      ['Shipped'],
      '已审核',
      '采购成功（已出跟踪号）',
    ),
  );
  stats.add(
    row('C', '2026-10-19T00:00:00-08:00', '1', ['Delivered'], '已审核', '采购成功（砍单）'),
  );
  stats.add(row('OLD', '2026-10-01T07:59:59Z', '999'));
  stats.add(row('FUTURE', '2026-10-20T00:00:00Z', '999'));
  assert.deepEqual(stats.result(), {
    totalOrders: 3,
    totalSales: '8.29',
    yesterdayOrders: 2,
    yesterdaySales: '7.29',
    unshippedOrders: 1,
    pendingConfirmation: 1,
    cancelledOrders: 1,
    pendingPurchase: 1,
    purchaseSuccess: 2,
    missingOrderTime: 0,
  });
});
test('缺失下单时间不猜测归属日期，日期下限包含美西 10 月 1 日零点', () => {
  const stats = createStatistics(now);
  stats.add({ walmart: {}, order: { orderNumber: 'UNKNOWN' } });
  stats.add(row('START', '2026-10-01T08:00:00Z', '1'));
  assert.equal(stats.result().totalOrders, 1);
  assert.equal(stats.result().missingOrderTime, 1);
});
test('远端数据按真实结构解析，零值有效，缺字段不伪装为零', () => {
  assert.equal(parseRemoteMetric('publishedSku', { PUBLISHED: 0 }).value, 0);
  assert.throws(() => parseRemoteMetric('publishedSku', {}));
  assert.equal(
    parseRemoteMetric('otd', {
      status: 'OK',
      payload: { overallRate: 93.62, sellerAccountableRate: 100 },
    }).value,
    100,
  );
  assert.equal(parseRemoteMetric('vtr', { payload: { cumulativeRate: 100 } }).value, 100);
  assert.equal(
    parseRemoteMetric('negativeFeedback', { payload: { cumulativeRate: 0.8 } }).value,
    0.8,
  );
  assert.equal(
    parseRemoteMetric('lateShipment', { payload: { cumulativeRate: 0.0215 } }).value,
    2.15,
  );
  assert.throws(
    () => parseRemoteMetric('otd', { payload: { overallRate: 93.62, cumulativeRate: 80 } }),
    /卖家责任/,
  );
  assert.throws(() => parseRemoteMetric('srr', { payload: { cumulativeRate: null } }));
  const balance = parseRemoteMetric('settlement', {
    status: 'OK',
    payload: {
      accountSummary: {
        closingBalance: -10.25,
        scheduledSettlementDate: '2026-10-20',
        lastUpdatedDate: '2026-10-18',
      },
    },
  });
  assert.equal(balance.value, '-10.25');
  assert.equal(balance.scheduledSettlementDate, '2026-10-20');
});
test('新增绩效只取卖家责任率，不混入非卖家责任；小于 1 的百分数不放大', () => {
  for (const key of ['negativeFeedback', 'returns', 'itemNotReceived']) {
    assert.equal(parseRemoteMetric(key, { payload: { cumulativeRate: 0 } }).value, 0);
    assert.equal(parseRemoteMetric(key, { payload: { cumulativeRate: 0.7 } }).value, 0.7);
    assert.equal(
      parseRemoteMetric(key, {
        payload: { sellerAccountableRate: 0.8, cumulativeRate: 3, overallRate: 4 },
      }).value,
      0.8,
    );
    for (const invalid of [null, '', ' ', false, 'invalid', -1, 101]) {
      assert.throws(() => parseRemoteMetric(key, { payload: { cumulativeRate: invalid } }));
    }
    assert.throws(() => parseRemoteMetric(key, null));
    assert.throws(() => parseRemoteMetric(key, { payload: { overallRate: 3 } }));
  }
  assert.equal(parseRemoteMetric('otd', { payload: { sellerAccountableRate: 1 } }).value, 1);
  assert.equal(parseRemoteMetric('lateShipment', { payload: { cumulativeRate: 1 } }).value, 100);
});
test('单指标失败保留历史值及时间，其他接口正常采集，重试不重复请求成功指标', async () => {
  const previous = { publishedSku: { value: 9, status: 'ok', fetchedAt: 'old' } };
  let calls = 0;
  const client = {
    async request(path) {
      calls++;
      if (path.includes('items/count'))
        throw Object.assign(new Error('forbidden'), { apiStatus: 403 });
      if (path.includes('payment')) return { payload: { accountSummary: { closingBalance: 5 } } };
      return { payload: { cumulativeRate: 0.95, sellerAccountableRate: 0.95, overallRate: 0.9 } };
    },
  };
  const result = await fetchRemoteMetrics({}, previous, { client, now: new Date(now) });
  assert.equal(result.publishedSku.value, 9);
  assert.equal(result.publishedSku.fetchedAt, 'old');
  assert.match(result.publishedSku.error, /未授权/);
  assert.equal(result.srr.status, 'ok');
  calls = 0;
  await fetchRemoteMetrics({}, result, { client, retryOnly: true });
  assert.equal(calls, 1);
});
test('每日更新及重启补做、失败有限重试、更换密钥失效', () => {
  const store = { systemStoreName: 'A', clientId: 'id', clientSecret: 'secret' };
  const remote = Object.fromEntries(
    Object.keys(REMOTE_METRICS).map((key) => [key, { status: 'ok' }]),
  );
  const snapshot = {
    sourceKey: snapshotSource(store),
    snapshotDate: pstDay(now),
    attemptedAt: new Date(now),
    attempts: 1,
    remote,
  };
  assert.equal(snapshotDue(snapshot, store, now), false);
  // 北京时间已跨日时不能提前生成下一天；PST 午夜才重新统计。
  assert.equal(snapshotDue(snapshot, store, now + 8 * 3600000), false);
  assert.equal(snapshotDue(snapshot, store, now + 86400000 - 1), false);
  assert.equal(snapshotDue(snapshot, store, now + 86400000), true);
  assert.equal(snapshotDue(snapshot, { ...store, clientSecret: 'changed' }, now), true);
  snapshot.remote.srr.status = 'error';
  assert.equal(snapshotDue(snapshot, store, now + 1000), false);
  assert.equal(snapshotDue(snapshot, store, now + 15 * 60000), true);
  snapshot.attempts = 3;
  assert.equal(snapshotDue(snapshot, store, now + 60 * 60000), false);
});
