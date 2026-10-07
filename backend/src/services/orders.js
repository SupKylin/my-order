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
import { AppError, assert } from '../errors.js';
import { validatePatch, normalizeValue } from '../validation.js';
import { getFieldDefinitions } from './dictionaries.js';
import { channelKey } from '../lib/order-identity.js';
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
    assert(created.created, '订单号＋采购渠道已存在，请编辑已有记录', 409);
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
  const existing =
    target === undefined
      ? await OrderItem.findOne({
          where: { orderId: order.id, purchaseChannelKey },
          order: [['id', 'ASC']],
          transaction,
          lock: transaction.LOCK.UPDATE,
        })
      : target;
  const parts = splitPatch(patch);
  if (existing) {
    // 空渠道旧明细被补全后同步匹配键，后续导入才能按新渠道继续更新同一条。
    const identity = Object.hasOwn(patch, 'purchaseChannel') ? { purchaseChannelKey } : {};
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
    { ...parts.item, orderId: order.id, purchaseChannelKey },
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
  if (query.q)
    where[Op.or] = [
      { productName: { [Op.like]: `%${String(query.q).slice(0, 100)}%` } },
      { sku: { [Op.like]: `%${String(query.q).slice(0, 100)}%` } },
      { '$order.orderNumber$': { [Op.like]: `%${String(query.q).slice(0, 100)}%` } },
      { '$purchase.trackingNumber$': { [Op.like]: `%${String(query.q).slice(0, 100)}%` } },
    ];
  for (const key of ['shopName', 'orderStatus']) if (query[key]) where[key] = String(query[key]);
  for (const key of ['purchaseStatus', 'settlement', 'allocatable', 'afterSales'])
    if (query[key]) purchaseWhere[key] = String(query[key]);
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
    // 和手填发货日期、价格等级等条件取交集，空发货日期不匹配。
    where[Op.and] = [...(where[Op.and] || []), { platformShipDate: dates }];
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
  const include = [itemInclude[0], { ...itemInclude[1], where: purchaseWhere, required: true }];
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
  // 沿用列表筛选条件，按发货日期聚合全部匹配明细，数量不受分页影响。
  const shippingDates = await OrderItem.findAll({
    where: { [Op.and]: [filters.where, { platformShipDate: { [Op.ne]: null } }] },
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
    const [order] = await Order.findOrCreate({
      where: { orderNumber: patch.orderNumber },
      transaction: t,
    });
    const parts = splitPatch(patch);
    const purchaseChannelKey = channelKey(
      Object.hasOwn(patch, 'purchaseChannel')
        ? patch.purchaseChannel
        : currentPurchase?.purchaseChannel,
    );
    await order.reload({ transaction: t, lock: t.LOCK.UPDATE });
    // 已有重复明细可单独编辑；人工改到另一个已有组合仍保持原来的冲突提示。
    if (item.orderId !== order.id || item.purchaseChannelKey !== purchaseChannelKey) {
      const conflict = await OrderItem.findOne({
        where: { orderId: order.id, purchaseChannelKey, id: { [Op.ne]: item.id } },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      assert(!conflict, '订单号＋采购渠道已存在，请编辑已有记录', 409);
    }
    await item.update(
      { ...parts.item, orderId: order.id, purchaseChannelKey, version: item.version + 1 },
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
          `商品 ${item.sku || item.id} 标记为不可分配，请先修改可分配状态`,
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
