import { DataTypes } from 'sequelize';
import { db } from '../models.js';
import { PURCHASE_UNTRACKED_PATTERN } from '../lib/purchase-timer.js';

/** 历史未计时记录从升级时开始；幂等重跑不会覆盖已有时间。 */
export async function migratePurchaseConfirmation(query = db.getQueryInterface()) {
  const columns = await query.describeTable('purchases');
  if (!columns.purchaseConfirmedAt)
    await query.addColumn('purchases', 'purchaseConfirmedAt', {
      type: DataTypes.DATE(3),
      allowNull: true,
    });
  await query.sequelize.query(
    `UPDATE purchases SET purchaseConfirmedAt = CURRENT_TIMESTAMP(3)
     WHERE purchaseConfirmedAt IS NULL
       AND purchaseStatus REGEXP :pattern`,
    {
      replacements: {
        pattern: PURCHASE_UNTRACKED_PATTERN,
      },
    },
  );
}
