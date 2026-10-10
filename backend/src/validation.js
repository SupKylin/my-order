import { fields, fieldMap } from './fields.js';
import { AppError } from './errors.js';
import { decimalText, expandNumericValue } from './lib/decimal.js';
import { normalizeChannels } from './lib/channels.js';
import { walmartImage } from './lib/product-image.js';
export const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && !v.trim());
const localDate = (v) => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  const str = String(v)
    .trim()
    .replace(/[年/.]/g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, '');
  const match = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/);
  if (!match) return '';
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(+y, +m - 1, +d));
  if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +m - 1 || date.getUTCDate() !== +d)
    return '';
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
};
export function normalizeValue(f, value) {
  if (isBlank(value)) return null;
  if (f.type === 'multiselect') return normalizeChannels(value, f.options);
  if (f.type === 'date') {
    const result = localDate(value);
    if (!result) throw new Error('请输入有效日期，如 2026-09-30');
    return result;
  }
  if (f.type === 'datetime') {
    if (value instanceof Date && !Number.isNaN(value.getTime()))
      return value.toISOString().slice(0, 19).replace('T', ' ');
    const date = localDate(value);
    const time = String(value).match(/[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!date || (time && (+time[1] > 23 || +time[2] > 59 || +(time[3] || 0) > 59)))
      throw new Error('请输入有效日期和时间');
    return `${date} ${time ? `${time[1].padStart(2, '0')}:${time[2]}:${time[3] || '00'}` : '00:00:00'}`;
  }
  if (['money', 'decimal', 'integer'].includes(f.type)) {
    const raw = expandNumericValue(value)
      .trim()
      .replace(/^[¥￥$]\s*/, '')
      .replace(/,/g, '');
    if (!/^(?:\d+)(?:\.\d+)?$/.test(raw)) throw new Error('请输入非负数字');
    const [whole, fraction = ''] = raw.split('.');
    if (BigInt(whole) > 999999999999n) throw new Error('数字超出允许范围');
    if (f.type === 'integer') {
      const num = Number(raw);
      if (!Number.isInteger(num) || num < 1 || num > 1000000)
        throw new Error('数量应为 1 至 1000000 的整数');
      return num;
    }
    if (fraction.length > 20) throw new Error('最多支持 20 位小数');
    return decimalText(raw, f.type === 'money' ? 2 : 4);
  }
  let text = String(value).trim();
  if (f.type === 'select') {
    if (f.options.includes(text)) return text;
    if (f.options.includes('是')) {
      if (['true', '1', 'yes', 'y'].includes(text.toLowerCase())) text = '是';
      if (['false', '0', 'no', 'n'].includes(text.toLowerCase())) text = '否';
    }
    if (f.key === 'orderStatus') text = text.replace(/,/g, '，');
    const canonical = f.options.find(
      (s) =>
        s.replace(/[\s（）()]/g, '').toLowerCase() ===
        text.replace(/[\s（）()]/g, '').toLowerCase(),
    );
    if (!canonical) throw new Error(`不在下拉选项中：${text}`);
    return canonical;
  }
  if (f.type === 'url' && !/^https?:\/\/[^\s]+$/i.test(text))
    throw new Error('链接必须以 http:// 或 https:// 开头');
  if (
    f.type === 'image' &&
    !/^\/uploads\/images\/[0-9a-f-]{36}\.webp$/.test(text) &&
    !(f.key === 'productImage' && walmartImage(text))
  )
    throw new Error('请上传图片，或使用 Excel 嵌入图片');
  const max = ['textarea', 'url', 'image'].includes(f.type)
    ? 12000
    : ['orderNumber', 'walmartSku', 'purchaseSku'].includes(f.key)
      ? 191
      : 255;
  if (text.length > max) throw new Error(`内容不能超过 ${max} 个字符`);
  return text;
}
export function validatePatch(
  input,
  { skipBlank = false, requireKeys = false, fieldDefinitions = fields } = {},
) {
  const allowedFields = Object.fromEntries(fieldDefinitions.map((field) => [field.key, field]));
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new AppError(400, '字段格式错误');
  const patch = {},
    errors = [];
  if (Object.hasOwn(input, 'sku') && Object.hasOwn(input, 'walmartSku'))
    throw new AppError(400, 'SKU 与 WalmartSku 不能同时提交');
  for (const [inputKey, value] of Object.entries(input)) {
    const key = inputKey === 'sku' ? 'walmartSku' : inputKey;
    if (!Object.hasOwn(allowedFields, key)) throw new AppError(400, `不支持的字段：${inputKey}`);
    const f = allowedFields[key];
    if (skipBlank && isBlank(value)) continue;
    try {
      const normalized = normalizeValue(f, value);
      if (f.required && isBlank(normalized)) throw new Error('此字段不能为空');
      patch[key] = normalized;
    } catch (e) {
      errors.push({ field: key, label: f.label, message: e.message });
    }
  }
  if (requireKeys)
    for (const f of fieldDefinitions.filter((f) => f.required))
      if (isBlank(patch[f.key]) && !errors.some((e) => e.field === f.key))
        errors.push({ field: f.key, label: f.label, message: '此字段不能为空' });
  if (errors.length) throw new AppError(400, '字段校验未通过', errors);
  return patch;
}
export function validateTemplate(input) {
  const name = String(input.name || '').trim();
  const sheetName = String(input.sheetName || '').trim();
  const headerRow = Number(input.headerRow);
  if (
    !name ||
    name.length > 100 ||
    sheetName.length > 100 ||
    !Number.isInteger(headerRow) ||
    headerRow < 1 ||
    headerRow > 100
  )
    throw new AppError(400, '请填写模板名称和有效表头行');
  if (!Array.isArray(input.mappings) || input.mappings.length < 1)
    throw new AppError(400, '请至少映射订单号');
  if (
    input.mappings.some(
      (mapping) => !mapping || typeof mapping !== 'object' || Array.isArray(mapping),
    )
  )
    throw new AppError(400, '映射关系格式无效，请删除无效关系后重新添加');
  if (input.mappings.length > 500) throw new AppError(400, '最多支持 500 个 Excel 源列');
  // 未选目标的源列仍需保存，只有未填写任何内容的新增草稿可以丢弃。
  const selected = input.mappings.filter((mapping) => !isBlank(mapping.field));
  if (selected.length > fields.length)
    throw new AppError(400, `最多支持 ${fields.length} 条映射，请删除重复或多余的关系`);
  const mappings = input.mappings
    .filter((m) => !isBlank(m.column) || !isBlank(m.header) || !isBlank(m.field))
    .map((m) => ({
      column: Number(m.column),
      header: String(m.header || ''),
      field: isBlank(m.field) ? '' : m.field === 'sku' ? 'walmartSku' : m.field,
    }));
  const columns = new Map(),
    targets = new Map();
  for (const [index, m] of mappings.entries()) {
    const label = `第 ${index + 1} 条映射`;
    if (!Number.isInteger(m.column) || m.column < 1 || m.column > 500)
      throw new AppError(400, `${label}：Excel 列号必须是 1 至 500 的整数`);
    if (!m.field) continue;
    if (typeof m.field !== 'string' || !Object.hasOwn(fieldMap, m.field))
      throw new AppError(400, `${label}：请选择有效的系统字段`);
    if (columns.has(m.column))
      throw new AppError(
        400,
        `${label}：Excel 第 ${m.column} 列已被第 ${columns.get(m.column)} 条使用，请修改或删除重复关系`,
      );
    if (targets.has(m.field))
      throw new AppError(
        400,
        `${label}：系统字段“${fieldMap[m.field].label}”已被第 ${targets.get(m.field)} 条使用，请修改或删除重复关系`,
      );
    columns.set(m.column, index + 1);
    targets.set(m.field, index + 1);
  }
  if (!targets.has('orderNumber')) throw new AppError(400, '必须映射订单号');
  return { name, sheetName, headerRow, mappings };
}
