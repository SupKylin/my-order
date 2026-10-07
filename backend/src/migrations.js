import { DataTypes } from 'sequelize';
import { db, DictionaryOption } from './models.js';
import { dictionaryKinds } from './dictionaries.js';
import { fields } from './fields.js';
import { migrateOrderIdentity } from './migrations/order-identity.js';
import { migratePurchaseConfirmation } from './migrations/purchase-confirmation.js';

/** 仅增加本次所需表和可空字段，禁止通过 alter/force 改写现有业务表。 */
export async function migrateDictionaries() {
  const query = db.getQueryInterface();
  await DictionaryOption.sync();
  const columns = await query.describeTable('import_templates');
  if (!columns.purchaseChannelId)
    await query.addColumn('import_templates', 'purchaseChannelId', {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    });
  for (const [kind, definition] of Object.entries(dictionaryKinds)) {
    // 界面只提供停用，不物理清空字典；已有配置永远不被默认值覆盖。
    if (!(await DictionaryOption.count({ where: { kind } })))
      await DictionaryOption.bulkCreate(
        definition.defaults.map((value, sortOrder) => ({ kind, value, sortOrder })),
      );
  }
}

/** 仅扩展指定列的容量，保留旧数据；不使用 sync alter/force 重建业务表。 */
export async function migrateOrderFields() {
  const query = db.getQueryInterface();
  for (const table of ['order_items', 'purchases']) {
    const columns = await query.describeTable(table);
    if (table === 'order_items' && !columns.platformTrackingNumber)
      await query.addColumn(table, 'platformTrackingNumber', {
        type: DataTypes.STRING(255),
        allowNull: true,
      });
    if (table === 'order_items' && !columns.sku.allowNull)
      await query.changeColumn(table, 'sku', { type: DataTypes.STRING(191), allowNull: true });
    const decimalFields = fields.filter(
      (field) =>
        ['money', 'decimal'].includes(field.type) &&
        (field.group === 'purchase') === (table === 'purchases'),
    );
    for (const field of decimalFields) {
      if (columns[field.key].type.toUpperCase() !== 'DECIMAL(36,20)')
        await query.changeColumn(table, field.key, {
          type: DataTypes.DECIMAL(36, 20),
          allowNull: true,
        });
    }
    if (table === 'purchases' && columns.purchaseChannel.type.toUpperCase() !== 'TEXT')
      await query.changeColumn(table, 'purchaseChannel', { type: DataTypes.TEXT, allowNull: true });
    if (table === 'purchases') {
      // 原数字直接转换为文本，保留现有值；之后允许金额备注和非数字系数。
      for (const key of ['purchaseAmount', 'priceFactor'])
        if (columns[key].type.toUpperCase() !== 'VARCHAR(255)')
          await query.changeColumn(table, key, { type: DataTypes.STRING(255), allowNull: true });
    }
  }
  await migrateOrderIdentity();
  await migratePurchaseConfirmation();
}
