import { Op, fn, col, where as sqlWhere } from 'sequelize';
import {
  db,
  Order,
  OrderItem,
  Purchase,
  User,
  AuditLog,
  itemInclude,
  serializeItem,
} from '../models.js';
import { fields } from '../fields.js';
import { addressKey } from '../lib/address-key.js';
import { AppError, assert } from '../errors.js';
import { validatePatch, normalizeValue } from '../validation.js';
import { getFieldDefinitions } from './dictionaries.js';
import { channelKey, orderIdentityKey } from '../lib/order-identity.js';
import { priceFactorPatterns } from '../lib/price-factor.js';
import { shippingWindow } from '../lib/shipping-window.js';
import {
  purchaseTimerPatch,
  PURCHASE_SUCCESS_PATTERN,
  PURCHASE_UNTRACKED_PATTERN,
} from '../lib/purchase-timer.js';
/** 返回前端使用的商品明细快照，不向前端泄露模型关联结构。 */
export async function getItem(id) {
  const item = await OrderItem.findByPk(id, { include: itemInclude });
  assert(item, '商品明细不存在', 404);
  return serializeItem(item);
}

/** 人工新增不允许覆盖已有业务键；冲突时整笔事务回滚。 */
export async function createItem(input, actor) {
  const patch = validatePatch(input.fields, {
    requireKeys: true,
    fieldDefinitions: await getFieldDefinitions(),
  });
  const result = await db.transaction(async (transaction) => {
    const created = await upsertImported(patch, transaction, actor);
    assert(created.created, '店铺名＋订单号＋WalmartSku 已存在，请编辑已有记录', 409);
    await AuditLog.create(
      { userId: actor.id, action: 'create_item', entityId: String(created.id) },
      { transaction },
    );
    return created;
  });
  return getItem(result.id);
}

/** 仅分发本次实际提供的字段，不能用空默认对象覆盖已有采购信息。 */
export function splitPatch(patch) {
  const item = {},
    purchase = {};
  for (const f of fields)
    if (f.key !== 'orderNumber' && Object.hasOwn(patch, f.key))
      (f.group === 'purchase' ? purchase : item)[f.key] = patch[f.key];
  return { item, purchase };
}
/** target 为预览锁定的明细，null 表示新增；未传时保留人工新增的重复检查。 */
export async function upsertImported(patch, transaction, actor, target = undefined) {
  const [order] = await Order.findOrCreate({
    where: { orderNumber: patch.orderNumber },
    transaction,
  });
  // 同订单的新增串行化，重复导入依赖明细 ID 的创建顺序。
  await order.reload({ transaction, lock: transaction.LOCK.UPDATE });
  const purchaseChannelKey = channelKey(patch.purchaseChannel);
  const identityKey = orderIdentityKey(patch);
  const existing =
    target === undefined
      ? await OrderItem.findOne({
          where: { orderId: order.id, orderIdentityKey: identityKey },
          order: [['id', 'ASC']],
          transaction,
          lock: transaction.LOCK.UPDATE,
        })
      : target;
  const parts = splitPatch(patch);
  parts.item.addressKey = addressKey({ ...existing?.toJSON(), ...parts.item });
  if (Object.hasOwn(parts.item, 'walmartSku')) parts.item.sku = parts.item.walmartSku;
  if (existing) {
    const identity = {
      orderIdentityKey: orderIdentityKey({ ...existing.toJSON(), ...parts.item }),
      ...(Object.hasOwn(patch, 'purchaseChannel') ? { purchaseChannelKey } : {}),
    };
    await existing.update(
      { ...parts.item, ...identity, version: existing.version + 1 },
      { transaction },
    );
    const procurement = await Purchase.findOne({
      where: { itemId: existing.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const purchasePatch = purchaseTimerPatch(procurement, parts.purchase);
    if (procurement) await procurement.update(purchasePatch, { transaction });
    else await Purchase.create({ itemId: existing.id, ...purchasePatch }, { transaction });
    return { created: false, id: existing.id };
  }
  const item = await OrderItem.create(
    { ...parts.item, orderId: order.id, purchaseChannelKey, orderIdentityKey: identityKey },
    { transaction },
  );
  // 采购人员只取已认证的当前账号，不能由上传文件或客户端指定。
  await Purchase.create(
    {
      itemId: item.id,
      ...purchaseTimerPatch(null, parts.purchase),
      assignedTo: actor.id,
      assignedAt: new Date(),
    },
    { transaction },
  );
  return { created: true, id: item.id };
}
export function buildFilters(query, now = Date.now()) {
  const where = {},
    purchaseWhere = {};
  if (query.orderNumbers) {
    assert(typeof query.orderNumbers === 'string', '批量订单号格式无效');
    const numbers = [...new Set(query.orderNumbers.trim().split(/\s+/).filter(Boolean))];
    assert(
      numbers.length <= 200 && numbers.every((number) => number.length <= 191),
      '单次最多查询 200 个有效订单号',
    );
    if (numbers.length) where['$order.orderNumber$'] = { [Op.in]: numbers };
  }
  if (query.q)
    where[Op.or] = [
      { productName: { [Op.like]: `%${String(query.q).slice(0, 100)}%` } },
      { walmartSku: { [Op.like]: `%${String(query.q).slice(0, 100)}%` } },
      { '$purchase.purchaseSku$': { [Op.like]: `%${String(query.q).slice(0, 100)}%` } },
      { '$order.orderNumber$': { [Op.like]: `%${String(query.q).slice(0, 100)}%` } },
      { '$purchase.trackingNumber$': { [Op.like]: `%${String(query.q).slice(0, 100)}%` } },
    ];
  if (query.shopNames) {
    let names = query.shopNames;
    if (typeof names === 'string') {
      try {
        names = JSON.parse(names);
      } catch {
        throw new AppError(400, '店铺筛选格式无效');
      }
    }
    assert(
      Array.isArray(names) &&
        names.length <= 200 &&
        names.every((name) => typeof name === 'string' && name.length <= 191),
      '店铺筛选格式无效',
    );
    if (names.length) where.shopName = { [Op.in]: [...new Set(names)] };
  } else if (query.shopName) where.shopName = String(query.shopName);
  if (query.orderStatus) where.orderStatus = String(query.orderStatus);
  if (query.platformOrderStatus) where.platformOrderStatus = String(query.platformOrderStatus);
  for (const key of ['purchaseStatus', 'settlement', 'allocatable', 'afterSales'])
    if (query[key]) purchaseWhere[key] = String(query[key]);
  // “未分配”是空值筛选入口，不向业务字段写入第三种状态。
  if (query.allocatable === 'empty') purchaseWhere.allocatable = { [Op.or]: [null, ''] };
  if (query.purchaseChannel) {
    const channelColumn = col('purchase.purchaseChannel');
    // 旧单选文本和新数组均支持按其中一个渠道筛选；查询值由 Sequelize 转义。
    purchaseWhere[Op.and] = sqlWhere(
      fn(
        'JSON_CONTAINS',
        fn('IF', fn('JSON_VALID', channelColumn), channelColumn, fn('JSON_ARRAY', channelColumn)),
        JSON.stringify(String(query.purchaseChannel)),
      ),
      1,
    );
  }
  if (query.priceFactorLevel) {
    const level = query.priceFactorLevel;
    assert(['low', 'medium', 'high'].includes(level), '价格系数等级筛选无效');
    const factor = col('purchase.priceFactor');
    const conditions = [sqlWhere(factor, { [Op.regexp]: priceFactorPatterns.numeric })];
    for (const grade of ['high', 'medium']) {
      if (level === grade || level === 'low')
        conditions.push(
          sqlWhere(factor, {
            [level === grade ? Op.regexp : Op.notRegexp]: priceFactorPatterns[grade],
          }),
        );
    }
    // 和渠道等条件取交集；必须在分页与总数统计前筛选。
    where[Op.and] = conditions;
  }
  const priceFields = {
    purchaseLinkAmount: purchaseWhere,
    orderAmount: where,
    purchaseLimit: purchaseWhere,
  };
  const priceType = query.priceType || '';
  assert(!priceType || Object.hasOwn(priceFields, priceType), '价格类型筛选无效');
  const priceRange = {};
  for (const [key, operator] of [
    ['minPrice', Op.gte],
    ['maxPrice', Op.lte],
  ]) {
    if (query[key] === undefined || query[key] === '') continue;
    try {
      priceRange[operator] = normalizeValue({ type: 'money' }, query[key]);
      assert(priceRange[operator] !== null, '价格为空');
    } catch {
      throw new AppError(400, `${key === 'minPrice' ? '最低' : '最高'}价格格式无效`);
    }
  }
  if (Reflect.ownKeys(priceRange).length) {
    assert(priceType, '请选择价格类型');
    if (priceRange[Op.gte] && priceRange[Op.lte]) {
      const scaled = (value) => {
        const [whole, fraction = ''] = value.split('.');
        return BigInt(whole + fraction.padEnd(20, '0'));
      };
      assert(scaled(priceRange[Op.gte]) <= scaled(priceRange[Op.lte]), '最低价格不能高于最高价格');
    }
    priceFields[priceType][priceType] = priceRange;
  }
  if (query.assignedTo === 'unassigned') purchaseWhere.assignedTo = null;
  else if (query.assignedTo) purchaseWhere.assignedTo = Number(query.assignedTo);
  if (query.startDate || query.endDate) {
    where.orderDate = {};
    if (query.startDate) where.orderDate[Op.gte] = query.startDate;
    if (query.endDate) where.orderDate[Op.lte] = query.endDate;
  }
  if (query.shipStartDate || query.shipEndDate) {
    const dates = {};
    for (const key of ['shipStartDate', 'shipEndDate']) {
      if (!query[key]) continue;
      try {
        dates[key] = normalizeValue({ type: 'date' }, query[key]);
        assert(dates[key], '日期为空');
      } catch {
        throw new AppError(400, '平台发货日期筛选格式无效');
      }
    }
    assert(
      !dates.shipStartDate || !dates.shipEndDate || dates.shipStartDate <= dates.shipEndDate,
      '平台发货开始日期不能晚于结束日期',
    );
    // DATEONLY 两端包含，无需浏览器或服务器时区转换。
    where.platformShipDate = {};
    if (dates.shipStartDate) where.platformShipDate[Op.gte] = dates.shipStartDate;
    if (dates.shipEndDate) where.platformShipDate[Op.lte] = dates.shipEndDate;
  }
  if (query.shippingWarning) {
    assert(['orange', 'red'].includes(query.shippingWarning), '发货预警筛选无效');
    const { first, last } = shippingWindow(now);
    const dates =
      query.shippingWarning === 'red' ? { [Op.lt]: first } : { [Op.gte]: first, [Op.lte]: last };
    // 仅已确认的平台订单预警，并与日期、价格等筛选条件取交集。
    where[Op.and] = [
      ...(where[Op.and] || []),
      { platformShipDate: dates, platformOrderStatus: '已确认' },
    ];
  }
  if (query.trackingWarning) {
    assert(
      ['all', 'waiting', 'yellow', 'red'].includes(query.trackingWarning),
      '未出跟踪号筛选无效',
    );
    const conditions = [
      sqlWhere(col('purchase.purchaseStatus'), { [Op.regexp]: PURCHASE_SUCCESS_PATTERN }),
      {
        [Op.or]: [
          { '$purchase.purchaseConfirmedAt$': { [Op.ne]: null } },
          sqlWhere(col('purchase.purchaseStatus'), { [Op.regexp]: PURCHASE_UNTRACKED_PATTERN }),
        ],
      },
      {
        [Op.or]: [
          { '$purchase.trackingNumber$': null },
          sqlWhere(col('purchase.trackingNumber'), { [Op.regexp]: '^[[:space:]]*$' }),
        ],
      },
    ];
    const hour = 60 * 60 * 1000;
    const ranges = {
      waiting: { [Op.gt]: new Date(now - 24 * hour) },
      yellow: { [Op.gt]: new Date(now - 48 * hour), [Op.lte]: new Date(now - 24 * hour) },
      red: { [Op.lte]: new Date(now - 48 * hour) },
    };
    if (query.trackingWarning !== 'all')
      conditions.push({ '$purchase.purchaseConfirmedAt$': ranges[query.trackingWarning] });
    where[Op.and] = [...(where[Op.and] || []), ...conditions];
  }
  const include = [
    itemInclude[0],
    { ...itemInclude[1], where: purchaseWhere, required: true },
    ...itemInclude.slice(2),
  ];
  return { where, include };
}
export async function listOrders(query) {
  const page = Math.max(1, Number(query.page) || 1),
    pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
  // 单次查询使用同一时间点，避免跨截止时间时分页与统计条件不同。
  const now = Date.now();
  const filters = buildFilters(query, now);
  const result = await OrderItem.findAndCountAll({
    ...filters,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    // MySQL 倒序时空日期排最后；同日按 ID 排序，避免分页顺序漂移。
    order: [
      ['orderDate', 'DESC'],
      ['id', 'DESC'],
    ],
    distinct: true,
    subQuery: false,
  });
  // 只统计已确认的明细，沿用列表筛选条件且不受分页影响。
  const shippingDates = await OrderItem.findAll({
    where: {
      [Op.and]: [
        filters.where,
        { platformShipDate: { [Op.ne]: null }, platformOrderStatus: '已确认' },
      ],
    },
    include: filters.include.map((relation) => ({ ...relation, attributes: [], include: [] })),
    attributes: ['platformShipDate', [fn('COUNT', col('OrderItem.id')), 'count']],
    group: [col('OrderItem.platformShipDate')],
    raw: true,
  });
  return {
    serverNow: new Date().toISOString(),
    rows: result.rows.map(serializeItem),
    total: result.count,
    page,
    pageSize,
    shippingDates: shippingDates.map(({ platformShipDate, count }) => ({
      date: platformShipDate,
      count: Number(count),
    })),
  };
}
/** 人工编辑允许显式清空字段，与导入时跳过空白的策略不同。 */
export async function editItem(id, input, user) {
  assert(Number.isInteger(input.version), '缺少数据版本，请刷新后重试');
  await db.transaction(async (t) => {
    const item = await OrderItem.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    assert(item, '记录不存在', 404);
    if (item.version !== input.version)
      throw new AppError(409, '该商品已被其他人修改，请刷新后再编辑');
    const currentPurchase = await Purchase.findOne({ where: { itemId: item.id }, transaction: t });
    const definitions = await getFieldDefinitions(t);
    // 字典改名或停用后，允许原记录原样保留旧值，但不能向其他记录新填旧值。
    const editableDefinitions = definitions.map((field) => {
      const previous = field.group === 'purchase' ? currentPurchase?.[field.key] : item[field.key];
      if (field.type === 'multiselect' && Array.isArray(previous))
        return { ...field, options: [...new Set([...field.options, ...previous])] };
      return field.type === 'select' && previous && input.fields?.[field.key] === previous
        ? { ...field, options: [...field.options, previous] }
        : field;
    });
    const patch = validatePatch(input.fields, {
      requireKeys: true,
      fieldDefinitions: editableDefinitions,
    });
    for (const field of definitions.filter((field) => field.group === 'product')) {
      if (!Object.hasOwn(patch, field.key)) continue;
      assert(
        patch[field.key] === (item[field.key] ?? null),
        '商品信息只能由 Walmart 同步更新，不能人工修改',
      );
      delete patch[field.key];
    }
    const [order] = await Order.findOrCreate({
      where: { orderNumber: patch.orderNumber },
      transaction: t,
    });
    const parts = splitPatch(patch);
    parts.item.addressKey = addressKey({ ...item.toJSON(), ...parts.item });
    if (Object.hasOwn(parts.item, 'walmartSku')) parts.item.sku = parts.item.walmartSku;
    const purchaseChannelKey = channelKey(
      Object.hasOwn(patch, 'purchaseChannel')
        ? patch.purchaseChannel
        : currentPurchase?.purchaseChannel,
    );
    await order.reload({ transaction: t, lock: t.LOCK.UPDATE });
    const identityKey = orderIdentityKey({ ...item.toJSON(), ...parts.item });
    // 已有重复明细可单独编辑；人工改到另一个已有组合仍保持原来的冲突提示。
    if (item.orderId !== order.id || orderIdentityKey(item) !== identityKey) {
      const conflict = await OrderItem.findOne({
        where: { orderId: order.id, orderIdentityKey: identityKey, id: { [Op.ne]: item.id } },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      assert(!conflict, '店铺名＋订单号＋WalmartSku 已存在，请编辑已有记录', 409);
    }
    await item.update(
      {
        ...parts.item,
        orderId: order.id,
        purchaseChannelKey,
        orderIdentityKey: identityKey,
        version: item.version + 1,
      },
      { transaction: t },
    );
    const [purchase] = await Purchase.findOrCreate({
      where: { itemId: item.id },
      defaults: parts.purchase,
      transaction: t,
    });
    await purchase.update(purchaseTimerPatch(currentPurchase, parts.purchase), { transaction: t });
    await AuditLog.create(
      {
        userId: user.id,
        action: 'edit_item',
        entityId: String(id),
        details: { fields: Object.keys(patch) },
      },
      { transaction: t },
    );
  });
  return serializeItem(await OrderItem.findByPk(id, { include: itemInclude }));
}
/** 一个商品只有一个当前采购人员；批量分配要么全部成功，要么回滚。 */
export async function assignItems(input, user) {
  const entries = input.items;
  assert(
    Array.isArray(entries) && entries.length > 0 && entries.length <= 500,
    '请选择 1 至 500 条商品明细',
  );
  assert(
    entries.every((x) => Number.isInteger(x.id) && Number.isInteger(x.version)),
    '分配参数错误',
  );
  assert(new Set(entries.map((x) => x.id)).size === entries.length, '商品明细不能重复');
  const assignee = input.assignedTo == null ? null : await User.findByPk(Number(input.assignedTo));
  if (input.assignedTo != null) assert(assignee?.active, '采购人员不存在或已停用');
  await db.transaction(async (t) => {
    const sorted = [...entries].sort((a, b) => a.id - b.id);
    for (const entry of sorted) {
      const item = await OrderItem.findByPk(entry.id, { transaction: t, lock: t.LOCK.UPDATE });
      assert(item, '部分商品已不存在，请刷新', 404);
      assert(item.version === entry.version, '部分商品已更新，请刷新后重新分配', 409);
      const purchase = await Purchase.findOne({
        where: { itemId: item.id },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      assert(purchase, '采购记录不存在', 404);
      if (assignee)
        assert(
          purchase.allocatable !== '否',
          `商品 ${item.walmartSku || item.id} 标记为不可分配，请先修改可分配状态`,
        );
      await purchase.update(
        { assignedTo: assignee?.id || null, assignedAt: assignee ? new Date() : null },
        { transaction: t },
      );
      await item.update({ version: item.version + 1 }, { transaction: t });
    }
    await AuditLog.create(
      {
        userId: user.id,
        action: 'assign_items',
        details: { itemIds: entries.map((x) => x.id), assignedTo: assignee?.id || null },
      },
      { transaction: t },
    );
  });
}

/** 批量状态更新与单条编辑共用字典校验，任一版本冲突则整批回滚。 */
export async function updateOrderStatus(input, user) {
  const entries = input?.items;
  assert(
    Array.isArray(entries) && entries.length > 0 && entries.length <= 500,
    '请选择 1 至 500 条商品明细',
  );
  assert(
    entries.every((entry) => Number.isInteger(entry?.id) && Number.isInteger(entry?.version)),
    '商品明细参数错误',
  );
  assert(new Set(entries.map((entry) => entry.id)).size === entries.length, '商品明细不能重复');
  assert(typeof input.orderStatus === 'string' && input.orderStatus.trim(), '请选择运营订单状态');
  await db.transaction(async (transaction) => {
    const definitions = await getFieldDefinitions(transaction);
    const { orderStatus } = validatePatch(
      { orderStatus: input.orderStatus },
      { fieldDefinitions: definitions.filter((field) => field.key === 'orderStatus') },
    );
    for (const entry of [...entries].sort((a, b) => a.id - b.id)) {
      const item = await OrderItem.findByPk(entry.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      assert(item, '部分商品已不存在，请刷新', 404);
      assert(item.version === entry.version, '部分商品已更新，请刷新后重试', 409);
      await item.update({ orderStatus, version: item.version + 1 }, { transaction });
    }
    await AuditLog.create(
      {
        userId: user.id,
        action: 'batch_update_order_status',
        details: { itemIds: entries.map((entry) => entry.id), orderStatus },
      },
      { transaction },
    );
  });
  return { updated: entries.length };
}
