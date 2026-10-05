import { Sequelize, DataTypes } from 'sequelize';
import { config } from './config.js';
import { fields } from './fields.js';
import { decimalText } from './lib/decimal.js';
import { storedChannels } from './lib/channels.js';
export const db = new Sequelize(config.db.database, config.db.username, config.db.password, {
  dialect: 'mysql',
  host: config.db.host,
  port: config.db.port,
  logging: false,
  timezone: '+08:00',
  pool: { max: 10, min: 0, idle: 10000 },
  define: { charset: 'utf8mb4', collate: 'utf8mb4_bin', timestamps: true },
});
const id = () => ({ type: DataTypes.INTEGER.UNSIGNED, primaryKey: true, autoIncrement: true });
const fieldType = (f) => {
  if (['money', 'decimal'].includes(f.type)) return DataTypes.DECIMAL(36, 20);
  if (f.type === 'multiselect') return DataTypes.TEXT;
  if (f.type === 'integer') return DataTypes.INTEGER.UNSIGNED;
  if (f.type === 'date') return DataTypes.DATEONLY;
  if (f.type === 'datetime') return DataTypes.DATE;
  if (['textarea', 'url', 'image'].includes(f.type)) return DataTypes.TEXT;
  return DataTypes.STRING(f.key === 'sku' ? 191 : 255);
};
const attrs = (group) =>
  Object.fromEntries(
    fields
      .filter(
        (f) =>
          (group === 'item' ? f.group !== 'purchase' : f.group === 'purchase') &&
          f.key !== 'orderNumber',
      )
      .map((f) => [
        f.key,
        {
          type: fieldType(f),
          allowNull: !f.required,
          ...(f.type === 'multiselect'
            ? {
                get() {
                  return storedChannels(this.getDataValue(f.key));
                },
                set(value) {
                  this.setDataValue(
                    f.key,
                    value == null ? null : JSON.stringify(storedChannels(value)),
                  );
                },
              }
            : {}),
        },
      ]),
  );
export const User = db.define(
  'User',
  {
    id: id(),
    username: { type: DataTypes.STRING(64), unique: true, allowNull: false },
    displayName: { type: DataTypes.STRING(100), allowNull: false },
    passwordHash: { type: DataTypes.STRING(255), allowNull: false },
    role: { type: DataTypes.ENUM('operations', 'purchasing', 'admin'), allowNull: false },
    active: { type: DataTypes.BOOLEAN, defaultValue: true },
    sessionVersion: { type: DataTypes.INTEGER, defaultValue: 1 },
  },
  { tableName: 'users' },
);
export const Order = db.define(
  'Order',
  { id: id(), orderNumber: { type: DataTypes.STRING(191), unique: true, allowNull: false } },
  { tableName: 'orders' },
);
export const OrderItem = db.define(
  'OrderItem',
  {
    id: id(),
    orderId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    purchaseChannelKey: { type: DataTypes.STRING(64), allowNull: false },
    ...attrs('item'),
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  },
  {
    tableName: 'order_items',
    indexes: [
      {
        name: 'order_items_order_channel',
        fields: ['orderId', 'purchaseChannelKey'],
      },
      { fields: ['orderDate'] },
      { fields: ['shopName'] },
      { fields: ['orderStatus'] },
    ],
  },
);
export const Purchase = db.define(
  'Purchase',
  {
    id: id(),
    itemId: { type: DataTypes.INTEGER.UNSIGNED, unique: true, allowNull: false },
    ...attrs('purchase'),
    assignedTo: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    assignedAt: { type: DataTypes.DATE, allowNull: true },
  },
  { tableName: 'purchases' },
);
export const ImportTemplate = db.define(
  'ImportTemplate',
  {
    id: id(),
    name: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    sheetName: { type: DataTypes.STRING(100), allowNull: false },
    headerRow: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    mappings: { type: DataTypes.JSON, allowNull: false },
    purchaseChannelId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
  },
  { tableName: 'import_templates' },
);
export const Upload = db.define(
  'Upload',
  {
    id: { type: DataTypes.UUID, primaryKey: true },
    filename: { type: DataTypes.STRING(255), allowNull: false },
    originalName: DataTypes.STRING(255),
    kind: { type: DataTypes.ENUM('image', 'excel'), allowNull: false },
    size: DataTypes.INTEGER.UNSIGNED,
    mime: DataTypes.STRING(100),
    uploadedBy: DataTypes.INTEGER.UNSIGNED,
  },
  { tableName: 'uploads' },
);
export const DictionaryOption = db.define(
  'DictionaryOption',
  {
    id: id(),
    kind: { type: DataTypes.STRING(32), allowNull: false },
    value: { type: DataTypes.STRING(255), allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  },
  { tableName: 'dictionary_options', indexes: [{ unique: true, fields: ['kind', 'value'] }] },
);
export const ImportJob = db.define(
  'ImportJob',
  {
    id: { type: DataTypes.UUID, primaryKey: true },
    uploadId: { type: DataTypes.UUID, allowNull: false },
    templateId: DataTypes.INTEGER.UNSIGNED,
    templateSnapshot: { type: DataTypes.JSON, allowNull: false },
    rows: { type: DataTypes.JSON, allowNull: false },
    errors: { type: DataTypes.JSON, allowNull: false },
    warnings: { type: DataTypes.JSON, allowNull: false },
    status: { type: DataTypes.ENUM('preview', 'completed'), defaultValue: 'preview' },
    createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    added: { type: DataTypes.INTEGER, defaultValue: 0 },
    updated: { type: DataTypes.INTEGER, defaultValue: 0 },
    committedAt: DataTypes.DATE,
  },
  { tableName: 'import_jobs' },
);
export const AuditLog = db.define(
  'AuditLog',
  {
    id: id(),
    userId: DataTypes.INTEGER.UNSIGNED,
    action: { type: DataTypes.STRING(64), allowNull: false },
    entityId: DataTypes.STRING(100),
    details: DataTypes.JSON,
  },
  { tableName: 'audit_logs', updatedAt: false },
);
export const Session = db.define(
  'Session',
  {
    sid: { type: DataTypes.STRING(128), primaryKey: true },
    data: { type: DataTypes.TEXT('medium'), allowNull: false },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
  },
  { tableName: 'sessions', timestamps: false, indexes: [{ fields: ['expiresAt'] }] },
);
Order.hasMany(OrderItem, { as: 'items', foreignKey: 'orderId', onDelete: 'CASCADE' });
OrderItem.belongsTo(Order, { as: 'order', foreignKey: 'orderId' });
OrderItem.hasOne(Purchase, { as: 'purchase', foreignKey: 'itemId', onDelete: 'CASCADE' });
Purchase.belongsTo(OrderItem, { foreignKey: 'itemId' });
Purchase.belongsTo(User, { as: 'assignee', foreignKey: 'assignedTo', onDelete: 'SET NULL' });
export const itemInclude = [
  { model: Order, as: 'order' },
  {
    model: Purchase,
    as: 'purchase',
    include: [
      { model: User, as: 'assignee', attributes: ['id', 'username', 'displayName', 'role'] },
    ],
  },
];
export function serializeItem(instance) {
  const value = instance.toJSON ? instance.toJSON() : instance;
  const result = {
    id: value.id,
    version: value.version,
    orderNumber: value.order?.orderNumber,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    assignedTo: value.purchase?.assignedTo || null,
    assignedAt: value.purchase?.assignedAt || null,
    assignee: value.purchase?.assignee || null,
  };
  for (const f of fields) {
    if (f.key === 'orderNumber') continue;
    const stored = (f.group === 'purchase' ? value.purchase?.[f.key] : value[f.key]) ?? null;
    result[f.key] =
      stored != null && ['money', 'decimal'].includes(f.type)
        ? decimalText(stored, f.type === 'money' ? 2 : 4)
        : stored;
  }
  return result;
}
