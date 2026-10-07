const DAY_MS = 86400000;
// 平台日期按次日北京时间 15:00 截止，与前端预警一致。
const DEADLINE_OFFSET_MS = DAY_MS + 7 * 3600000;

export function shippingWindow(now = Date.now()) {
  const firstDay = Math.ceil((now - DEADLINE_OFFSET_MS) / DAY_MS);
  const lastDay = Math.floor((now + DAY_MS - DEADLINE_OFFSET_MS) / DAY_MS);
  const date = (day) => new Date(day * DAY_MS).toISOString().slice(0, 10);
  return { first: date(firstDay), last: date(lastDay) };
}
