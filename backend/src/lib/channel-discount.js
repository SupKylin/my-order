import { assert } from '../errors.js';
import { parseDecimal, multiply, roundedRatio } from './purchase-derived.js';

export const discountInputs = {
  channelExchangeRate: '采购渠道汇率',
  currentExchangeRate: '当前实时汇率',
  taxMultiplier: '税金',
};
export const shippingModes = ['FBA', 'FBM'];
export const modeDiscountKey = (mode, key) =>
  `${mode.toLowerCase()}${key[0].toUpperCase()}${key.slice(1)}`;
export function modeChannelDiscount(input, mode) {
  const values = channelDiscount(
    Object.fromEntries(
      Object.keys(discountInputs).map((key) => [key, input[modeDiscountKey(mode, key)]]),
    ),
  );
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [modeDiscountKey(mode, key), value]),
  );
}
const blank = (value) => value == null || String(value).trim() === '';
const bounded = (text, label) => {
  assert(text.split('.')[0].length <= 16, `${label}计算结果超出允许范围`);
  return text;
};

/** 税金直接作为乘数；不转换百分比。旧渠道允许尚未配置，但不能只填一部分。 */
export function channelDiscount(input) {
  const keys = Object.keys(discountInputs);
  if (keys.every((key) => blank(input[key])))
    return Object.fromEntries([...keys, 'purchaseDiscount'].map((key) => [key, null]));
  const values = {};
  for (const key of keys) {
    const text = String(input[key] ?? '').trim();
    assert(
      /^\d{1,12}(?:\.\d{1,2})?$/.test(text),
      `${discountInputs[key]}须为非负数字，最多2位小数`,
    );
    values[key] = text;
  }
  const denominator = parseDecimal(values.currentExchangeRate);
  assert(denominator.integer > 0n, '当前实时汇率必须大于0');
  return {
    ...values,
    purchaseDiscount: bounded(
      roundedRatio(
        multiply(parseDecimal(values.channelExchangeRate), parseDecimal(values.taxMultiplier)),
        denominator,
        4,
      ),
      '采购折扣',
    ),
  };
}

export function purchaseCost(discount, amount) {
  const value = parseDecimal(amount);
  assert(value && String(amount).trim().length <= 40, '已结算订单的采购金额须为有效非负数字');
  const rate = parseDecimal(discount);
  assert(rate, '成本计算渠道尚未配置采购折扣');
  return bounded(roundedRatio(multiply(rate, value), { integer: 1n, scale: 0 }, 2), '采购成本');
}
