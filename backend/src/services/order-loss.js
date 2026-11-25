import { db, OrderItem, AuditLog } from '../models.js';
import { assert } from '../errors.js';
import { requirePermission, assertItemAccess } from '../permissions.js';
import { assertOrderEditable } from '../lib/order-write-policy.js';

/** 单条、批量及售后入口共用商品明细标记；不修改财务数据。 */
export async function updateLossMark(input, user) {
  requirePermission(user, 'orders');
  const entries = input?.items;
  assert(
    Array.isArray(entries) && entries.length > 0 && entries.length <= 500,
    '请选择 1 至 500 条商品明细',
  );
  assert(
    entries.every(
      (entry) =>
        Number.isSafeInteger(entry?.id) &&
        entry.id > 0 &&
        Number.isSafeInteger(entry?.version) &&
        entry.version > 0,
    ),
    '商品明细参数错误',
  );
  assert(new Set(entries.map((entry) => entry.id)).size === entries.length, '商品明细不能重复');
  assert(typeof input.isLoss === 'boolean', '请选择标记或取消亏损');
  return db.transaction(async (transaction) => {
    const rows = [],
      changes = [];
    for (const entry of [...entries].sort((a, b) => a.id - b.id)) {
      const item = await OrderItem.findByPk(entry.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      assert(item, '部分商品已不存在，请刷新', 404);
      await assertItemAccess(item, user, transaction);
      assertOrderEditable(item);
      assert(item.version === entry.version, '部分商品已更新，请刷新后重新操作', 409);
      if (Boolean(item.isLoss) !== input.isLoss) {
        changes.push({ id: item.id, before: Boolean(item.isLoss), after: input.isLoss });
        await item.update({ isLoss: input.isLoss, version: item.version + 1 }, { transaction });
      }
      rows.push({ id: item.id, version: item.version, isLoss: Boolean(item.isLoss) });
    }
    if (changes.length)
      await AuditLog.create(
        { userId: user.id, action: 'mark_order_loss', details: { isLoss: input.isLoss, changes } },
        { transaction },
      );
    return { rows, updated: changes.length };
  });
}
