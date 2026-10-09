import { assert } from '../errors.js';

const entries = new Map();
const ttl = 15 * 60 * 1000;
/** 只保存当前进程的短期进度，不保存导出文件或业务数据；按登录用户隔离。 */
export function beginExport(id, userId) {
  if (!id) return () => {};
  assert(typeof id === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(id), '导出编号无效');
  for (const [key, value] of entries) if (value.expiresAt < Date.now()) entries.delete(key);
  assert(!entries.has(id), '导出编号重复，请重新导出', 409);
  assert(entries.size < 1000, '导出任务过多，请稍后再试', 429);
  const entry = { userId, stage: 'query', expiresAt: Date.now() + ttl };
  entries.set(id, entry);
  return (update) => Object.assign(entry, update, { expiresAt: Date.now() + ttl });
}

export function exportProgress(id, userId) {
  const entry = entries.get(id);
  if (!entry || entry.expiresAt < Date.now() || entry.userId !== userId)
    return { stage: 'waiting' };
  const { userId: owner, expiresAt, ...progress } = entry;
  return progress;
}
