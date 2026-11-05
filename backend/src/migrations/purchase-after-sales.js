import { DataTypes } from 'sequelize';
import {
  db,
  PurchaseAfterSale,
  PurchaseAfterSaleRecord,
  AfterSaleNotification,
} from '../models.js';

// 仅创建独立工单表，不修改或回填订单、旧售后字段。
export async function migratePurchaseAfterSales() {
  await PurchaseAfterSale.sync();
  await PurchaseAfterSaleRecord.sync();
  await AfterSaleNotification.sync();
  const query = db.getQueryInterface();
  const ticketColumns = await query.describeTable('purchase_after_sales');
  for (const [key, type] of Object.entries({
    supplierFeedbackAt: DataTypes.DATE(3),
    supplierFeedbackBy: DataTypes.INTEGER.UNSIGNED,
    supplierFeedbackName: DataTypes.STRING(100),
  })) {
    if (!ticketColumns[key])
      await query.addColumn('purchase_after_sales', key, { type, allowNull: true });
  }
  const columns = await query.describeTable('after_sale_notifications');
  if (!columns.parts)
    await query.addColumn('after_sale_notifications', 'parts', {
      type: DataTypes.JSON,
      allowNull: true,
    });
  if (!columns.nextPart)
    await query.addColumn('after_sale_notifications', 'nextPart', {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    });
}
