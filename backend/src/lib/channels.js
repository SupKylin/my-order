import { optionKey } from '../dictionaries.js';

/** 兼容历史单选文本；新值以 JSON 数组保存，名称内的斜杠不再产生存储歧义。 */
export function storedChannels(value) {
  if (value == null || value === '') return null;
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) return parsed;
  } catch {}
  return [String(value)];
}

/** Excel 用 / 分隔多选值；先匹配完整名称，再从最长候选组合中查找有效拆分。 */
export function normalizeChannels(value, options) {
  const byKey = new Map(options.map((option) => [optionKey(option), option]));
  const canonical = (entry) =>
    typeof entry === 'string' ? byKey.get(optionKey(entry)) : undefined;
  let values;
  if (Array.isArray(value)) {
    values = value.map((entry) => {
      const result = canonical(entry);
      if (!result) throw new Error(`不在采购渠道选项中：${String(entry)}`);
      return result;
    });
  } else {
    const text = String(value).trim();
    if (text.length > 12000) throw new Error('采购渠道内容过长');
    const exact = canonical(text);
    if (exact) return [exact];
    const parts = text.split('/');
    if (parts.length > 100) throw new Error('采购渠道分隔数量过多');
    const suffixes = new Map([[parts.length, []]]);
    for (let start = parts.length - 1; start >= 0; start--) {
      for (let end = parts.length; end > start; end--) {
        const match = canonical(parts.slice(start, end).join('/'));
        if (match && suffixes.has(end)) {
          suffixes.set(start, [match, ...suffixes.get(end)]);
          break;
        }
      }
    }
    values = suffixes.get(0);
    if (!values) throw new Error(`采购渠道无法匹配，请检查用 / 分隔的每个渠道：${text}`);
  }
  if (values.length > 100) throw new Error('最多选择 100 个采购渠道');
  return values.length ? [...new Set(values)] : null;
}
