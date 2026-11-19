import { assert } from '../../errors.js';
import { storedChannels } from '../../lib/channels.js';
import { isPurchaseSuccess } from '../../lib/purchase-timer.js';

export const DAY = 86400000;
export const beijingDay = (now = Date.now()) =>
  new Date(Number(now) + 8 * 3600000).toISOString().slice(0, 10);
export const midnight = (now = Date.now()) => Date.parse(`${beijingDay(now)}T00:00:00+08:00`);
export const nextMidnight = (now = Date.now()) => midnight(now) + DAY;
export const emptyCounts = () => ({
  total: 0,
  success: 0,
  failed: 0,
  inProgress: 0,
  other: 0,
  unassigned: 0,
});
export function statusCategory(status) {
  if (isPurchaseSuccess(status)) return 'success';
  const normalized = String(status || '').replace(/[\s（）()]/g, '');
  if (['采购失败', '采购成功砍单'].includes(normalized)) return 'failed';
  return normalized === '采购中' ? 'inProgress' : 'other';
}
export function groupStatistics(rows) {
  const groups = new Map();
  for (const row of rows) {
    const channels = [
      ...new Set((storedChannels(row.channels) || []).filter((value) => value.trim())),
    ].sort();
    const key = JSON.stringify([row.shopName, channels]);
    if (!groups.has(key)) groups.set(key, { shopName: row.shopName, channels, ...emptyCounts() });
    const group = groups.get(key),
      count = Number(row.count);
    group.total += count;
    group[statusCategory(row.status)] += count;
  }
  return [...groups.values()];
}
export function addCounts(target, source) {
  for (const key of ['total', 'success', 'failed', 'inProgress', 'other'])
    target[key] += Number(source[key]);
  if (!source.channels.length) target.unassigned += Number(source.total);
}
export function withRates(counts) {
  const percent = (value) => (counts.total ? Number(((value * 100) / counts.total).toFixed(2)) : 0);
  return {
    ...counts,
    successRate: percent(counts.success),
    failureRate: percent(counts.failed),
    inProgressRate: percent(counts.inProgress),
    unassignedRate: percent(counts.unassigned),
  };
}
export function statisticsFilters(query = {}, now = Date.now()) {
  const yesterday = beijingDay(midnight(now) - 1);
  const startDate = query.startDate || beijingDay(midnight(now) - 30 * DAY);
  const endDate = query.endDate || yesterday;
  for (const date of [startDate, endDate]) {
    assert(typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date), '统计日期格式无效');
    const time = Date.parse(`${date}T00:00:00+08:00`);
    assert(Number.isFinite(time) && beijingDay(time) === date, '统计日期无效');
  }
  assert(startDate <= endDate && endDate <= yesterday, '请选择已结束的统计日期，开始不能晚于结束');
  assert(Date.parse(endDate) - Date.parse(startDate) < 366 * DAY, '单次最多查询366天');
  let channels = query.channels || [];
  if (typeof channels === 'string') {
    try {
      channels = JSON.parse(channels);
    } catch {
      assert(false, '采购渠道筛选格式无效');
    }
  }
  assert(
    Array.isArray(channels) &&
      channels.length <= 100 &&
      channels.every((v) => typeof v === 'string' && v.length > 0 && v.length <= 255),
    '采购渠道筛选格式无效',
  );
  const page = Number(query.page || 1),
    pageSize = Number(query.pageSize || 20);
  assert(
    Number.isSafeInteger(page) && page >= 1 && page <= 100000 && [20, 50, 100].includes(pageSize),
    '分页参数无效',
  );
  return { startDate, endDate, channels: [...new Set(channels)], page, pageSize };
}

export function buildReport(snapshots, groups, filters) {
  const dates = new Map(snapshots.map((snapshot) => [snapshot.date, snapshot]));
  const latest = snapshots[0] || null;
  const overall = latest ? emptyCounts() : null;
  const rows = new Map(),
    channels = new Set();
  for (const group of groups) {
    if (!dates.has(group.date)) continue;
    if (latest?.date === group.date) addCounts(overall, group);
    for (const channel of new Set(group.channels)) {
      channels.add(channel);
      if (filters.channels.length && !filters.channels.includes(channel)) continue;
      const key = JSON.stringify([group.date, channel]);
      if (!rows.has(key)) rows.set(key, { ...dates.get(group.date), channel, ...emptyCounts() });
      addCounts(rows.get(key), group);
    }
  }
  const all = [...rows.values()].sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      b.total - a.total ||
      a.channel.localeCompare(b.channel, 'zh-CN'),
  );
  return {
    ...filters,
    snapshotCount: snapshots.length,
    summary: latest ? { ...latest, ...withRates(overall) } : null,
    channels: [...channels].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    rows: all
      .slice((filters.page - 1) * filters.pageSize, filters.page * filters.pageSize)
      .map(withRates),
    total: all.length,
  };
}
