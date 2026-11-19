const DAY = 86400000;
const ORDER_START = '2026-10-01';
export const WALMART_PREVIEW_START = Date.parse('2026-10-01T00:00:00-08:00');
export const calendarDay = (date) =>
  [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((value, index) => String(value).padStart(index ? 2 : 4, '0'))
    .join('-');
const offsetDay = (now, hours) => new Date(now + hours * 3600000).toISOString().slice(0, 10);
const dayNumber = (value) => Date.parse(`${value}T00:00:00Z`);

export function dateBounds(policy, now = Date.now(), overrides = {}) {
  const chinaToday = offsetDay(now, 8),
    pstToday = offsetDay(now, -8);
  let bounds = {};
  if (policy === 'purchaseStatistics') bounds = { maxDate: offsetDay(now - DAY, 8), maxDays: 366 };
  if (policy === 'storeSummary' || policy === 'orderDate')
    bounds = { minDate: ORDER_START, maxDate: pstToday };
  if (policy === 'recordDate' || policy === 'auditDate') bounds = { maxDate: chinaToday };
  if (policy === 'auditDate') {
    // 与后端日志保留规则一致：两个自然月，月底回退到目标月最后一天。
    const date = new Date(`${chinaToday}T00:00:00Z`),
      day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - 2);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
    date.setUTCDate(Math.min(day, last.getUTCDate()));
    bounds.minDate = date.toISOString().slice(0, 10);
  }
  if (policy === 'walmartPreview')
    bounds = {
      minDate: calendarDay(new Date(WALMART_PREVIEW_START)),
      maxDate: calendarDay(new Date(now)),
      minTime: WALMART_PREVIEW_START,
      maxTime: now,
      maxDuration: 31 * DAY,
    };
  return { ...bounds, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v)) };
}

export function dateDisabled(date, bounds, anchor = null) {
  const value = calendarDay(date);
  if ((bounds.minDate && value < bounds.minDate) || (bounds.maxDate && value > bounds.maxDate))
    return true;
  const span = bounds.maxDays ? (bounds.maxDays - 1) * DAY : bounds.maxDuration;
  return !!(anchor && span && Math.abs(dayNumber(value) - dayNumber(calendarDay(anchor))) > span);
}

function validDay(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(dayNumber(value)) &&
    new Date(dayNumber(value)).toISOString().slice(0, 10) === value
  );
}

export function dateRangeError(values, bounds, { datetime = false, required = false } = {}) {
  if (!values || !values.length || values.every((value) => !value))
    return required ? '请选择完整的日期范围' : '';
  if (values.length !== 2 || values.some((value) => !value)) return '请选择完整的起止日期';
  const dates = [],
    times = [];
  for (const value of values) {
    if (datetime) {
      const date = value instanceof Date ? value : new Date(String(value).replace(' ', 'T'));
      if (!Number.isFinite(date.getTime())) return '日期或时间格式无效';
      if (typeof value === 'string') {
        const normalized = `${calendarDay(date)} ${[
          date.getHours(),
          date.getMinutes(),
          date.getSeconds(),
        ]
          .map((part) => String(part).padStart(2, '0'))
          .join(':')}`;
        if (normalized !== value) return '日期或时间格式无效';
      }
      dates.push(calendarDay(date));
      times.push(date.getTime());
    } else {
      const day = value instanceof Date ? calendarDay(value) : value;
      if (!validDay(day)) return '日期格式无效，请使用 YYYY-MM-DD';
      dates.push(day);
      times.push(dayNumber(day));
    }
  }
  if (times[0] > times[1]) return '开始日期不能晚于结束日期';
  if (bounds.minDate && dates[0] < bounds.minDate) return `最早可选择 ${bounds.minDate}`;
  if (bounds.maxDate && dates[1] > bounds.maxDate) return `最晚可选择 ${bounds.maxDate}`;
  if (bounds.minTime != null && times[0] < bounds.minTime) return '开始时间早于订单接入起点';
  if (bounds.maxTime != null && times[1] > bounds.maxTime) return '结束时间不能晚于当前时刻';
  if (bounds.maxDays && times[1] - times[0] >= bounds.maxDays * DAY)
    return `单次最多查询${bounds.maxDays}天（包含起止当天）`;
  if (bounds.maxDuration && times[1] - times[0] > bounds.maxDuration)
    return `单次最多查询${bounds.maxDuration / DAY}天`;
  return '';
}
