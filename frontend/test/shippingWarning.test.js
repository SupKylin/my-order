import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shippingWarning,
  shippingRemainingHours,
  countShippingWarnings,
} from '../src/utils/shippingWarning.js';

test('平台发货预警按次日北京时间 15:00 截止，正确处理 48/24 小时及逾期边界', () => {
  const deadline = Date.parse('2026-10-03T15:00:00+08:00');
  const hour = 60 * 60 * 1000;
  for (const [remaining, expected] of [
    [48 * hour + 1, ''],
    [48 * hour, 'yellow'],
    [24 * hour + 1, 'yellow'],
    [24 * hour, 'orange'],
    [0, 'orange'],
    [-1, 'red'],
  ]) {
    assert.equal(shippingWarning('2026-10-02', deadline - remaining), expected);
  }
  assert.equal(shippingWarning('2026-10-02', Date.parse('2026-10-02T00:00:00+08:00')), 'yellow');
  assert.equal(shippingWarning('2026-10-02', Date.parse('2026-10-03T00:00:00+08:00')), 'orange');
  // 相同瞬间使用 UTC 表示时，仍按北京时间次日 15:00 的截止点计算。
  assert.equal(shippingWarning('2026-10-02', Date.parse('2026-10-03T07:00:00Z')), 'orange');
  assert.equal(shippingWarning('2026-10-02', Date.parse('2026-10-03T07:00:01Z')), 'red');
  assert.equal(shippingRemainingHours('2026-10-02', deadline - 5 * hour - 1), '不足6小时');
});

test('缺少或无法识别的平台发货日期不预警', () => {
  for (const value of [null, undefined, '', '无日期', '2026-13-40']) {
    assert.equal(shippingWarning(value), '');
  }
});

test('北京时间次日 15:00 截止，夏季也不会改变截止点', () => {
  const hour = 60 * 60 * 1000;
  for (const date of ['2026-01-15', '2026-07-15']) {
    const deadline = Date.parse(`${date}T00:00:00+08:00`) + 24 * hour + 15 * hour;
    assert.equal(shippingWarning(date, deadline), 'orange');
    assert.equal(shippingWarning(date, deadline + 1), 'red');
  }
  assert.equal(shippingWarning('2026-07-15', Date.parse('2026-07-16T14:30:00+08:00')), 'orange');
  assert.equal(shippingWarning('2026-07-15', Date.parse('2026-07-16T15:00:01+08:00')), 'red');
});

test('预警数量按日期分组加总，跨过午夜后同步重新分类', () => {
  const dates = [
    { date: '2026-10-01', count: 3 },
    { date: '2026-10-02', count: 5 },
    { date: '2026-10-03', count: 7 },
    { date: '2026-10-04', count: 9 },
    { date: null, count: 11 },
  ];
  assert.deepEqual(countShippingWarnings(dates, Date.parse('2026-10-02T12:00:00+08:00')), {
    yellow: 5,
    orange: 3,
    red: 0,
  });
  assert.deepEqual(countShippingWarnings(dates, Date.parse('2026-10-03T00:00:00+08:00')), {
    yellow: 7,
    orange: 5,
    red: 3,
  });
  assert.deepEqual(countShippingWarnings([]), { yellow: 0, orange: 0, red: 0 });
});
