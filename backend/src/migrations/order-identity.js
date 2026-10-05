import { DataTypes } from 'sequelize';
import { db, OrderItem, Purchase } from '../models.js';
import { channelKey } from '../lib/order-identity.js';

/** 将组合唯一索引替换为普通索引，完整保留重复明细及其采购关联。 */
export async function migrateOrderIdentity() {
  const query = db.getQueryInterface();
  const columns = await query.describeTable('order_items');
  if (!columns.purchaseChannelKey)
    await query.addColumn('order_items', 'purchaseChannelKey', {
      type: DataTypes.STRING(64),
      allowNull: true,
    });
  const items = await OrderItem.findAll({
    attributes: ['id', 'orderId', 'purchaseChannelKey'],
    include: [{ model: Purchase, as: 'purchase', attributes: ['purchaseChannel'] }],
  });
  const indexes = await query.showIndex('order_items');
  if (!indexes.some((index) => index.name === 'order_items_order_channel'))
    await query.addIndex('order_items', ['orderId', 'purchaseChannelKey'], {
      name: 'order_items_order_channel',
    });
  // 先建立 orderId 前缀索引以支撑外键，再移除旧业务唯一约束。
  for (const index of indexes)
    if (
      index.unique &&
      index.fields.length === 2 &&
      index.fields[0].attribute === 'orderId' &&
      ['sku', 'purchaseChannelKey'].includes(index.fields[1].attribute)
    )
      await query.removeIndex('order_items', index.name);
  const updates = [];
  for (const item of items) {
    const key = channelKey(item.purchase?.purchaseChannel);
    if (item.purchaseChannelKey !== key) updates.push({ id: item.id, key });
  }
  await db.transaction(async (transaction) => {
    for (const item of updates)
      await OrderItem.update(
        { purchaseChannelKey: item.key },
        { where: { id: item.id }, transaction },
      );
  });
  if (!columns.purchaseChannelKey || columns.purchaseChannelKey.allowNull)
    await query.changeColumn('order_items', 'purchaseChannelKey', {
      type: DataTypes.STRING(64),
      allowNull: false,
    });
}
