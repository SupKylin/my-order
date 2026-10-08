import { CHINA_UTC_OFFSET } from './businessTime.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** 将平台发货日期转换为次日 15:00（北京时间）的 UTC 时间戳。 */
export function shippingDeadline(value) {
  if (!value) return '';
  const date = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const dateStart = Date.parse(`${date}T00:00:00${CHINA_UTC_OFFSET}`);
  if (!Number.isFinite(dateStart)) return '';
  const deadline = dateStart + DAY_MS + 15 * HOUR_MS;
  return Number.isFinite(deadline) ? deadline : '';
}

/** 日期字段按次日北京时间 15:00 截止，与中国时钟采用相同时间标准。 */
export function shippingWarning(value, now = Date.now()) {
  const deadline = shippingDeadline(value);
  if (!deadline) return '';
  const remaining = deadline - now;
  if (remaining < 0) return 'red';
  if (remaining <= DAY_MS) return 'orange';
  if (remaining <= 2 * DAY_MS) return 'yellow';
  return '';
}

/** 仅平台状态为已确认的明细参与预警，空状态和混合状态均不预警。 */
export function orderShippingWarning(row, now = Date.now()) {
  return row.platformOrderStatus === '已确认' ? shippingWarning(row.platformShipDate, now) : '';
}

/** 返回预警中的整小时倒计时，按向上取整避免隐藏不足一小时的剩余时间。 */
export function shippingRemainingHours(value, now = Date.now()) {
  const deadline = shippingDeadline(value);
  if (!deadline) return '';
  const remaining = deadline - now;
  if (remaining < 0) return '';
  return `不足${Math.ceil(remaining / HOUR_MS)}小时`;
}

export const shippingWarningLabels = {
  yellow: '≤48小时',
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
