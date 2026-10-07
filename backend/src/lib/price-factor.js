// 系数原字段允许自由文本；只给完整的十进制数字分级，不把“待定”等文本转成 0。
// 展示和 SQL 筛选共用正则，按数字位比较，避免长小数在 0.8 / 0.85 边界被舍入。
export const priceFactorPatterns = {
  numeric: '^ *[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+) *$',
  high: '^ *[+]?0*([1-9]|[.](8[5-9]|9))',
  medium: '^ *[+]?0*[.]8([0-4]| *$)',
};

export function priceFactorLevel(value) {
  if (value == null || !new RegExp(priceFactorPatterns.numeric).test(String(value))) return null;
  if (new RegExp(priceFactorPatterns.high).test(String(value))) return 'high';
  if (new RegExp(priceFactorPatterns.medium).test(String(value))) return 'medium';
  return 'low';
}
