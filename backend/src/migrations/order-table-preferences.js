import { DataTypes } from 'sequelize';
import { db } from '../models.js';

/** 仅新增账号偏好列，兼容重复发布，不改写订单及已有账号数据。 */
export async function migrateOrderTablePreferences() {
  const query = db.getQueryInterface();
  const columns = await query.describeTable('users');
  if (!columns.orderTablePreferences)
    await query.addColumn('users', 'orderTablePreferences', {
      type: DataTypes.JSON,
      allowNull: true,
    });
}
