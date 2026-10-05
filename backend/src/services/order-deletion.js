import { Op } from 'sequelize';
import { db, OrderItem, Purchase, AuditLog } from '../models.js';
import { assert } from '../errors.js';

/** 单条与批量共用事务；校验所有版本后才删除，避免误删他人刚更新的明细。 */
export async function deleteItems(input, user) {
  const entries = input?.items;
  assert(
    Array.isArray(entries) && entries.length > 0 && entries.length <= 500,
    '请选择 1 至 500 条商品明细',
  );
  assert(
    entries.every(
      (item) =>
        item &&
        Number.isInteger(item.id) &&
        item.id > 0 &&
        Number.isInteger(item.version) &&
        item.version > 0,
    ),
    '删除参数错误',
  );
  const ids = entries.map((item) => item.id);
  assert(new Set(ids).size === ids.length, '商品明细不能重复');
  return db.transaction(async (transaction) => {
    for (const entry of [...entries].sort((a, b) => a.id - b.id)) {
      const item = await OrderItem.findByPk(entry.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      assert(item, '部分商品已不存在，请刷新后重试', 404);
      assert(item.version === entry.version, '部分商品已更新，请刷新后重新确认删除', 409);
    }
    // 仅删除指定明细及关联采购记录；同订单其他明细、导入记录和图片文件保留。
    await Purchase.destroy({ where: { itemId: { [Op.in]: ids } }, transaction });
    await OrderItem.destroy({ where: { id: { [Op.in]: ids } }, transaction });
    await AuditLog.create(
      { userId: user.id, action: 'delete_items', details: { itemIds: ids } },
      { transaction },
    );
    return { deleted: ids.length };
  });
}
