import { DataTypes } from 'sequelize';
import { db, Store } from '../../models.js';

// 每家店铺仅保留最新快照，不随运行天数累积报表。
export const StoreSnapshot = db.define(
  'StoreSnapshot',
  {
    storeId: {
      type: DataTypes.INTEGER.UNSIGNED,
      primaryKey: true,
      references: { model: Store, key: 'id' },
      onDelete: 'CASCADE',
    },
    sourceKey: { type: DataTypes.STRING(64), allowNull: false },
    snapshotDate: { type: DataTypes.DATEONLY, allowNull: false },
    measuredAt: { type: DataTypes.DATE, allowNull: false },
    metrics: { type: DataTypes.JSON, allowNull: false },
    remote: { type: DataTypes.JSON, allowNull: false },
    attempts: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    attemptedAt: DataTypes.DATE,
  },
  { tableName: 'store_snapshots' },
);

export async function migrateHome() {
  await StoreSnapshot.sync();
}
