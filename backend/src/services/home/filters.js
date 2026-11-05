import { assert } from '../../errors.js';
import { pstDay } from './statistics.js';

/** 首页维持原口径；店铺汇总显式传 summary，应用统一日期及店铺范围。 */
export function homeFilters(query = {}, now = Date.now()) {
  if (query.scope !== 'summary') return null;
  const today = pstDay(now);
  const date = (value) => {
    assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), '统计日期格式无效');
    const ms = Date.parse(`${value}T00:00:00-08:00`);
    assert(Number.isFinite(ms) && pstDay(ms) === value, '统计日期无效');
    return ms;
  };
  const defaultStart = pstDay(Date.parse(`${today}T00:00:00-08:00`) - 29 * 86400000);
  const startDate = query.startDate || defaultStart;
  const endDate = query.endDate || today;
  const start = date(startDate),
    end = date(endDate) + 86400000;
  assert(
    start < end && endDate <= today,
    '统计开始日期不能晚于结束日期，结束日期不能晚于今天（PST）',
  );
  assert(startDate >= '2026-10-01' || startDate === defaultStart, '统计数据从2026-10-01开始');
  let storeIds = query.storeIds || [];
  if (typeof storeIds === 'string') {
    try {
      storeIds = JSON.parse(storeIds);
    } catch {
      assert(false, '店铺筛选格式无效');
    }
  }
  assert(
    Array.isArray(storeIds) &&
      storeIds.length <= 1000 &&
      storeIds.every((id) => Number.isSafeInteger(id) && id > 0),
    '店铺筛选格式无效',
  );
  const ownerId = query.ownerId == null || query.ownerId === '' ? null : Number(query.ownerId);
  assert(ownerId === null || (Number.isSafeInteger(ownerId) && ownerId > 0), '所属账号筛选无效');
  return { startDate, endDate, start, end, storeIds, ownerId };
}
