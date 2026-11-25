import { DataTypes } from 'sequelize';
import { db } from '../models.js';

export async function migrateOrderLoss() {
  const query = db.getQueryInterface();
  const columns = await query.describeTable('order_items');
  if (!columns.isLoss)
    await query.addColumn('order_items', 'isLoss', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
}
