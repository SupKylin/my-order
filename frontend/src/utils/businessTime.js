export const PLATFORM_TIME_LABEL = '美国东部标准时间 EST';
export const PLATFORM_UTC_OFFSET = '-05:00';
// EST 固定 UTC−5，不使用会自动切换夏令时的 America/New_York。
export const PLATFORM_TIME_ZONE = 'Etc/GMT+5';
export const CHINA_TIME_ZONE = 'Asia/Shanghai';

const clockFormatter = (timeZone) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
const chinaFormatter = clockFormatter(CHINA_TIME_ZONE);
const platformFormatter = clockFormatter(PLATFORM_TIME_ZONE);

/** 显式指定时区与 24 小时制，电脑本地时区不会影响显示。 */
function formatClock(formatter, now) {
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

export function businessClocks(now = Date.now()) {
  return {
    china: formatClock(chinaFormatter, now),
    platform: formatClock(platformFormatter, now),
  };
}
