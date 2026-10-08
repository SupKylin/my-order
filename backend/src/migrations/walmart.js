import { DataTypes } from 'sequelize';
import { db, OrderItem } from '../models.js';
import { platformStatusText, specificationText } from '../services/walmart/mapping.js';
import { WalmartSync, WalmartReceipt } from '../services/walmart/models.js';

/** 只新增可空字段和专用表，可重复执行；不重建订单表。 */
export async function migrateWalmart() {
  const query = db.getQueryInterface();
  const columns = await query.describeTable('order_items');
  const addStatus = !columns.platformOrderStatus;
  const addSpecification = !columns.productSpecification;
  if (addStatus)
    await query.addColumn('order_items', 'platformOrderStatus', {
      type: DataTypes.STRING(255),
      allowNull: true,
    });
  if (addSpecification)
    await query.addColumn('order_items', 'productSpecification', {
      type: DataTypes.TEXT,
      allowNull: true,
    });
  if (!columns.walmartSourceKey)
    await query.addColumn('order_items', 'walmartSourceKey', {
      type: DataTypes.STRING(64),
      allowNull: true,
    });
  if (!columns.walmart)
    await query.addColumn('order_items', 'walmart', { type: DataTypes.JSON, allowNull: true });
  const indexes = await query.showIndex('order_items');
  if (
    !indexes.some(
      (index) =>
        index.unique &&
        index.fields.length === 1 &&
        index.fields[0].attribute === 'walmartSourceKey',
    )
  )
    await query.addIndex('order_items', ['walmartSourceKey'], {
      name: 'order_items_walmart_source',
      unique: true,
    });
  await WalmartSync.sync();
  await WalmartReceipt.sync();
  // 只在首次新增列时从现有 API 快照回填，重复迁移不覆盖人工调整。
  if (addStatus || addSpecification) {
    const snapshots = await OrderItem.findAll({ attributes: ['id', 'walmart'] });
    for (const item of snapshots) {
      if (!item.walmart) continue;
      await item.update(
        {
          ...(addStatus
            ? { platformOrderStatus: platformStatusText(item.walmart.statuses) || null }
            : {}),
          ...(addSpecification
            ? { productSpecification: specificationText(item.walmart.attributes) || null }
            : {}),
        },
        { silent: true },
      );
    }
  }
}
