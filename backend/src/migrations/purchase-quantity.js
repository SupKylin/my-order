import { DataTypes } from 'sequelize';
import { db } from '../models.js';

/** 只添加可空列，历史订单不回填采购数量。 */
export async function migratePurchaseQuantity(query = db.getQueryInterface()) {
  const columns = await query.describeTable('purchases');
  if (!columns.purchaseQuantity)
    await query.addColumn('purchases', 'purchaseQuantity', {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    });
}
