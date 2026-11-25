import { Op, fn, col, literal, where as sqlWhere } from 'sequelize';
import { randomUUID } from 'node:crypto';
import {
  db,
  ChannelChangeTicket as Ticket,
  ChannelChangeRecord as Record,
  OrderItem,
  Order,
  Store,
  User,
  Purchase,
  AuditLog,
} from '../models.js';
import { assert } from '../errors.js';
import { requirePermission, assertItemAccess } from '../permissions.js';
import { assertOrderEditable, isWfsOrder } from '../lib/order-write-policy.js';
import { storedChannels } from '../lib/channels.js';
import { channelKey } from '../lib/order-identity.js';
import { procurementStatePatch } from '../lib/procurement-state.js';
import { validatePatch } from '../validation.js';
import { getFieldDefinitions } from './dictionaries.js';
import { messageInput } from './purchase-after-sales.js';
import { queueAfterSaleNotification } from './wecom-after-sales.js';

import { sameFieldValue } from '../lib/order-concurrency.js';
import { derivePurchaseFields } from '../lib/purchase-derived.js';
import { purchaseTimerPatch } from '../lib/purchase-timer.js';
import { purchaseCostPatch } from './purchase-cost.js';
import { filterValues } from '../lib/filter-values.js';

const permission = 'channel-change-tickets';
const purchaseKeys = [
  'purchaseUrl',
  'purchaseSku',
  'purchaseLinkAmount',
  'purchasePlatform',
  'shippingMode',
  'merchantName',
];
const purchaseSnapshot = (purchase) =>
  Object.fromEntries([...purchaseKeys, 'purchaseLimit'].map((key) => [key, purchase[key] ?? null]));
async function purchaseRequest(input, before, transaction) {
  assert(input && typeof input === 'object' && !Array.isArray(input), '采购信息格式错误');
  assert(
    Object.keys(input).every((key) => purchaseKeys.includes(key)),
    '只能修改申请中的采购信息，采购限价由系统计算',
  );
  const changed = Object.fromEntries(
    Object.entries(input).filter(([key, value]) => !sameFieldValue(key, before[key], value)),
  );
  return {
    ...Object.fromEntries(purchaseKeys.map((key) => [key, before[key] ?? null])),
    ...validatePatch(changed, {
      fieldDefinitions: (await getFieldDefinitions(transaction)).filter((field) =>
        purchaseKeys.includes(field.key),
      ),
    }),
  };
}
const positiveId = (value) => {
  const id = Number(value);
  assert(Number.isSafeInteger(id) && id > 0, '编号无效');
  return id;
};
const sameChannels = (a, b) => channelKey(a) === channelKey(b);
const itemInclude = [
  { model: Order, as: 'order', attributes: ['orderNumber'], required: true },
  { model: Store, as: 'store', attributes: ['ownerId', 'isThirdParty'], required: false },
  {
    model: Purchase,
    as: 'purchase',
    attributes: [
      'purchaseChannel',
      'purchaseStatus',
      'purchaseSku',
      'purchaseLinkAmount',
      'merchantName',
      'purchaseLimit',
      'purchaseAmount',
      'purchaseQuantity',
      'shippingMode',
      'purchaseUrl',
      'purchasePlatform',
      'trackingNumber',
      'allocatable',
    ],
    required: false,
  },
];
const itemFields = [
  'id',
  'version',
  'shopName',
  'walmartSku',
  'productName',
  'productImage',
  'quantity',
  'orderAmount',
  'fulfillmentParty',
  'orderId',
];
function summary(ticket) {
  const value = ticket.toJSON(),
    item = value.item;
  delete value.item;
  return {
    ...value,
    item: {
      ...item,
      order: undefined,
      store: undefined,
      purchase: undefined,
      orderNumber: item.order.orderNumber,
      storeIsThirdParty: Boolean(item.store?.isThirdParty),
      manualEditable: !isWfsOrder(item),
      ...item.purchase,
      id: item.id,
      purchaseChannel: storedChannels(item.purchase?.purchaseChannel) || [],
    },
  };
}
async function lockedTicket(id, user, transaction) {
  requirePermission(user, permission);
  const first = await Ticket.findByPk(positiveId(id), { transaction });
  assert(first, '渠道变更工单不存在', 404);
  // 所有写入统一先锁商品，再锁工单，串行化创建、重开与确认。
  const item = await OrderItem.findByPk(first.itemId, {
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  assert(item, '关联订单不存在', 404);
  await assertItemAccess(item, user, transaction);
  assertOrderEditable(item);
  const ticket = await Ticket.findByPk(first.id, { transaction, lock: transaction.LOCK.UPDATE });
  return { item, ticket };
}
function checkVersion(ticket, input) {
  assert(
    Number.isSafeInteger(input?.version) && input.version === ticket.version,
    '工单已有新记录或状态变化，请刷新后再操作',
    409,
  );
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
      action: 'channel_change_ticket',
      entityId: String(ticket.id),
      details: {
        resource: permission,
        itemId: ticket.itemId,
        recordId: record.id,
        kind: record.kind,
        content: record.content,
        images: record.images,
        status: ticket.status,
        beforeChannels: ticket.beforeChannels,
        targetChannels: ticket.targetChannels,
        beforePurchase: ticket.beforePurchase,
        targetPurchase: ticket.targetPurchase,
        executedBefore: ticket.executedBefore,
        executedAfter: ticket.executedAfter,
      },
    },
    { transaction },
  );
  return record;
}
function matchesMessage(record, user, data) {
  return (
    record &&
    record.actorId === user.id &&
    record.kind === 'message' &&
    record.content === data.content &&
    JSON.stringify(record.images) === JSON.stringify(data.images)
  );
}
async function targetChannels(input, transaction) {
  assert(
    Array.isArray(input) &&
      input.length > 0 &&
      input.length <= 100 &&
      input.every((v) => typeof v === 'string' && v.trim()),
    '请选择需要变更的采购渠道',
  );
  return validatePatch(
    { purchaseChannel: input },
    { fieldDefinitions: await getFieldDefinitions(transaction) },
  ).purchaseChannel;
}
export async function createChannelChange(input, user) {
  requirePermission(user, permission);
  assert(input && typeof input === 'object', '请填写工单内容');
  assert(
    input.targetChannels == null ||
      (Array.isArray(input.targetChannels) && input.targetChannels.length === 0),
    '创建工单时不能选择采购渠道，请由采购或管理员在工单中分配',
  );
  return db.transaction(async (transaction) => {
    const item = await OrderItem.findByPk(positiveId(input.itemId), {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    assert(item, '商品明细不存在', 404);
    await assertItemAccess(item, user, transaction);
    assertOrderEditable(item);
    const data = await messageInput(input, user, transaction, '变更');
    const previous = await Ticket.findOne({ where: { requestId: data.requestId }, transaction });
    if (previous) {
      const requestedPurchase =
        input.purchaseFields == null
          ? null
          : await purchaseRequest(input.purchaseFields, previous.beforePurchase || {}, transaction);
      const samePurchase =
        previous.targetPurchase == null
          ? requestedPurchase == null
          : requestedPurchase != null &&
            purchaseKeys.every((key) =>
              sameFieldValue(key, previous.targetPurchase[key], requestedPurchase[key]),
            );
      const record = await Record.findOne({
        where: { ticketId: previous.id, requestId: data.requestId },
        transaction,
      });
      assert(
        previous.itemId === item.id && samePurchase && matchesMessage(record, user, data),
        '提交标识已用于其他内容，请重新打开输入框',
        409,
      );
      return { id: previous.id, status: previous.status, itemId: item.id };
    }
    assert(
      !(await Ticket.findOne({ where: { openItemId: item.id }, transaction })),
      '该商品已有未关闭的渠道变更工单，请刷新订单后进入工单',
      409,
    );
    assert(
      Number.isInteger(input.itemVersion) && input.itemVersion === item.version,
      '订单已更新，请刷新后再创建工单',
      409,
    );
    const purchase = await Purchase.findOne({
      where: { itemId: item.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    assert(purchase, '采购记录不存在', 404);
    const target = [];
    const before = storedChannels(purchase.purchaseChannel) || [];
    const beforePurchase = input.purchaseFields == null ? null : purchaseSnapshot(purchase);
    const targetPurchase =
      beforePurchase == null
        ? null
        : await purchaseRequest(input.purchaseFields, beforePurchase, transaction);
    if (targetPurchase)
      targetPurchase.purchaseLimit = derivePurchaseFields({
        orderAmount: item.orderAmount,
        tax: item.tax,
        purchaseLinkAmount: targetPurchase.purchaseLinkAmount,
      }).purchaseLimit;
    const ticket = await Ticket.create(
      {
        itemId: item.id,
        openItemId: item.id,
        requestId: data.requestId,
        beforeChannels: before,
        targetChannels: target,
        beforePurchase,
        targetPurchase,
        createdBy: user.id,
        creatorName: user.displayName,
        lastActivityAt: new Date(),
      },
      { transaction },
    );
    const record = await addRecord(ticket, user, { kind: 'message', ...data }, transaction);
    await queueAfterSaleNotification(ticket, item, record, 'created', transaction, true);
    return { id: ticket.id, itemId: item.id, status: ticket.status };
  });
}
function createdDate(value) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), '创建日期格式无效');
  const date = new Date(`${value}T00:00:00+08:00`);
  assert(
    Number.isFinite(date.getTime()) &&
      new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10) === value,
    '创建日期无效',
  );
  assert(date.getTime() <= Date.now(), '创建日期不能晚于北京时间今天');
  return date;
}

export async function channelChangeOptions(user) {
  requirePermission(user, permission);
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

function channelChangeFilters(query, user) {
  requirePermission(user, permission);
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
  if (user.role === 'operations') where[Op.and] = [{ '$item.store.ownerId$': user.id }];
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
  if (query.itemId) where.itemId = positiveId(query.itemId);
  const include = [
    {
      model: OrderItem,
      as: 'item',
      attributes: itemFields,
      where: itemWhere,
      required: true,
      include: itemInclude,
    },
  ];
  return { where, include };
}
export async function channelChangeExportItems(query, user) {
  const { where, include } = channelChangeFilters(query, user);
  const stripped = include.map((entry) => ({
    ...entry,
    attributes: [],
    include: entry.include.map((nested) => ({ ...nested, attributes: [] })),
  }));
  const rows = await Ticket.findAll({
    where,
    include: stripped,
    attributes: ['itemId'],
    group: ['ChannelChangeTicket.itemId'],
    raw: true,
  });
  return rows.map((row) => row.itemId);
}
export async function listChannelChanges(query, user) {
  const { where, include } = channelChangeFilters(query, user);
  const page = positiveId(query.page || 1),
    pageSize = Number(query.pageSize || 20);
  assert(page <= 1000000 && [20, 50, 100].includes(pageSize), '分页参数无效');
  const [result, openCount] = await Promise.all([
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
  ]);
  return {
    rows: result.rows.map(summary),
    total: result.count,
    openCount,
    serverNow: new Date().toISOString(),
  };
}
export async function getChannelChange(id, query, user) {
  requirePermission(user, permission);
  const ticket = await Ticket.findByPk(positiveId(id), {
    include: [{ model: OrderItem, as: 'item', attributes: itemFields, include: itemInclude }],
  });
  assert(ticket?.item, '渠道变更工单不存在', 404);
  await assertItemAccess(ticket.item, user);
  const where = { ticketId: ticket.id };
  if (query.before) where.id = { [Op.lt]: positiveId(query.before) };
  const records = await Record.findAll({ where, order: [['id', 'DESC']], limit: 51 });
  const visible = records.slice(0, 50).reverse();
  return {
    ...summary(ticket),
    records: visible,
    hasMore: records.length > 50,
    before: visible[0]?.id || null,
  };
}
export async function replyChannelChange(id, input, user) {
  return db.transaction(async (transaction) => {
    const { ticket, item } = await lockedTicket(id, user, transaction);
    const data = await messageInput(input, user, transaction, '变更');
    const previous = await Record.findOne({
      where: { ticketId: ticket.id, requestId: data.requestId },
      transaction,
    });
    if (previous) {
      assert(matchesMessage(previous, user, data), '提交标识已用于其他内容', 409);
      return { id: previous.id };
    }
    assert(ticket.status === 'open', '工单已关闭，请先重新打开再追加记录', 409);
    const record = await addRecord(ticket, user, { kind: 'message', ...data }, transaction);
    await queueAfterSaleNotification(ticket, item, record, 'reply', transaction, true);
    await ticket.update(
      { lastActivityAt: new Date(), version: ticket.version + 1 },
      { transaction },
    );
    return { id: record.id };
  });
}
export async function changeChannelTicketStatus(id, input, user) {
  assert(['open', 'completed'].includes(input?.status), '工单状态无效');
  return db.transaction(async (transaction) => {
    const { ticket, item } = await lockedTicket(id, user, transaction);
    checkVersion(ticket, input);
    assert(ticket.status !== input.status, '工单状态未发生变化', 409);
    if (input.status === 'open')
      assert(
        !(await Ticket.findOne({
          where: { openItemId: item.id },
          transaction,
          lock: transaction.LOCK.UPDATE,
        })),
        '该商品已有其他未关闭工单，请先处理该工单',
        409,
      );
    const now = new Date(),
      closed = input.status === 'completed';
    await ticket.update(
      {
        status: input.status,
        openItemId: closed ? null : item.id,
        completedAt: closed ? now : null,
        lastActivityAt: now,
        version: ticket.version + 1,
      },
      { transaction },
    );
    await addRecord(
      ticket,
      user,
      {
        kind: closed ? 'completed' : 'reopened',
        content: closed ? '关闭渠道变更工单' : '重新打开渠道变更工单',
        images: [],
        requestId: randomUUID(),
      },
      transaction,
    );
    return { id: ticket.id, itemId: item.id, status: ticket.status };
  });
}
export async function applyChannelChange(id, input, user) {
  requirePermission(user, 'assign-channel');
  return db.transaction((transaction) => applyInTransaction(id, input, user, transaction));
}

export async function batchApplyChannelChanges(input, user) {
  requirePermission(user, 'assign-channel');
  requirePermission(user, permission);
  const entries = input?.items;
  assert(
    Array.isArray(entries) && entries.length > 0 && entries.length <= 500,
    '请选择 1 至 500 条工单',
  );
  assert(
    entries.every(
      (entry) =>
        Number.isSafeInteger(entry?.id) &&
        entry.id > 0 &&
        Number.isSafeInteger(entry?.version) &&
        entry.version > 0,
    ),
    '工单参数错误',
  );
  assert(new Set(entries.map((entry) => entry.id)).size === entries.length, '工单不能重复');
  return db.transaction(async (transaction) => {
    const tickets = await Ticket.findAll({
      where: { id: { [Op.in]: entries.map((entry) => entry.id) } },
      attributes: ['id', 'itemId'],
      transaction,
    });
    assert(tickets.length === entries.length, '部分工单已不存在，请刷新', 404);
    assert(
      new Set(tickets.map((ticket) => ticket.itemId)).size === tickets.length,
      '同一商品不能重复选择工单',
    );
    const versions = new Map(entries.map((entry) => [entry.id, entry.version]));
    // 与其他订单批量写入一致，按商品ID锁定，避免跨页勾选顺序造成死锁。
    tickets.sort((a, b) => a.itemId - b.itemId || a.id - b.id);
    for (const ticket of tickets) {
      await applyInTransaction(
        ticket.id,
        { version: versions.get(ticket.id), targetChannels: input.targetChannels },
        user,
        transaction,
        true,
      );
    }
    return { updated: tickets.length };
  });
}

async function applyInTransaction(id, input, user, transaction, strict = false) {
  const { ticket, item } = await lockedTicket(id, user, transaction);
  // 成功后的网络重试不重复写回，也不重新更新分配时间。
  assert(!strict || !ticket.appliedAt, '所选工单已确认变更，请刷新后重新选择', 409);
  if (ticket.appliedAt) return { id: ticket.id, itemId: item.id, appliedAt: ticket.appliedAt };
  checkVersion(ticket, input);
  assert(ticket.status === 'open', '工单已关闭，请先重新打开', 409);
  const purchase = await Purchase.findOne({
    where: { itemId: item.id },
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  assert(purchase, '采购记录不存在', 404);
  assert(
    sameChannels(purchase.purchaseChannel, ticket.beforeChannels),
    '订单采购渠道已变化，请关闭旧工单并按当前渠道重新申请',
    409,
  );
  const target = await targetChannels(input?.targetChannels, transaction);
  assert(!sameChannels(purchase.purchaseChannel, target), '目标采购渠道与当前渠道相同，无需变更');
  assert(purchase.allocatable === '是', '商品尚未审核或不可分配，请先将是否可分配设置为“是”');
  const executedBefore = purchase.toJSON();
  let patch = { purchaseChannel: target, purchaseStatus: null };
  if (ticket.targetPurchase) {
    assert(
      ticket.beforePurchase &&
        purchaseKeys.every((key) => sameFieldValue(key, purchase[key], ticket.beforePurchase[key])),
      '订单采购信息已变化，请关闭旧工单并按最新信息重新申请',
      409,
    );
    const requested = Object.fromEntries(
      purchaseKeys.map((key) => [key, ticket.targetPurchase[key]]),
    );
    const normalized = await purchaseRequest(requested, ticket.beforePurchase, transaction);
    // 只写申请实际变更的字段，不覆盖其他采购数据；历史停用值未修改时保留。
    patch = {
      ...patch,
      ...Object.fromEntries(
        purchaseKeys
          .filter((key) => !sameFieldValue(key, purchase[key], normalized[key]))
          .map((key) => [key, normalized[key]]),
      ),
    };
    Object.assign(patch, await purchaseCostPatch(purchase, patch, transaction));
    Object.assign(
      patch,
      derivePurchaseFields({
        orderAmount: item.orderAmount,
        tax: item.tax,
        purchaseLinkAmount: normalized.purchaseLinkAmount,
      }),
    );
  }
  await purchase.update(procurementStatePatch(purchase, purchaseTimerPatch(purchase, patch)), {
    transaction,
  });
  await item.update(
    { purchaseChannelKey: channelKey(target), version: item.version + 1 },
    { transaction },
  );
  const now = new Date();
  await ticket.update(
    {
      targetChannels: target,
      executedBefore,
      executedAfter: purchase.toJSON(),
      appliedAt: now,
      appliedBy: user.id,
      appliedByName: user.displayName,
      lastActivityAt: now,
      version: ticket.version + 1,
    },
    { transaction },
  );
  await addRecord(
    ticket,
    user,
    {
      kind: 'applied',
      content: `确认采购渠道变更：${ticket.beforeChannels.join(' / ') || '未分配'} → ${target.join(' / ')}`,
      images: [],
      requestId: randomUUID(),
    },
    transaction,
  );
  return { id: ticket.id, itemId: item.id, appliedAt: ticket.appliedAt };
}

// 仅订单列表/详情批量补标记，不加入主查询JOIN，不影响分页、计数和导出。
export async function enrichChannelChangeTickets(items) {
  if (!items.length) return items;
  const chosen = await Ticket.findAll({
    where: { itemId: { [Op.in]: items.map((item) => item.id) } },
    attributes: [
      'itemId',
      [
        fn(
          'COALESCE',
          fn('MAX', literal("CASE WHEN status = 'open' THEN id END")),
          fn('MAX', col('id')),
        ),
        'id',
      ],
    ],
    group: ['itemId'],
    raw: true,
  });
  const tickets = chosen.length
    ? await Ticket.findAll({
        where: { id: { [Op.in]: chosen.map((r) => r.id) } },
        attributes: ['id', 'itemId', 'status', 'appliedAt'],
        raw: true,
      })
    : [];
  const byItem = new Map(tickets.map((r) => [r.itemId, r]));
  for (const item of items) item.setDataValue('channelChangeTicket', byItem.get(item.id) || null);
  return items;
}
