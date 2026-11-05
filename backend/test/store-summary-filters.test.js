import test from 'node:test';
import assert from 'node:assert/strict';
import { homeFilters } from '../src/services/home/filters.js';
import { dailyDates } from '../src/services/home/daily.js';
const now = Date.parse('2026-11-05T07:30:00Z'); // PST仍为11月4日
test('全局默认近30天含今天，以PST为准；首页原默认口径保留', () => {
  assert.equal(homeFilters({}, now), null);
  const range = homeFilters({ scope: 'summary' }, now);
  assert.equal(range.startDate, '2026-10-06');
  assert.equal(range.endDate, '2026-11-04');
  assert.equal(dailyDates(now, range).length, 30);
  assert.equal(dailyDates(now, range)[0], '2026-11-04');
  const custom = homeFilters(
    {
      scope: 'summary',
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      storeIds: '[1,2]',
      ownerId: '3',
    },
    now,
  );
  assert.deepEqual(dailyDates(now, custom), ['2026-10-02', '2026-10-01']);
  assert.equal(custom.start, Date.parse('2026-10-01T08:00:00Z'));
  assert.equal(custom.end, Date.parse('2026-10-03T08:00:00Z'));
  assert.deepEqual(custom.storeIds, [1, 2]);
});
test('拒绝非法日期、倒置日期、未来日期和非法账号/店铺参数', () => {
  for (const patch of [
    { startDate: '2026-10-32' },
    { startDate: '2026-11-03', endDate: '2026-11-02' },
    { startDate: '2000-01-01' },
    { endDate: '2026-11-05' },
    { storeIds: '["1"]' },
    { storeIds: '{}' },
    { storeIds: 'bad' },
    { ownerId: '-1' },
    { ownerId: 'admin' },
  ])
    assert.throws(() => homeFilters({ scope: 'summary', ...patch }, now));
});
