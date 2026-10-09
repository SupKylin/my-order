import { DataTypes } from 'sequelize';
import { db } from '../../models.js';

/** 独立记录平台同步进度，不修改 Excel 导入任务或采购状态。 */
export const WalmartSync = db.define(
  'WalmartSync',
  {
    storeId: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    startedAt: { type: DataTypes.DATE(3), allowNull: false },
    cursorAt: { type: DataTypes.DATE(3), allowNull: true },
    // 仅完整补查成功后更新；NULL 让旧店铺升级后自动执行一次全范围补查。
    lastReconciledAt: { type: DataTypes.DATE(3), allowNull: true },
    actorId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    status: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'idle' },
    lastRunAt: DataTypes.DATE(3),
    finishedAt: DataTypes.DATE(3),
    result: DataTypes.JSON,
    error: DataTypes.STRING(500),
  },
  { tableName: 'walmart_sync_states' },
);

/** 与商品明细在同一事务保存，提交后才能调用确认接口。 */
export const WalmartReceipt = db.define(
  'WalmartReceipt',
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    storeId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    purchaseOrderId: { type: DataTypes.STRING(191), allowNull: false },
    customerOrderId: { type: DataTypes.STRING(191), allowNull: false },
    raw: { type: DataTypes.JSON, allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    ackStatus: { type: DataTypes.STRING(24), allowNull: false, defaultValue: 'pending' },
    ackAttempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    acknowledgedAt: DataTypes.DATE(3),
    lastError: DataTypes.STRING(500),
  },
  {
    tableName: 'walmart_order_receipts',
    indexes: [
      { unique: true, fields: ['storeId', 'purchaseOrderId'] },
      { fields: ['storeId', 'active'] },
    ],
  },
);
