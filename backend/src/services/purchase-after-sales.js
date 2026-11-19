import { Op, col, fn, where as sqlWhere } from 'sequelize';
import { randomUUID } from 'node:crypto';
import {
  db,
  PurchaseAfterSale as Ticket,
  PurchaseAfterSaleRecord as Record,
  OrderItem,
  Order,
  Store,
  User,
  Upload,
  AuditLog,
  Purchase,
} from '../models.js';
import { storedChannels } from '../lib/channels.js';
import { queueAfterSaleNotification } from './wecom-after-sales.js';
import { assert } from '../errors.js';
import { requirePermission, assertItemAccess } from '../permissions.js';
import { assertOrderEditable, isWfsOrder } from '../lib/order-write-policy.js';
import { filterValues } from '../lib/filter-values.js';

function createdDate(value) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), '创建日期格式无效');
  const date = new Date(`${value}T00:00:00+08:00`);
  assert(
    Number.isFinite(date.getTime()) &&
      new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10) === value,
    '创建日期无效',
  );
  return date;
}

export async function purchaseAfterSaleOptions(user) {
  requirePermission(user, 'purchase-after-sales');
  const stores = await Store.findAll({
    ...(user.role === 'operations' ? { where: { ownerId: user.id } } : {}),
    attributes: ['id', 'systemStoreName', 'ownerId', 'isThirdParty'],
    include: [
      { model: User, as: 'owner', attributes: ['displayName', 'username'], required: false },
    ],
    order: [['systemStoreName', 'ASC']],
  });
  return {
    stores: stores.map((store) => ({
      id: store.id,
      name: store.systemStoreName,
      ownerId: store.ownerId,
      owner: store.owner?.displayName || '',
      ownerUsername: store.owner?.username || '',
      isThirdParty: Boolean(store.isThirdParty),
    })),
  };
}

const positiveId = (value) => {
  const id = Number(value);
  assert(Number.isSafeInteger(id) && id > 0, '编号无效');
  return id;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const itemInclude = [
  { model: Order, as: 'order', attributes: ['orderNumber'], required: true },
  { model: Store, as: 'store', attributes: ['ownerId', 'isThirdParty'], required: false },
  {
    model: Purchase,
    as: 'purchase',
    attributes: ['purchaseChannel', 'purchaseStatus'],
    required: false,
  },
];
function summary(ticket) {
  const value = ticket.toJSON();
  const item = value.item;
  return {
    id: value.id,
    itemId: value.itemId,
    status: value.status,
    version: value.version,
    creatorName: value.creatorName,
    supplierFeedback: Boolean(value.supplierFeedbackAt),
    supplierFeedbackAt: value.supplierFeedbackAt,
    supplierFeedbackBy: value.supplierFeedbackBy,
    supplierFeedbackName: value.supplierFeedbackName,
    createdAt: value.createdAt,
    lastActivityAt: value.lastActivityAt,
    completedAt: value.completedAt,
    purchaseRefundAmount: value.purchaseRefundAmount ?? null,
    item: {
      id: item.id,
      shopName: item.shopName,
      orderNumber: item.order.orderNumber,
      walmartSku: item.walmartSku,
      productName: item.productName,
      productImage: item.productImage,
      storeIsThirdParty: Boolean(item.store?.isThirdParty),
      manualEditable: !isWfsOrder(item),
      purchaseChannel: storedChannels(item.purchase?.purchaseChannel) || [],
      purchaseStatus: item.purchase?.purchaseStatus || null,
    },
  };
}
const itemFields = [
  'id',
  'shopName',
  'walmartSku',
  'productName',
  'productImage',
  'fulfillmentParty',
  'orderId',
];
async function findTicket(id, user, transaction, lock = false) {
  requirePermission(user, 'purchase-after-sales');
  let ticket = await Ticket.findByPk(positiveId(id), { transaction });
  assert(ticket, '采购售后工单不存在', 404);
  const item = await OrderItem.findByPk(ticket.itemId, {
    transaction,
    ...(lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  assert(item, '关联订单不存在', 404);
  await assertItemAccess(item, user, transaction);
  if (lock)
    ticket = await Ticket.findByPk(ticket.id, { transaction, lock: transaction.LOCK.UPDATE });
  return { ticket, item };
}
async function messageInput(input, user, transaction) {
  assert(input && typeof input.content === 'string', '请填写售后内容');
  const content = input.content.trim();
  assert(content.length > 0 && content.length <= 12000, '售后内容须为1至12000个字符');
  assert(
    typeof input.requestId === 'string' && uuid.test(input.requestId),
    '提交标识无效，请重新打开输入框',
  );
  const images = input.images ?? [];
  assert(Array.isArray(images) && images.length <= 20, '每条记录最多上传20张图片');
  assert(
    images.every(
      (path) => typeof path === 'string' && /^\/uploads\/images\/[0-9a-f-]{36}\.webp$/.test(path),
    ),
    '请使用上传框上传图片',
  );
  const uniqueImages = [...new Set(images)];
  if (uniqueImages.length) {
    const uploads = await Upload.findAll({
      where: {
        filename: { [Op.in]: uniqueImages.map((path) => path.split('/').pop()) },
        kind: 'image',
        uploadedBy: user.id,
      },
      attributes: ['id'],
      transaction,
    });
    assert(uploads.length === uniqueImages.length, '图片不存在或不是当前账号上传的图片');
  }
  return { content, images: uniqueImages, requestId: input.requestId };
}
async function addRecord(ticket, user, data, transaction) {
  const record = await Record.create(
    {
      ticketId: ticket.id,
      actorId: user.id,
      actorName: user.displayName,
      actorRole: user.role,
      ...data,
    },
    { transaction },
  );
  await AuditLog.create(
    {
      userId: user.id,
      action: 'purchase_after_sale',
      entityId: String(ticket.id),
      details: {
        resource: 'purchase-after-sales',
        itemId: ticket.itemId,
        recordId: record.id,
        kind: record.kind,
        content: record.content,
        images: record.images,
        status: ticket.status,
      },
    },
    { transaction },
  );
  return record;
}

export async function createPurchaseAfterSale(input, user) {
  requirePermission(user, 'purchase-after-sales');
  assert(input && typeof input === 'object', '请填写工单内容');
  return db.transaction(async (transaction) => {
    // 锁定明细，两个账号同时创建也只会有一个工单。
    const item = await OrderItem.findByPk(positiveId(input.itemId), {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    assert(item, '商品明细不存在', 404);
    await assertItemAccess(item, user, transaction);
    assertOrderEditable(item);
    const data = await messageInput(input, user, transaction);
    const existing = await Ticket.findOne({
      where: { itemId: item.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (existing) {
      const previous = await Record.findOne({
        where: { ticketId: existing.id, requestId: data.requestId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      assert(
        previous &&
          previous.actorId === user.id &&
          previous.content === data.content &&
          JSON.stringify(previous.images) === JSON.stringify(data.images),
        '该商品已有采购售后工单，请刷新订单后进入工单追加记录',
        409,
      );
      return { id: existing.id };
    }
    const ticket = await Ticket.create(
      {
        itemId: item.id,
        createdBy: user.id,
        creatorName: user.displayName,
        lastActivityAt: new Date(),
      },
      { transaction },
    );
    const record = await addRecord(ticket, user, { kind: 'message', ...data }, transaction);
    await queueAfterSaleNotification(ticket, item, record, 'created', transaction);
    return { id: ticket.id };
  });
}

export async function listPurchaseAfterSales(query, user) {
  requirePermission(user, 'purchase-after-sales');
  const page = positiveId(query.page || 1),
    pageSize = Number(query.pageSize || 20);
  assert(page <= 1000000 && [20, 50, 100].includes(pageSize), '分页参数无效');
  const where = {},
    itemWhere = {};
  const shopNames = filterValues(query.shopNames, '店铺筛选格式无效');
  if (shopNames.length) itemWhere.shopName = { [Op.in]: shopNames };
  if (query.ownerId != null && query.ownerId !== '')
    where['$item.store.ownerId$'] = positiveId(query.ownerId);
  if (query.startDate || query.endDate) {
    where.createdAt = {};
    if (query.startDate) where.createdAt[Op.gte] = createdDate(query.startDate);
    if (query.endDate)
      where.createdAt[Op.lt] = new Date(createdDate(query.endDate).getTime() + 86400000);
    assert(
      !query.startDate || !query.endDate || query.startDate <= query.endDate,
      '开始日期不能晚于结束日期',
    );
  }
  if (query.status) {
    assert(['open', 'completed'].includes(query.status), '工单状态无效');
    where.status = query.status;
  }
  if (query.q) {
    assert(typeof query.q === 'string' && query.q.length <= 191, '关键词最多191个字符');
    const like = `%${query.q.trim().replace(/[\\%_]/g, '\\$&')}%`;
    where[Op.or] = ['shopName', 'walmartSku', 'productName'].map((key) => ({
      [`$item.${key}$`]: { [Op.like]: like },
    }));
    where[Op.or].push({ '$item.order.orderNumber$': { [Op.like]: like } });
  }
  if (user.role === 'operations') where[Op.and] = [{ '$item.store.ownerId$': user.id }];
  const purchaseConditions = [];
  const statuses = filterValues(query.purchaseStatus, '采购状态筛选格式无效');
  const statusConditions = statuses.length
    ? [sqlWhere(col('item.purchase.purchaseStatus'), { [Op.in]: statuses })]
    : [];
  if (query.purchaseStatusEmpty === 'true' || query.purchaseStatusEmpty === true)
    statusConditions.push(
      { '$item.purchase.purchaseStatus$': null },
      sqlWhere(col('item.purchase.purchaseStatus'), { [Op.regexp]: '^[[:space:]]*$' }),
    );
  if (statusConditions.length) purchaseConditions.push({ [Op.or]: statusConditions });
  const channelColumn = col('item.purchase.purchaseChannel');
  const channelConditions = [];
  if (query.purchaseChannelEmpty === 'true' || query.purchaseChannelEmpty === true)
    channelConditions.push(
      { '$item.purchase.purchaseChannel$': null },
      sqlWhere(fn('TRIM', channelColumn), { [Op.in]: ['', '[]', 'null', '""'] }),
    );
  for (const channel of filterValues(query.purchaseChannel, '采购渠道筛选格式无效'))
    channelConditions.push(
      sqlWhere(
        fn(
          'JSON_CONTAINS',
          fn('IF', fn('JSON_VALID', channelColumn), channelColumn, fn('JSON_ARRAY', channelColumn)),
          JSON.stringify(channel),
        ),
        1,
      ),
    );
  if (channelConditions.length) purchaseConditions.push({ [Op.or]: channelConditions });
  where[Op.and] = [...(where[Op.and] || []), ...purchaseConditions];
  const include = [
    {
      model: OrderItem,
      as: 'item',
      attributes: itemFields,
      where: itemWhere,
      include: itemInclude,
    },
  ];
  // 未反馈跨分页，独立于工单状态和反馈筛选，其他条件及权限保持一致。
  const unfeedbackWhere = { ...where, supplierFeedbackAt: null };
  delete unfeedbackWhere.status;
  if (query.supplierFeedback != null && query.supplierFeedback !== '') {
    assert(['yes', 'no'].includes(query.supplierFeedback), '是否已反馈供应商筛选无效');
    where.supplierFeedbackAt = query.supplierFeedback === 'yes' ? { [Op.ne]: null } : null;
  }
  const [result, openCount, unfeedbackCount] = await Promise.all([
    Ticket.findAndCountAll({
      where,
      include,
      order: [
        ['lastActivityAt', 'DESC'],
        ['id', 'DESC'],
      ],
      limit: pageSize,
      offset: (page - 1) * pageSize,
      subQuery: false,
    }),
    Ticket.count({ where: { ...where, status: 'open' }, include }),
    Ticket.count({ where: unfeedbackWhere, include }),
  ]);
  return { rows: result.rows.map(summary), total: result.count, openCount, unfeedbackCount };
}

export async function getPurchaseAfterSale(id, query, user) {
  const current = await findTicket(id, user);
  if (query.knownVersion && positiveId(query.knownVersion) === current.ticket.version)
    return { unchanged: true };
  const ticket = await Ticket.findByPk(positiveId(id), {
    include: [{ model: OrderItem, as: 'item', attributes: itemFields, include: itemInclude }],
  });
  // 再次以当前店铺归属校验，避免详情加载期间店铺归属变更绕过权限。
  await assertItemAccess(ticket.item, user);
  const where = { ticketId: ticket.id };
  if (query.before) where.id = { [Op.lt]: positiveId(query.before) };
  const records = await Record.findAll({ where, order: [['id', 'DESC']], limit: 51 });
  const hasMore = records.length > 50;
  const visible = records.slice(0, 50).reverse();
  return { ...summary(ticket), records: visible, hasMore, before: visible[0]?.id || null };
}

export async function replyPurchaseAfterSale(id, input, user) {
  return db.transaction(async (transaction) => {
    const { ticket, item } = await findTicket(id, user, transaction, true);
    assertOrderEditable(item);
    const data = await messageInput(input, user, transaction);
    const previous = await Record.findOne({
      where: { ticketId: ticket.id, requestId: data.requestId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (previous) {
      assert(
        previous.actorId === user.id &&
          previous.kind === 'message' &&
          previous.content === data.content &&
          JSON.stringify(previous.images) === JSON.stringify(data.images),
        '提交标识已用于其他内容，请刷新后重试',
        409,
      );
      return { id: previous.id };
    }
    assert(ticket.status === 'open', '工单已结束，请先重新打开再追加记录', 409);
    const record = await addRecord(ticket, user, { kind: 'message', ...data }, transaction);
    await queueAfterSaleNotification(ticket, item, record, 'reply', transaction);
    await ticket.update(
      { lastActivityAt: new Date(), version: ticket.version + 1 },
      { transaction },
    );
    return { id: record.id };
  });
}

export async function changePurchaseAfterSaleStatus(id, input, user) {
  assert(['open', 'completed'].includes(input?.status), '工单状态无效');
  return db.transaction(async (transaction) => {
    const { ticket, item } = await findTicket(id, user, transaction, true);
    assertOrderEditable(item);
    assert(
      Number.isSafeInteger(input.version) && input.version === ticket.version,
      '工单已有新记录或状态变化，请刷新后再操作',
      409,
    );
    assert(ticket.status !== input.status, '工单状态未发生变化', 409);
    if (input.status === 'completed')
      assert(ticket.purchaseRefundAmount != null, '请先填写并保存采购退款金额，无退款请填0');
    const now = new Date();
    await ticket.update(
      {
        status: input.status,
        completedAt: input.status === 'completed' ? now : null,
        lastActivityAt: now,
        version: ticket.version + 1,
      },
      { transaction },
    );
    await addRecord(
      ticket,
      user,
      {
        kind: input.status === 'completed' ? 'completed' : 'reopened',
        content: input.status === 'completed' ? '标记售后完毕' : '重新打开售后工单',
        images: [],
        requestId: randomUUID(),
      },
      transaction,
    );
    return { id: ticket.id, status: ticket.status };
  });
}

function refundAmount(value) {
  assert(value === null || ['string', 'number'].includes(typeof value), '采购退款金额格式无效');
  const text = value === null ? '' : String(value).trim();
  if (!text) return null;
  assert(/^\d{1,16}(?:\.\d{1,2})?$/.test(text), '采购退款金额须为非负数字，最多16位整数、2位小数');
  const [whole, fraction = ''] = text.split('.');
  return `${BigInt(whole)}.${fraction.padEnd(2, '0')}`;
}

export async function savePurchaseRefundAmount(id, input, user) {
  return db.transaction(async (transaction) => {
    const { ticket, item } = await findTicket(id, user, transaction, true);
    assertOrderEditable(item);
    assert(ticket.status === 'open', '工单已结束，请先重新打开再修改采购退款金额', 409);
    assert(
      Number.isSafeInteger(input?.version) && input.version === ticket.version,
      '工单已有新记录或状态变化，请刷新后再操作',
      409,
    );
    const amount = refundAmount(input.purchaseRefundAmount);
    const before = ticket.purchaseRefundAmount;
    if (amount !== before) {
      const now = new Date();
      await ticket.update(
        { purchaseRefundAmount: amount, lastActivityAt: now, version: ticket.version + 1 },
        { transaction },
      );
      await AuditLog.create(
        {
          userId: user.id,
          action: 'purchase_after_sale',
          entityId: String(ticket.id),
          details: {
            resource: 'purchase-after-sales',
            itemId: item.id,
            kind: 'refund_amount',
            content: '修改采购退款金额',
            actorName: user.displayName,
            before: { purchaseRefundAmount: before },
            after: { purchaseRefundAmount: amount },
          },
        },
        { transaction },
      );
    }
    return {
      id: ticket.id,
      purchaseRefundAmount: ticket.purchaseRefundAmount,
      version: ticket.version,
      lastActivityAt: ticket.lastActivityAt,
    };
  });
}

export async function markSupplierFeedback(id, user) {
  requirePermission(user, 'procurement');
  return db.transaction(async (transaction) => {
    const { ticket, item } = await findTicket(id, user, transaction, true);
    assertOrderEditable(item);
    // 单向标记，重复提交保留首次操作人和时间，不重复记录日志。
    if (!ticket.supplierFeedbackAt) {
      const now = new Date();
      await ticket.update(
        {
          supplierFeedbackAt: now,
          supplierFeedbackBy: user.id,
          supplierFeedbackName: user.displayName,
          lastActivityAt: now,
          version: ticket.version + 1,
        },
        { transaction },
      );
      await AuditLog.create(
        {
          userId: user.id,
          action: 'purchase_after_sale',
          entityId: String(ticket.id),
          details: {
            resource: 'purchase-after-sales',
            itemId: item.id,
            kind: 'supplier_feedback',
            content: '标记已反馈供应商',
            supplierFeedback: true,
            actorName: user.displayName,
            supplierFeedbackAt: now,
          },
        },
        { transaction },
      );
    }
    return {
      id: ticket.id,
      supplierFeedback: true,
      supplierFeedbackAt: ticket.supplierFeedbackAt,
      supplierFeedbackBy: ticket.supplierFeedbackBy,
      supplierFeedbackName: ticket.supplierFeedbackName,
    };
  });
}
