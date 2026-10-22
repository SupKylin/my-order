import { Op, fn, col, literal, where as sqlWhere } from 'sequelize';
import { db, Order, OrderItem, Purchase, AuditLog, itemInclude, serializeItem } from '../models.js';
import { fields } from '../fields.js';
import { addressKey } from '../lib/address-key.js';
import { AppError, assert } from '../errors.js';
import { validatePatch, normalizeValue } from '../validation.js';
import { getFieldDefinitions } from './dictionaries.js';
import { channelKey, orderIdentityKey } from '../lib/order-identity.js';
import { priceFactorPatterns } from '../lib/price-factor.js';
import { filterValues } from '../lib/filter-values.js';
import { shippingWindow } from '../lib/shipping-window.js';
import { assertOrderEditable } from '../lib/order-write-policy.js';
import { orderScope, assertItemAccess } from '../permissions.js';
import { procurementStatePatch } from '../lib/procurement-state.js';
import { sameFieldValue } from '../lib/order-concurrency.js';
import { purchaseAssignmentSummary } from './purchase-assignment-summary.js';
import {
  purchaseTimerPatch,
  PURCHASE_SUCCESS_PATTERN,
  PURCHASE_UNTRACKED_PATTERN,
} from '../lib/purchase-timer.js';
/** 返回前端使用的商品明细快照，不向前端泄露模型关联结构。 */
export async function getItem(id, user) {
  const item = await OrderItem.findByPk(id, { include: itemInclude });
  assert(item, '商品明细不存在', 404);
  await assertItemAccess(item, user);
  return serializeItem(item);
}

/** 人工新增不允许覆盖已有业务键；冲突时整笔事务回滚。 */
export async function createItem(input, actor) {
  // 保留旧实现供历史参考，业务入口永久拒绝人工新增。
  throw new AppError(403, '手工新增订单已关闭，订单只能从 Walmart 官方接口拉取');
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
export async function upsertImported(patch, transaction, actor, target = undefined, options = {}) {
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
    const itemPatch = { ...parts.item, ...identity };
    const changed = Object.entries(itemPatch).some(
      ([key, value]) => !sameFieldValue(key, existing[key], value),
    );
    // 官方重复拉取相同业务值时不增加版本；有实际变化仍保护旧客户端。
    if (!options.walmartSync || changed)
      await existing.update({ ...itemPatch, version: existing.version + 1 }, { transaction });
    const procurement = await Purchase.findOne({
      where: { itemId: existing.id },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const purchasePatch = procurementStatePatch(
      procurement,
      purchaseTimerPatch(procurement, parts.purchase),
    );
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
      // 只在首次创建订单时初始化；历史空值、人工修改或清空均不由后续同步覆盖。
      purchaseQuantity: item.quantity ?? null,
      ...procurementStatePatch(null, purchaseTimerPatch(null, parts.purchase)),
      assignedTo: actor.id,
      assignedAt: new Date(),
    },
    { transaction },
  );
  return { created: true, id: item.id };
}
export function buildFilters(query, now = Date.now(), user) {
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
  for (const [key, target, label] of [
    ['orderStatus', where, '运营订单状态'],
    ['purchaseStatus', purchaseWhere, '采购状态'],
  ]) {
    const values = filterValues(query[key], `${label}筛选格式无效`);
    if (values.length) target[key] = values.length === 1 ? values[0] : { [Op.in]: values };
  }
  if (query.platformOrderStatus) where.platformOrderStatus = String(query.platformOrderStatus);
  if (query.fulfillmentParty) {
    const party = String(query.fulfillmentParty).trim().toUpperCase();
    const values = party === 'WFS' || party === 'WFSFULFILLED' ? ['WFS', 'WFSFULFILLED'] : [party];
    where[Op.and] = [
      sqlWhere(fn('UPPER', fn('TRIM', col('OrderItem.fulfillmentParty'))), { [Op.in]: values }),
    ];
  }
  for (const key of ['settlement', 'allocatable', 'afterSales', 'shippingMode'])
    if (query[key]) purchaseWhere[key] = String(query[key]);
  if (query.cancellationIntent !== undefined && query.cancellationIntent !== '') {
    assert(['requested', 'not_requested'].includes(query.cancellationIntent), '取消申请筛选无效');
    // 与红色提示一致：已确认且有取消意向。反向筛选包含其他状态和空状态。
    const intent = fn(
      'COALESCE',
      // 固定 JSON 路径避免 Sequelize fn 将 $ 转义为 $$；不拼接用户输入。
      fn(
        'JSON_UNQUOTE',
        fn('JSON_EXTRACT', col('OrderItem.walmart'), literal("'$.intentToCancel'")),
      ),
      'false',
    );
    where[Op.and] = [
      ...(where[Op.and] || []),
      query.cancellationIntent === 'requested'
        ? { [Op.and]: [{ platformOrderStatus: '已确认' }, sqlWhere(intent, Op.eq, 'true')] }
        : {
            [Op.or]: [
              { platformOrderStatus: { [Op.ne]: '已确认' } },
              { platformOrderStatus: null },
              sqlWhere(intent, Op.ne, 'true'),
            ],
          },
    ];
  }
  // GET 使用 JSON 数组，导出 POST 使用原数组；多个平台按“任一匹配”查询。
  if (query.purchasePlatforms) {
    let platforms = query.purchasePlatforms;
    if (typeof platforms === 'string') {
      try {
        platforms = JSON.parse(platforms);
      } catch {
        throw new AppError(400, '采购平台筛选格式无效');
      }
    }
    assert(
      Array.isArray(platforms) &&
        platforms.length <= 200 &&
        platforms.every(
          (value) => typeof value === 'string' && value.trim() && value.length <= 255,
        ),
      '采购平台筛选格式无效',
    );
    if (platforms.length) purchaseWhere.purchasePlatform = { [Op.in]: [...new Set(platforms)] };
  }
  // “未分配”是空值筛选入口，不向业务字段写入第三种状态。
  if (query.allocatable === 'empty') purchaseWhere.allocatable = { [Op.or]: [null, ''] };
  for (const [key, options] of Object.entries({
    reviewStatus: ['已审核', '不可分配'],
    supplierAssignmentStatus: ['已分配', '不可分配'],
  })) {
    if (!query[key]) continue;
    assert(query[key] === 'empty' || options.includes(query[key]), '审核或供应商分配状态筛选无效');
    purchaseWhere[key] = query[key] === 'empty' ? { [Op.or]: [null, ''] } : query[key];
  }
  const channelConditions = [];
  if (query.purchaseChannelEmpty === 'true' || query.purchaseChannelEmpty === true) {
    // 同时兼容未填写、历史单选空文本，以及多选序列化后的空数组。
    channelConditions.push(
      { purchaseChannel: null },
      sqlWhere(fn('TRIM', col('purchase.purchaseChannel')), { [Op.in]: ['', '[]', 'null', '""'] }),
    );
  }
  for (const channel of filterValues(query.purchaseChannel, '采购渠道筛选格式无效')) {
    const channelColumn = col('purchase.purchaseChannel');
    // 旧单选文本和新数组均支持按其中一个渠道筛选；查询值由 Sequelize 转义。
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
  }
  if (channelConditions.length) purchaseWhere[Op.or] = channelConditions;
  const factorLevels = filterValues(query.priceFactorLevel, '价格系数等级筛选无效', [
    'low',
    'medium',
    'high',
  ]);
  if (factorLevels.length) {
    const factor = col('purchase.priceFactor');
    const groups = factorLevels.map((level) => {
      const conditions = [sqlWhere(factor, { [Op.regexp]: priceFactorPatterns.numeric })];
      for (const grade of ['high', 'medium']) {
        if (level === grade || level === 'low')
          conditions.push(
            sqlWhere(factor, {
              [level === grade ? Op.regexp : Op.notRegexp]: priceFactorPatterns[grade],
            }),
          );
      }
      return { [Op.and]: conditions };
    });
    // 和渠道等条件取交集；必须在分页与总数统计前筛选。
    where[Op.and] = [...(where[Op.and] || []), { [Op.or]: groups }];
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
  if (query.storeOwnerId === 'unbound') where['$store.ownerId$'] = null;
  else if (query.storeOwnerId) {
    const ownerId = Number(query.storeOwnerId);
    assert(Number.isSafeInteger(ownerId) && ownerId > 0, '店铺所属账号筛选无效');
    where['$store.ownerId$'] = ownerId;
  }
  if (query.startDate || query.endDate) {
    where.orderDate = {};
    if (query.startDate) where.orderDate[Op.gte] = query.startDate;
    if (query.endDate) where.orderDate[Op.lte] = query.endDate;
  }
  if (query.purchaseAssignedStartTime || query.purchaseAssignedEndTime) {
    const range = {};
    for (const [key, operator] of [
      ['purchaseAssignedStartTime', Op.gte],
      ['purchaseAssignedEndTime', Op.lte],
    ]) {
      if (!query[key]) continue;
      try {
        const value = query[key];
        assert(
          typeof value === 'string' &&
            /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) &&
            normalizeValue({ type: 'datetime' }, value) === value,
          '时间格式无效',
        );
        // 输入与列表均为北京时间，结束秒包含该秒全部毫秒。
        range[operator] = new Date(value.replace(' ', 'T') + '+08:00');
        if (operator === Op.lte) range[operator].setMilliseconds(999);
      } catch {
        throw new AppError(400, '采购分配时间筛选格式无效，请使用北京时间 YYYY-MM-DD HH:mm:ss');
      }
    }
    assert(
      !range[Op.gte] || !range[Op.lte] || range[Op.gte] <= range[Op.lte],
      '采购分配开始时间不能晚于结束时间',
    );
    purchaseWhere.purchaseAssignedAt = range;
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
  const trackingLevels = filterValues(query.trackingWarning, '未出跟踪号筛选无效', [
    'all',
    'waiting',
    'yellow',
    'red',
  ]);
  if (trackingLevels.length) {
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
    if (!trackingLevels.includes('all')) {
      const selectedRanges = trackingLevels.map((level) => ({
        '$purchase.purchaseConfirmedAt$': ranges[level],
      }));
      conditions.push(
        selectedRanges.length === 1 ? selectedRanges[0] : { [Op.or]: selectedRanges },
      );
    }
    where[Op.and] = [...(where[Op.and] || []), ...conditions];
  }
  const include = [
    itemInclude[0],
    { ...itemInclude[1], where: purchaseWhere, required: true },
    ...itemInclude.slice(2),
  ];
  where[Op.and] = [...(where[Op.and] || []), orderScope(user)];
  return { where, include };
}
export async function listOrders(query, user) {
  const page = Math.max(1, Number(query.page) || 1),
    pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20));
  // 单次查询使用同一时间点，避免跨截止时间时分页与统计条件不同。
  const now = Date.now();
  const filters = buildFilters(query, now, user);
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
    purchaseAssignmentSummary: await purchaseAssignmentSummary(user, now),
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
    await assertItemAccess(item, user, t);
    assertOrderEditable(item);
    const hasBase = Object.hasOwn(input, 'baseFields');
    if (hasBase)
      assert(
        input.baseFields &&
          typeof input.baseFields === 'object' &&
          !Array.isArray(input.baseFields),
        '原始字段快照格式错误',
      );
    if (!hasBase && item.version !== input.version)
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
      requireKeys: !hasBase,
      fieldDefinitions: editableDefinitions,
    });
    const currentOrder = await Order.findByPk(item.orderId, { transaction: t });
    if (hasBase) {
      const conflicts = [];
      for (const key of Object.keys(patch)) {
        assert(Object.hasOwn(input.baseFields, key), `缺少字段原值：${key}`);
        const field = definitions.find((entry) => entry.key === key);
        const current =
          key === 'orderNumber'
            ? currentOrder.orderNumber
            : field.group === 'purchase'
              ? currentPurchase?.[key]
              : item[key];
        if (!sameFieldValue(key, current, input.baseFields[key]))
          conflicts.push({
            field: key,
            label: field.label,
            message: '已发生变化，请核对最新数据后再保存',
          });
      }
      if (conflicts.length)
        throw new AppError(409, '部分字段已发生变化，已保留本次填写内容', conflicts);
    }
    // 禁止通过改订单身份或履约方绕过“官方来源”和 WFS 只读规则。
    for (const key of ['orderNumber', 'shopName', 'fulfillmentParty']) {
      if (!Object.hasOwn(patch, key)) continue;
      const current = key === 'orderNumber' ? currentOrder.orderNumber : item[key];
      assert(patch[key] === (current ?? null), '订单号、店铺及履约方只能由 Walmart 同步更新', 403);
    }
    for (const field of definitions.filter((field) => field.group === 'product')) {
      if (!Object.hasOwn(patch, field.key)) continue;
      assert(
        patch[field.key] === (item[field.key] ?? null),
        '商品信息只能由 Walmart 同步更新，不能人工修改',
      );
      delete patch[field.key];
    }
    const [order] = await Order.findOrCreate({
      where: { orderNumber: patch.orderNumber ?? currentOrder.orderNumber },
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
    await purchase.update(
      procurementStatePatch(currentPurchase, purchaseTimerPatch(currentPurchase, parts.purchase)),
      { transaction: t },
    );
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
/** 多选渠道覆盖原值；批量分配要么全部成功，要么整批回滚。 */
export async function assignItems(input, user) {
  const entries = input?.items;
  assert(
    Array.isArray(entries) && entries.length > 0 && entries.length <= 500,
    '请选择 1 至 500 条商品明细',
  );
  assert(
    entries.every((x) => Number.isInteger(x?.id) && Number.isInteger(x?.version)),
    '分配参数错误',
  );
  assert(new Set(entries.map((x) => x.id)).size === entries.length, '商品明细不能重复');
  assert(
    Array.isArray(input.purchaseChannel) &&
      input.purchaseChannel.length > 0 &&
      input.purchaseChannel.every((value) => typeof value === 'string' && value.trim()),
    '请选择采购渠道',
  );
  await db.transaction(async (t) => {
    const { purchaseChannel } = validatePatch(
      { purchaseChannel: input.purchaseChannel },
      { fieldDefinitions: await getFieldDefinitions(t) },
    );
    const sorted = [...entries].sort((a, b) => a.id - b.id);
    for (const entry of sorted) {
      const item = await OrderItem.findByPk(entry.id, { transaction: t, lock: t.LOCK.UPDATE });
      assert(item, '部分商品已不存在，请刷新', 404);
      await assertItemAccess(item, user, t);
      assertOrderEditable(item);
      assert(item.version === entry.version, '部分商品已更新，请刷新后重新分配', 409);
      const purchase = await Purchase.findOne({
        where: { itemId: item.id },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      assert(purchase, '采购记录不存在', 404);
      assert(
        purchase.allocatable === '是',
        `商品 ${item.walmartSku || item.id} 尚未审核或不可分配，请先将是否可分配设置为“是”`,
      );
      await purchase.update(procurementStatePatch(purchase, { purchaseChannel }), {
        transaction: t,
      });
      await item.update(
        { purchaseChannelKey: channelKey(purchaseChannel), version: item.version + 1 },
        { transaction: t },
      );
    }
    await AuditLog.create(
      {
        userId: user.id,
        action: 'assign_purchase_channels',
        details: { itemIds: entries.map((x) => x.id), purchaseChannel },
      },
      { transaction: t },
    );
  });
}

/** 批量状态更新与单条编辑共用字典校验，任一版本冲突则整批回滚。 */
export async function updateOrderStatus(input, user) {
  return updateBatchStatus(input, user, 'orderStatus', '运营订单状态');
}

export async function updatePurchaseStatus(input, user) {
  return updateBatchStatus(input, user, 'purchaseStatus', '采购状态');
}

async function updateBatchStatus(input, user, key, label) {
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
  assert(typeof input[key] === 'string' && input[key].trim(), `请选择${label}`);
  await db.transaction(async (transaction) => {
    const definitions = await getFieldDefinitions(transaction);
    const patch = validatePatch(
      { [key]: input[key] },
      { fieldDefinitions: definitions.filter((field) => field.key === key) },
    );
    const now = new Date();
    for (const entry of [...entries].sort((a, b) => a.id - b.id)) {
      const item = await OrderItem.findByPk(entry.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      assert(item, '部分商品已不存在，请刷新', 404);
      await assertItemAccess(item, user, transaction);
      assertOrderEditable(item);
      assert(item.version === entry.version, '部分商品已更新，请刷新后重试', 409);
      if (key === 'purchaseStatus') {
        const purchase = await Purchase.findOne({
          where: { itemId: item.id },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        assert(purchase, '采购记录不存在', 404);
        await purchase.update(purchaseTimerPatch(purchase, patch, { now }), { transaction });
        await item.update({ version: item.version + 1 }, { transaction });
      } else {
        await item.update({ ...patch, version: item.version + 1 }, { transaction });
      }
    }
    await AuditLog.create(
      {
        userId: user.id,
        action:
          key === 'purchaseStatus' ? 'batch_update_purchase_status' : 'batch_update_order_status',
        details: { itemIds: entries.map((entry) => entry.id), ...patch },
      },
      { transaction },
    );
  });
  return { updated: entries.length };
}
