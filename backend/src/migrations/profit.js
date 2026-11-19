import { DataTypes } from 'sequelize';
import { db } from '../models.js';

/** 可重复执行：只补列；旧折扣仅初始化一次，后续清空或调价不被迁移覆盖。 */
export async function migrateProfit(table) {
  const query = db.getQueryInterface();
  const definitions =
    table === 'dictionary_options'
      ? Object.fromEntries(
          ['fba', 'fbm'].flatMap((mode) => [
            ...['ChannelExchangeRate', 'CurrentExchangeRate', 'TaxMultiplier'].map((key) => [
              `${mode}${key}`,
              DataTypes.DECIMAL(14, 2),
            ]),
            [`${mode}PurchaseDiscount`, DataTypes.DECIMAL(36, 20)],
          ]),
        )
      : {
          commissionRate: DataTypes.DECIMAL(5, 2),
          ...(table === 'purchases'
            ? {
                disputeSuccessAmount: DataTypes.DECIMAL(18, 2),
              }
            : {}),
        };
  const columns = await query.describeTable(table);
  for (const [key, type] of Object.entries(definitions))
    if (!columns[key]) await query.addColumn(table, key, { type, allowNull: true });
  if (table !== 'dictionary_options') return;
  if (!columns.modeDiscountInitialized)
    await query.addColumn(table, 'modeDiscountInitialized', {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  const assignments = ['fba', 'fbm'].flatMap((mode) =>
    ['channelExchangeRate', 'currentExchangeRate', 'taxMultiplier', 'purchaseDiscount'].map(
      (key) => `\`${mode}${key[0].toUpperCase()}${key.slice(1)}\` = \`${key}\``,
    ),
  );
  await db.query(
    `UPDATE dictionary_options SET ${assignments.join(', ')}, modeDiscountInitialized = 1 WHERE kind = 'purchaseChannel' AND modeDiscountInitialized = 0`,
  );
}
