/** 页面展示日期固定按业务时区，避免不同电脑时区造成日期错觉。 */
export const fmtDate = (value, time = false) => {
  if (!value) return '—';
  if (!time) return String(value).slice(0, 10);
  return new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
};
/** 保留实际小数精度，金额展示不经过浮点数或四舍五入。 */
export const money = (value) => {
  if (value === null || value === undefined || value === '') return '—';
  const [whole, fraction = ''] = String(value).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`;
};
