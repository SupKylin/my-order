import { AsyncLocalStorage } from 'node:async_hooks';

export const auditContext = new AsyncLocalStorage();
const secrets = /password|secret|token|cookie|authorization|clientId|sessionVersion/i;
const omitted = new Set(['walmart', 'rows', 'errors', 'warnings', 'templateSnapshot', 'raw']);
/** 凭据永不落日志；大快照只记摘要，字段修改保留必要的前后值。 */
export function safeAuditValue(value, key = '', depth = 0) {
  if (secrets.test(key))
    return value && typeof value === 'object' && Object.hasOwn(value, 'before')
      ? { before: '[已隐藏]', after: '[已隐藏]' }
      : '[已隐藏]';
  if (omitted.has(key)) return Array.isArray(value) ? { count: value.length } : '[快照已省略]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string')
    return value.length > 12000 ? value.slice(0, 12000) + '…[截断]' : value;
  if (depth > 8) return '[层级已省略]';
  if (Array.isArray(value))
    return value.slice(0, 500).map((item) => safeAuditValue(item, '', depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([name]) => !name.startsWith('_'))
      .map(([name, item]) => [name, safeAuditValue(item, name, depth + 1)]),
  );
}

/** 按北京时间保留两个自然月，月底回退到目标月最后一天。 */
export function auditCutoff(now = new Date()) {
  const local = new Date(now.getTime() + 8 * 3600000);
  const day = local.getUTCDate();
  local.setUTCDate(1);
  local.setUTCMonth(local.getUTCMonth() - 2);
  const end = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 0)).getUTCDate();
  local.setUTCDate(Math.min(day, end));
  return new Date(local.getTime() - 8 * 3600000);
}
