import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dateBounds,
  dateDisabled,
  dateRangeError,
  WALMART_PREVIEW_START,
} from '../src/utils/dateRanges.js';

const now = Date.parse('2026-11-17T00:00:00+08:00');
const local = (day) => new Date(`${day}T00:00:00`);
test('北京午夜与固定PST有不同截止日期；日志月底按两个月回退', () => {
  assert.equal(dateBounds('purchaseStatistics', now).maxDate, '2026-11-16');
  assert.equal(dateBounds('recordDate', now).maxDate, '2026-11-17');
  assert.deepEqual(dateBounds('orderDate', now), { minDate: '2026-10-01', maxDate: '2026-11-16' });
  assert.equal(
    dateBounds('auditDate', Date.parse('2026-04-30T23:00:00+08:00')).minDate,
    '2026-02-28',
  );
  assert.equal(
    dateBounds('auditDate', Date.parse('2024-04-30T00:00:00+08:00')).minDate,
    '2024-02-29',
  );
});
test('采购统计366天包含起止日，选中起点限制日历跨度，超过30天正常', () => {
  const bounds = dateBounds('purchaseStatistics', now);
  assert.equal(dateRangeError(['2026-10-01', '2026-11-16'], bounds), '');
  assert.equal(dateRangeError(['2025-11-16', '2026-11-16'], bounds), '');
  assert.match(dateRangeError(['2025-11-15', '2026-11-16'], bounds), /366/);
  assert.equal(dateDisabled(local('2026-11-17'), bounds), true);
  assert.equal(dateDisabled(local('2026-11-16'), bounds, local('2025-11-16')), false);
  assert.equal(dateDisabled(local('2025-11-15'), bounds, local('2026-11-16')), true);
});
test('手填无效日、反向或不完整区间拒绝；保留未来发货到货选择', () => {
  const record = dateBounds('recordDate', now);
  assert.match(dateRangeError(['2026-02-30', '2026-03-01'], record), /格式/);
  assert.match(dateRangeError(['2026-11-16', '2026-11-15'], record), /开始日期/);
  assert.match(dateRangeError(['2026-11-16', ''], record), /完整/);
  assert.match(dateRangeError(['2026-11-16', '2026-11-18'], record), /最晚/);
  assert.equal(dateRangeError([], record), '');
  assert.equal(dateRangeError(['2026-12-01', '2026-12-31'], dateBounds('', now)), '');
  const loaded = dateBounds('storeSummary', now, { minDate: '2026-10-18', maxDate: '2026-11-16' });
  assert.match(dateRangeError(['2026-10-17', '2026-11-16'], loaded), /最早/);
});
test('Walmart预览按真实时刻限定起点、现在和精确31天跨度', () => {
  const bounds = dateBounds('walmartPreview', now),
    options = { datetime: true, required: true };
  const end = new Date(now),
    start = new Date(now - 31 * 86400000);
  assert.equal(dateRangeError([start, end], bounds, options), '');
  assert.match(dateRangeError([new Date(start.getTime() - 1000), end], bounds, options), /31天/);
  assert.match(dateRangeError([start, new Date(now + 1000)], bounds, options), /当前/);
  assert.match(
    dateRangeError([new Date(WALMART_PREVIEW_START - 1000), end], bounds, options),
    /最早|起点/,
  );
  assert.match(dateRangeError([], bounds, options), /完整/);
  assert.match(
    dateRangeError(['2026-02-30 00:00:00', '2026-03-01 00:00:00'], bounds, options),
    /格式/,
  );
});
