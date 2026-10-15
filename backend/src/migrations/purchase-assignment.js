import { DataTypes } from 'sequelize';
import { db } from '../models.js';

/** 仅增加渠道分配时间和筛选索引；历史时间不推测、不回填。 */
export async function migratePurchaseAssignment(query = db.getQueryInterface()) {
  const columns = await query.describeTable('purchases');
  if (!columns.purchaseAssignedAt)
    await query.addColumn('purchases', 'purchaseAssignedAt', {
      type: DataTypes.DATE(3),
      allowNull: true,
    });
  const indexes = await query.showIndex('purchases');
  if (!indexes.some((index) => index.name === 'purchases_purchase_assigned_at'))
    await query.addIndex('purchases', ['purchaseAssignedAt'], {
      name: 'purchases_purchase_assigned_at',
    });
}
