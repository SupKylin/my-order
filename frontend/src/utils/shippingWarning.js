import { PLATFORM_UTC_OFFSET } from './businessTime.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 日期字段按固定 EST 当天末秒截止，与顶部美国时钟采用相同时间标准。 */
export function shippingWarning(value, now = Date.now()) {
  if (!value) return '';
  const date = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const deadline = Date.parse(`${date}T23:59:59${PLATFORM_UTC_OFFSET}`);
  if (!Number.isFinite(deadline)) return '';
  const remaining = deadline - now;
  if (remaining < 0) return 'red';
  if (remaining <= DAY_MS) return 'orange';
  if (remaining <= 2 * DAY_MS) return 'yellow';
  return '';
}

export const shippingWarningLabels = {
  yellow: '剩2天',
  orange: '≤24小时',
  red: '已逾期',
};

/** 使用服务端返回的全部筛选结果日期分组，与明细行共用预警规则。 */
export function countShippingWarnings(dates, now = Date.now()) {
  const counts = { yellow: 0, orange: 0, red: 0 };
  for (const { date, count } of dates) {
    const warning = shippingWarning(date, now);
    if (warning) counts[warning] += count;
  }
  return counts;
}
