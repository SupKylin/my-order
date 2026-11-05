import { DataTypes } from 'sequelize';
import { db } from '../models.js';

/** 只新增可空列，不推算或回填历史结算金额。 */
export async function migratePurchaseCost(table) {
  const query = db.getQueryInterface();
  const definitions =
    table === 'dictionary_options'
      ? {
          channelExchangeRate: DataTypes.DECIMAL(14, 2),
          currentExchangeRate: DataTypes.DECIMAL(14, 2),
          taxMultiplier: DataTypes.DECIMAL(14, 2),
          purchaseDiscount: DataTypes.DECIMAL(36, 20),
        }
      : {
          purchaseCostChannel: DataTypes.STRING(255),
          purchaseDiscount: DataTypes.DECIMAL(36, 20),
          purchaseCost: DataTypes.DECIMAL(36, 20),
        };
  const columns = await query.describeTable(table);
  for (const [key, type] of Object.entries(definitions))
    if (!columns[key]) await query.addColumn(table, key, { type, allowNull: true });
}
