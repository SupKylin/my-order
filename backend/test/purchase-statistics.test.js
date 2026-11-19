import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY,
  beijingDay,
  nextMidnight,
  groupStatistics,
  statisticsFilters,
  buildReport,
  statusCategory,
} from '../src/services/purchase-statistics/statistics.js';
import { startPurchaseStatisticsScheduler } from '../src/services/purchase-statistics/index.js';

const now = Date.parse('2026-11-17T00:00:00+08:00');
test('北京时间午夜归属前一统计日，支持跨月跨年，校验日期范围与渠道', () => {
  assert.equal(beijingDay(now - 1), '2026-11-16');
  assert.equal(nextMidnight(now - 1), now);
  assert.equal(
    nextMidnight(Date.parse('2026-12-31T23:59:59+08:00')),
    Date.parse('2027-01-01T00:00:00+08:00'),
  );
  assert.deepEqual(statisticsFilters({}, now), {
    startDate: '2026-10-18',
    endDate: '2026-11-16',
    channels: [],
    page: 1,
    pageSize: 20,
  });
  for (const query of [
    { startDate: '2026-02-30' },
    { endDate: '2026-11-17' },
    { startDate: '2026-11-16', endDate: '2026-11-15' },
    { startDate: '2024-01-01' },
    { channels: 'bad' },
    { channels: '[null]' },
    { page: -1 },
    { pageSize: 1000 },
  ])
    assert.throws(() => statisticsFilters(query, now));
  assert.deepEqual(statisticsFilters({ channels: '["A","A","B"]' }, now).channels, ['A', 'B']);
});
test('复用三种成功状态，砍单为失败，取消及空值归其他', () => {
  for (const value of [
    '采购成功（未出跟踪号）',
    '采购成功(已出跟踪号)',
    ' 采购成功 （已发货无单号） ',
  ])
    assert.equal(statusCategory(value), 'success');
  for (const value of ['采购失败', '采购成功（砍单）'])
    assert.equal(statusCategory(value), 'failed');
  assert.equal(statusCategory('采购中'), 'inProgress');
  for (const value of [null, '', '取消采购', '自定义'])
    assert.equal(statusCategory(value), 'other');
});
test('渠道组合各计一次，整体去重；最新一期不跨日叠加，整体不随渠道筛选', () => {
  const input = [
    { shopName: 'A', channels: '["甲","乙","甲"]', status: '采购成功（已出跟踪号）', count: 2 },
    { shopName: 'A', channels: '["乙","甲"]', status: '采购中', count: 1 },
    { shopName: 'B', channels: '甲', status: '采购成功（砍单）', count: 1 },
    { shopName: 'B', channels: null, status: null, count: 3 },
    { shopName: 'B', channels: '[]', status: '取消采购', count: 1 },
  ];
  const groups = groupStatistics(input).map((row) => ({ ...row, date: '2026-11-16' }));
  assert.equal(groups.length, 3);
  const snapshots = [
    { date: '2026-11-16', capturedAt: new Date(now) },
    { date: '2026-11-15', capturedAt: new Date(now - DAY) },
  ];
  groups.push({ ...groups[0], date: '2026-11-15', total: 100 });
  const report = buildReport(snapshots, groups, { channels: ['甲'], page: 1, pageSize: 20 });
  assert.equal(report.summary.total, 8);
  assert.equal(report.summary.unassigned, 4);
  assert.equal(report.summary.unassignedRate, 50);
  assert.equal(report.summary.successRate, 25);
  assert.equal(report.rows[0].total, 4);
  assert.equal(report.rows[0].failureRate, 25);
  assert.equal(report.rows[1].date, '2026-11-15');
  assert.deepEqual(
    report.channels,
    ['甲', '乙'].sort((a, b) => a.localeCompare(b, 'zh-CN')),
  );
  const none = buildReport(snapshots, groups, { channels: ['不存在'], page: 1, pageSize: 20 });
  assert.equal(none.rows.length, 0);
  assert.equal(none.summary.total, 8);
  assert.equal(buildReport([], [], { channels: [], page: 1, pageSize: 20 }).summary, null);
  assert.equal(
    buildReport(snapshots, [], { channels: [], page: 1, pageSize: 20 }).summary.successRate,
    0,
  );
});
test('定时器午夜执行、失败重试、下一日安排与停止；白天启动不伪造历史', async () => {
  let time = now - 1000,
    task,
    delay,
    attempts = 0,
    cleared = false;
  const stop = startPurchaseStatisticsScheduler({
    clock: () => time,
    setTimer: (fn, ms) => {
      task = fn;
      delay = ms;
      return { unref() {} };
    },
    clearTimer: () => {
      cleared = true;
    },
    capture: async (input) => {
      attempts++;
      assert.equal(input.scheduledAt, now);
      if (attempts === 1) throw Error('retry');
    },
  });
  assert.equal(delay, 1000);
  time = now;
  task();
  await new Promise(setImmediate);
  assert.equal(delay, 60000);
  time += 60000;
  task();
  await new Promise(setImmediate);
  assert.equal(attempts, 2);
  assert.equal(delay, DAY - 60000);
  await stop();
  assert.ok(cleared);
  task();
  assert.equal(attempts, 2);
  time = now + 12 * 3600000;
  const stop2 = startPurchaseStatisticsScheduler({
    clock: () => time,
    setTimer: (_, ms) => {
      delay = ms;
      return {};
    },
    clearTimer: () => {},
    capture: async () => assert.fail(),
  });
  assert.equal(delay, 12 * 3600000);
  await stop2();
});
