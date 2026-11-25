import { Sequelize, DataTypes } from 'sequelize';
import { config } from './config.js';
import { fields, ROLES } from './fields.js';
import { decimalText } from './lib/decimal.js';
import { storedChannels } from './lib/channels.js';
import { priceFactorLevel } from './lib/price-factor.js';
import { isWfsOrder } from './lib/order-write-policy.js';
import { itemProfit } from './lib/order-profit.js';
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
  if (f.key === 'disputeSuccessAmount') return DataTypes.DECIMAL(18, 2);
  if (['money', 'decimal'].includes(f.type)) return DataTypes.DECIMAL(36, 20);
  if (f.type === 'multiselect') return DataTypes.TEXT;
  if (f.type === 'integer') return DataTypes.INTEGER.UNSIGNED;
  if (f.type === 'date') return DataTypes.DATEONLY;
  if (f.type === 'datetime') return DataTypes.DATE;
  if (['textarea', 'url', 'image'].includes(f.type)) return DataTypes.TEXT;
  return DataTypes.STRING(['walmartSku', 'purchaseSku'].includes(f.key) ? 191 : 255);
};
const attrs = (group) =>
  Object.fromEntries(
    fields
      .filter(
        (f) =>
          (group === 'item' ? f.group !== 'purchase' : f.group === 'purchase') &&
          f.key !== 'orderNumber' &&
          !f.computed,
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
    role: { type: DataTypes.ENUM(...Object.keys(ROLES)), allowNull: false },
    active: { type: DataTypes.BOOLEAN, defaultValue: true },
    sessionVersion: { type: DataTypes.INTEGER, defaultValue: 1 },
    orderTablePreferences: { type: DataTypes.JSON, allowNull: true },
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
    orderIdentityKey: { type: DataTypes.STRING(64), allowNull: true },
    sku: { type: DataTypes.STRING(191), allowNull: true },
    walmartSourceKey: { type: DataTypes.STRING(64), allowNull: true, unique: true },
    walmart: { type: DataTypes.JSON, allowNull: true },
    returnInfo: { type: DataTypes.JSON, allowNull: true },
    isLoss: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    addressKey: { type: DataTypes.STRING(64), allowNull: true },
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
      { name: 'order_items_order_identity', fields: ['orderId', 'orderIdentityKey'] },
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
    commissionRate: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    assignedTo: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    assignedAt: { type: DataTypes.DATE, allowNull: true },
    purchaseConfirmedAt: { type: DataTypes.DATE(3), allowNull: true },
    purchaseAssignedAt: { type: DataTypes.DATE(3), allowNull: true },
    reviewStatus: { type: DataTypes.STRING(32), allowNull: true },
    supplierAssignmentStatus: { type: DataTypes.STRING(32), allowNull: true },
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
export const PurchaseAfterSale = db.define(
  'PurchaseAfterSale',
  {
    id: id(),
    itemId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, unique: true },
    status: { type: DataTypes.ENUM('open', 'completed'), allowNull: false, defaultValue: 'open' },
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    creatorName: { type: DataTypes.STRING(100), allowNull: false },
    supplierFeedbackAt: { type: DataTypes.DATE(3), allowNull: true },
    supplierFeedbackBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    supplierFeedbackName: { type: DataTypes.STRING(100), allowNull: true },
    purchaseRefundAmount: { type: DataTypes.DECIMAL(18, 2), allowNull: true },
    lastActivityAt: { type: DataTypes.DATE(3), allowNull: false },
    completedAt: { type: DataTypes.DATE(3), allowNull: true },
  },
  {
    tableName: 'purchase_after_sales',
    indexes: [{ fields: ['status', 'lastActivityAt'] }, { fields: ['lastActivityAt'] }],
  },
);
export const PurchaseAfterSaleRecord = db.define(
  'PurchaseAfterSaleRecord',
  {
    id: id(),
    ticketId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    requestId: { type: DataTypes.UUID, allowNull: false },
    kind: { type: DataTypes.ENUM('message', 'completed', 'reopened'), allowNull: false },
    actorId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    actorName: { type: DataTypes.STRING(100), allowNull: false },
    actorRole: { type: DataTypes.STRING(32), allowNull: false },
    content: { type: DataTypes.TEXT, allowNull: false },
    images: { type: DataTypes.JSON, allowNull: false },
  },
  {
    tableName: 'purchase_after_sale_records',
    updatedAt: false,
    indexes: [{ unique: true, fields: ['ticketId', 'requestId'] }, { fields: ['ticketId', 'id'] }],
  },
);
export const ChannelChangeTicket = db.define(
  'ChannelChangeTicket',
  {
    id: id(),
    itemId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    // MySQL允许多个NULL；唯一值使每条商品最多存在一个未关闭工单。
    openItemId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, unique: true },
    requestId: { type: DataTypes.UUID, allowNull: false, unique: true },
    status: { type: DataTypes.ENUM('open', 'completed'), allowNull: false, defaultValue: 'open' },
    version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
    beforeChannels: { type: DataTypes.JSON, allowNull: false },
    targetChannels: { type: DataTypes.JSON, allowNull: false },
    beforePurchase: { type: DataTypes.JSON, allowNull: true },
    targetPurchase: { type: DataTypes.JSON, allowNull: true },
    executedBefore: { type: DataTypes.JSON, allowNull: true },
    executedAfter: { type: DataTypes.JSON, allowNull: true },
    createdBy: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    creatorName: { type: DataTypes.STRING(100), allowNull: false },
    appliedAt: DataTypes.DATE(3),
    appliedBy: DataTypes.INTEGER.UNSIGNED,
    appliedByName: DataTypes.STRING(100),
    lastActivityAt: { type: DataTypes.DATE(3), allowNull: false },
    completedAt: DataTypes.DATE(3),
  },
  {
    tableName: 'channel_change_tickets',
    indexes: [{ fields: ['itemId', 'id'] }, { fields: ['status', 'lastActivityAt'] }],
  },
);
export const ChannelChangeRecord = db.define(
  'ChannelChangeRecord',
  {
    id: id(),
    ticketId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    requestId: { type: DataTypes.UUID, allowNull: false },
    kind: { type: DataTypes.ENUM('message', 'completed', 'reopened', 'applied'), allowNull: false },
    actorId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    actorName: { type: DataTypes.STRING(100), allowNull: false },
    actorRole: { type: DataTypes.STRING(32), allowNull: false },
    content: { type: DataTypes.TEXT, allowNull: false },
    images: { type: DataTypes.JSON, allowNull: false },
  },
  {
    tableName: 'channel_change_records',
    updatedAt: false,
    indexes: [{ unique: true, fields: ['ticketId', 'requestId'] }, { fields: ['ticketId', 'id'] }],
  },
);
export const AfterSaleNotification = db.define(
  'AfterSaleNotification',
  {
    id: id(),
    recordId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, unique: true },
    channelChangeRecordId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, unique: true },
    ticketId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    content: { type: DataTypes.TEXT, allowNull: false },
    parts: { type: DataTypes.JSON, allowNull: true },
    nextPart: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    status: {
      type: DataTypes.ENUM('pending', 'sent', 'failed'),
      allowNull: false,
      defaultValue: 'pending',
    },
    attempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    nextAttemptAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: DataTypes.NOW },
    sentAt: DataTypes.DATE,
    lastError: DataTypes.STRING(100),
  },
  { tableName: 'after_sale_notifications', indexes: [{ fields: ['status', 'nextAttemptAt'] }] },
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
    channelExchangeRate: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    currentExchangeRate: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    taxMultiplier: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    purchaseDiscount: { type: DataTypes.DECIMAL(36, 20), allowNull: true },
    ...Object.fromEntries(
      ['fba', 'fbm'].flatMap((mode) => [
        ...['ChannelExchangeRate', 'CurrentExchangeRate', 'TaxMultiplier'].map((key) => [
          `${mode}${key}`,
          { type: DataTypes.DECIMAL(14, 2), allowNull: true },
        ]),
        [`${mode}PurchaseDiscount`, { type: DataTypes.DECIMAL(36, 20), allowNull: true }],
      ]),
    ),
    modeDiscountInitialized: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  { tableName: 'dictionary_options', indexes: [{ unique: true, fields: ['kind', 'value'] }] },
);
export const Store = db.define(
  'Store',
  {
    id: id(),
    walmartStoreName: { type: DataTypes.STRING(191), allowNull: false, unique: true },
    systemStoreName: { type: DataTypes.STRING(191), allowNull: false, unique: true },
    ownerId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    isThirdParty: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    commissionRate: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    clientId: { type: DataTypes.STRING(255), allowNull: true },
    clientSecret: { type: DataTypes.TEXT, allowNull: true },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  },
  { tableName: 'stores' },
);
export const RiskAddress = db.define(
  'RiskAddress',
  {
    id: id(),
    address1: { type: DataTypes.STRING(255), allowNull: false },
    address2: { type: DataTypes.STRING(255), allowNull: true },
    city: { type: DataTypes.STRING(255), allowNull: false },
    state: { type: DataTypes.STRING(255), allowNull: false },
    postalCode: { type: DataTypes.STRING(255), allowNull: false },
    note: { type: DataTypes.TEXT, allowNull: true },
    addressKey: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    version: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  },
  { tableName: 'risk_addresses' },
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
OrderItem.hasOne(PurchaseAfterSale, {
  as: 'purchaseAfterSale',
  foreignKey: 'itemId',
  onDelete: 'RESTRICT',
});
PurchaseAfterSale.belongsTo(OrderItem, { as: 'item', foreignKey: 'itemId', onDelete: 'RESTRICT' });
ChannelChangeTicket.belongsTo(OrderItem, {
  as: 'item',
  foreignKey: 'itemId',
  onDelete: 'RESTRICT',
});
ChannelChangeRecord.belongsTo(ChannelChangeTicket, {
  foreignKey: 'ticketId',
  onDelete: 'RESTRICT',
});
PurchaseAfterSaleRecord.belongsTo(PurchaseAfterSale, {
  foreignKey: 'ticketId',
  onDelete: 'RESTRICT',
});
OrderItem.hasOne(Purchase, { as: 'purchase', foreignKey: 'itemId', onDelete: 'CASCADE' });
Purchase.belongsTo(OrderItem, { foreignKey: 'itemId' });
Purchase.belongsTo(User, { as: 'assignee', foreignKey: 'assignedTo', onDelete: 'SET NULL' });
Store.belongsTo(User, { as: 'owner', foreignKey: 'ownerId', onDelete: 'SET NULL' });
// 历史订单允许没有店铺配置；通过系统店铺名实时读取归属，不复制账号到每条订单。
OrderItem.belongsTo(Store, {
  as: 'store',
  foreignKey: 'shopName',
  targetKey: 'systemStoreName',
  constraints: false,
});
export const storeOwnerInclude = {
  model: User,
  as: 'owner',
  attributes: ['id', 'username', 'displayName'],
  required: false,
};
// 不建立外键约束：普通地址无需存在于风险地址表；读取时实时匹配，维护立即作用于历史订单。
OrderItem.belongsTo(RiskAddress, {
  as: 'riskAddress',
  foreignKey: 'addressKey',
  targetKey: 'addressKey',
  constraints: false,
});
export const itemInclude = [
  { model: Order, as: 'order' },
  {
    model: PurchaseAfterSale,
    as: 'purchaseAfterSale',
    attributes: ['id', 'status', 'purchaseRefundAmount'],
    required: false,
  },
  {
    model: Purchase,
    as: 'purchase',
    include: [
      { model: User, as: 'assignee', attributes: ['id', 'username', 'displayName', 'role'] },
    ],
  },
  { model: RiskAddress, as: 'riskAddress', required: false },
  {
    model: Store,
    as: 'store',
    attributes: ['id', 'systemStoreName', 'ownerId', 'isThirdParty', 'commissionRate'],
    required: false,
    include: [storeOwnerInclude],
  },
];
export function serializeItem(instance) {
  const value = instance.toJSON ? instance.toJSON() : instance;
  const result = {
    id: value.id,
    version: value.version,
    isLoss: Boolean(value.isLoss),
    orderNumber: value.order?.orderNumber,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    assignedTo: value.purchase?.assignedTo || null,
    assignedAt: value.purchase?.assignedAt || null,
    assignee: value.purchase?.assignee || null,
    storeOwner: value.store?.owner || null,
    storeIsThirdParty: Boolean(value.store?.isThirdParty),
    // 仅供未结算详情展示当前配置，不能覆盖结算快照或参与利润/导出。
    storeCommissionRate: value.store?.commissionRate ?? null,
    purchaseAfterSale: value.purchaseAfterSale || null,
    channelChangeTicket: value.channelChangeTicket || null,
    manualEditable: !isWfsOrder(value),
    priceFactorLevel: priceFactorLevel(value.purchase?.priceFactor),
    purchaseConfirmedAt: value.purchase?.purchaseConfirmedAt || null,
    purchaseAssignedAt: value.purchase?.purchaseAssignedAt || null,
    reviewStatus: value.purchase?.reviewStatus || null,
    supplierAssignmentStatus: value.purchase?.supplierAssignmentStatus || null,
    walmart: value.walmart || null,
    returnInfo: value.returnInfo || null,
    returnStatuses: value.returnInfo?.statuses || [],
    addressRisk: Boolean(value.riskAddress),
    addressRiskNote: value.riskAddress?.note || null,
  };
  for (const f of fields) {
    if (f.key === 'orderNumber') continue;
    const stored = (f.group === 'purchase' ? value.purchase?.[f.key] : value[f.key]) ?? null;
    result[f.key] =
      stored != null && ['money', 'decimal'].includes(f.type)
        ? decimalText(stored, f.type === 'money' ? 2 : 4)
        : stored;
  }
  // 工单存在即为采购售后，完毕后仍为“是”；不回写或迁移旧人工标记。
  result.afterSales = value.purchaseAfterSale ? '是' : '否';
  Object.assign(result, itemProfit(value));
  result.sku = result.walmartSku;
  return result;
}
