import { DataTypes } from 'sequelize';
import { db } from '../../models.js';

// 一期快照与全部分组在同一事务提交，读取方看不到半份报表。
export const PurchaseStatisticsSnapshot = db.define(
  'PurchaseStatisticsSnapshot',
  {
    date: { type: DataTypes.DATEONLY, primaryKey: true },
    scheduledAt: { type: DataTypes.DATE(3), allowNull: false },
    capturedAt: { type: DataTypes.DATE(3), allowNull: false },
  },
  { tableName: 'purchase_statistics_snapshots', timestamps: false },
);

// 保存店铺＋渠道组合的聚合数，不复制订单或消息。组合保持整体去重能力。
export const PurchaseStatisticsGroup = db.define(
  'PurchaseStatisticsGroup',
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
      references: { model: PurchaseStatisticsSnapshot, key: 'date' },
    },
    shopName: { type: DataTypes.STRING(255), allowNull: false },
    channels: { type: DataTypes.JSON, allowNull: false },
    ...Object.fromEntries(
      ['total', 'success', 'failed', 'inProgress', 'other'].map((key) => [
        key,
        { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      ]),
    ),
  },
  {
    tableName: 'purchase_statistics_groups',
    timestamps: false,
    indexes: [{ fields: ['date', 'shopName'] }],
  },
);

export async function migratePurchaseStatistics() {
  await PurchaseStatisticsSnapshot.sync();
  await PurchaseStatisticsGroup.sync();
}
