import { createHash } from 'node:crypto';
import { fields, fieldMap } from '../fields.js';
import { decimalText } from './decimal.js';
import { storedChannels } from './channels.js';

/** 比较业务值，忽略数据库小数补零、空文本和多选顺序的表示差异。 */
export function comparableValue(key, value) {
  if (value == null || value === '') return null;
  const type = fieldMap[key]?.type;
  if (['money', 'decimal'].includes(type)) return decimalText(value);
  if (type === 'multiselect') {
    const values = [...(storedChannels(value) || [])].sort();
    return values.length ? values : null;
  }
  if (type === 'datetime') {
    if (value instanceof Date) return value.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
    // 带时区的 API 时间转换为编辑表单使用的北京时间。
    if (/[zZ]$|[+-]\d\d:\d\d$/.test(String(value)))
      return new Date(value).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
    return String(value).replace('T', ' ').slice(0, 19);
  }
  return value;
}

export function sameFieldValue(key, left, right) {
  return JSON.stringify(comparableValue(key, left)) === JSON.stringify(comparableValue(key, right));
}

/** 采购预览只保存摘要，不复制整份采购数据；平台同步不影响此摘要。 */
export function purchaseFingerprint(purchase) {
  const values = fields
    .filter((field) => field.group === 'purchase')
    .map(({ key }) => [key, comparableValue(key, purchase?.[key])]);
  values.push(['purchaseConfirmedAt', purchase?.purchaseConfirmedAt ?? null]);
  return createHash('sha256').update(JSON.stringify(values)).digest('hex');
}
