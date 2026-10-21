import { AppError, assert } from '../errors.js';

/** 列表 GET 接收 JSON 数组，导出 POST 接收数组；兼容旧客户端的单选值。 */
export function filterValues(input, message, options) {
  if (input == null || input === '') return [];
  let values = input;
  if (typeof values === 'string') {
    if (values.trim().startsWith('[')) {
      try {
        values = JSON.parse(values);
      } catch {
        throw new AppError(400, message);
      }
    } else values = [values];
  }
  assert(
    Array.isArray(values) &&
      values.length <= 200 &&
      values.every(
        (value) =>
          typeof value === 'string' &&
          value.trim() &&
          value.length <= 255 &&
          (!options || options.includes(value)),
      ),
    message,
  );
  return [...new Set(values)];
}
