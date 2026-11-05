// 表单预览使用整数小数运算；最终校验及快照由服务端完成。
export function fixedDecimal(value, digits) {
  const [whole, fraction = ''] = String(value).split('.');
  return `${whole}.${fraction.padEnd(digits, '0').slice(0, digits)}`;
}
function decimal(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,16}(?:\.\d{1,20})?$/.test(text)) return null;
  const [whole, fraction = ''] = text.split('.');
  return { value: BigInt(whole + fraction), scale: 10n ** BigInt(fraction.length) };
}
function ratio(numerator, denominator, digits) {
  if (denominator <= 0n) return null;
  const scaled = numerator * 10n ** BigInt(digits);
  const rounded = scaled / denominator + ((scaled % denominator) * 2n >= denominator ? 1n : 0n);
  const text = rounded.toString().padStart(digits + 1, '0');
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}
export function discountPreview({ channelExchangeRate, currentExchangeRate, taxMultiplier }) {
  const a = decimal(channelExchangeRate),
    b = decimal(currentExchangeRate),
    c = decimal(taxMultiplier);
  return a && b && c ? ratio(a.value * c.value * b.scale, a.scale * c.scale * b.value, 4) : null;
}
export function costPreview(discount, amount) {
  const a = decimal(discount),
    b = decimal(amount);
  return a && b ? ratio(a.value * b.value, a.scale * b.scale, 2) : null;
}
