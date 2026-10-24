const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

export const DERIVED_PURCHASE_FIELDS = new Set(['purchaseLimit', 'priceFactor']);

function parseDecimal(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!DECIMAL_PATTERN.test(text)) return null;
  const [integer, fraction = ''] = text.split('.');
  return {
    integer: BigInt(integer + fraction),
    scale: fraction.length,
  };
}

function align(left, right) {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.integer * 10n ** BigInt(scale - left.scale),
    right.integer * 10n ** BigInt(scale - right.scale),
    scale,
  ];
}

function add(left, right) {
  const [a, b, scale] = align(left, right);
  return { integer: a + b, scale };
}

function multiply(left, right) {
  return { integer: left.integer * right.integer, scale: left.scale + right.scale };
}

function roundedRatio(numerator, denominator, digits) {
  const scaledNumerator = numerator.integer * 10n ** BigInt(denominator.scale + digits);
  const scaledDenominator = denominator.integer * 10n ** BigInt(numerator.scale);
  let quotient = scaledNumerator / scaledDenominator;
  const remainder = scaledNumerator % scaledDenominator;
  if (remainder * 2n >= scaledDenominator) quotient += 1n;
  const text = quotient.toString().padStart(digits + 1, '0');
  return `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

const ONE_POINT_ONE = parseDecimal('1.1');
const ZERO_POINT_EIGHT_FIVE = parseDecimal('0.85');

/**
 * 根据订单金额、税费和采购商品链接金额计算系统派生采购字段。
 * 计算全程使用 BigInt，避免浮点数在金额和系数上的舍入误差。
 */
export function derivePurchaseFields({ orderAmount, tax, purchaseLinkAmount }) {
  const order = parseDecimal(orderAmount);
  const link = parseDecimal(purchaseLinkAmount);
  const taxValue = tax === null || tax === undefined || tax === '' ? { integer: 0n, scale: 0 } : parseDecimal(tax);
  if (!order || !link || !taxValue) return { purchaseLimit: null, priceFactor: null };
  const denominator = add(link, taxValue);
  if (denominator.integer <= 0n) return { purchaseLimit: null, priceFactor: null };
  return {
    purchaseLimit: roundedRatio(multiply(link, ONE_POINT_ONE), { integer: 1n, scale: 0 }, 2),
    priceFactor: roundedRatio(multiply(order, ZERO_POINT_EIGHT_FIVE), denominator, 4),
  };
}
