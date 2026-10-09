import { DataTypes, Op } from 'sequelize';
import { db, OrderItem, RiskAddress } from '../models.js';
import { addressFields, addressKey } from '../lib/address-key.js';

/** 可重复执行的增量迁移；只添加字段和风险地址表，不清空业务数据。 */
export async function migrateProcurementFields() {
  const query = db.getQueryInterface();
  for (const [table, definitions] of Object.entries({
    purchases: {
      purchasePlatform: DataTypes.STRING(255),
      shippingMode: DataTypes.STRING(255),
      afterSalesResult: DataTypes.STRING(255),
      afterSalesResultScreenshot: DataTypes.TEXT,
    },
    order_items: { fulfillmentParty: DataTypes.STRING(255), addressKey: DataTypes.STRING(64) },
  })) {
    const columns = await query.describeTable(table);
    for (const [key, type] of Object.entries(definitions))
      if (!columns[key]) await query.addColumn(table, key, { type, allowNull: true });
  }
  await RiskAddress.sync();
  const indexes = await query.showIndex('order_items');
  if (!indexes.some((index) => index.name === 'order_items_address_key'))
    await query.addIndex('order_items', ['addressKey'], { name: 'order_items_address_key' });
  // 分批补齐历史订单的地址指纹，不获取整张订单表，也不读取采购或密钥。
  let lastId = 0;
  while (true) {
    const items = await OrderItem.findAll({
      where: { id: { [Op.gt]: lastId }, addressKey: null },
      attributes: ['id', ...addressFields],
      order: [['id', 'ASC']],
      limit: 500,
    });
    for (const item of items) {
      const key = addressKey(item);
      if (key)
        await OrderItem.update({ addressKey: key }, { where: { id: item.id }, silent: true });
    }
    if (items.length < 500) break;
    lastId = items.at(-1).id;
  }
}
