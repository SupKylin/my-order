/** 全程使用十进制字符串，避免 Number/toFixed 截断超过浮点精度的小数。 */
export function decimalText(value, minimumDigits = 0) {
  const [integer, fraction = ''] = String(value).split('.');
  const digits = fraction.replace(/0+$/, '').padEnd(minimumDigits, '0');
  return `${integer.replace(/^0+(?=\d)/, '')}${digits ? `.${digits}` : ''}`;
}

/** Excel 数值可能以科学计数法返回；展开表示，不做浮点运算。 */
export function expandNumericValue(value) {
  const text = String(value);
  if (typeof value !== 'number' || !/e/i.test(text)) return text;
  const [coefficient, exponent] = text.toLowerCase().split('e');
  const [whole, fraction = ''] = coefficient.split('.');
  const digits = whole + fraction;
  const position = whole.length + Number(exponent);
  if (position <= 0) return `0.${'0'.repeat(-position)}${digits}`;
  if (position >= digits.length) return digits.padEnd(position, '0');
  return `${digits.slice(0, position)}.${digits.slice(position)}`;
}
