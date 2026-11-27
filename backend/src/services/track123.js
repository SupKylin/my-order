import { config } from '../config.js';
import { AppError, assert } from '../errors.js';
import { getItem } from './orders.js';
import { Op, col, fn, where as sqlWhere } from 'sequelize';
import { Order, OrderItem, Purchase, Store } from '../models.js';

const baseUrl = 'https://api.track123.com/gateway/open-api/tk/v2.1/track';

const text = (value) => (typeof value === 'string' ? value.slice(0, 1000) : null);

export function publicShipment(shipment) {
  const logistics = shipment.localLogisticsInfo || {};
  return {
    trackNo: text(shipment.trackNo),
    transitStatus: text(shipment.transitStatus),
    lastTrackingTime: text(shipment.lastTrackingTime),
    localLogisticsInfo: {
      courierCode: text(logistics.courierCode),
      courierNameCN: text(logistics.courierNameCN),
      courierNameEN: text(logistics.courierNameEN),
      trackingDetails: Array.isArray(logistics.trackingDetails)
        ? logistics.trackingDetails.slice(0, 200).map((event) => ({
            eventTime: text(event.eventTime),
            eventDetail: text(event.eventDetail),
            address: text(event.address),
            transitSubStatus: text(event.transitSubStatus),
          }))
        : [],
    },
  };
}

export async function track123Request(
  path,
  body,
  { secret = config.track123.apiSecret, transport = fetch } = {},
) {
  assert(secret, '请先配置 Track123 API Key', 424);
  let response;
  try {
    response = await transport(`${baseUrl}/${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'Track123-Api-Secret': secret,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new AppError(502, 'Track123 暂时无法连接，请稍后重试');
  }
  if (!response.ok) throw new AppError(502, `Track123 请求失败（HTTP ${response.status}）`);
  let result;
  try {
    result = await response.json();
  } catch {
    throw new AppError(502, 'Track123 返回了无效数据');
  }
  if (!result || result.code !== '00000' || !result.data)
    throw new AppError(
      502,
      `Track123 请求未成功（${String(result?.code || '未知错误').slice(0, 32)}）`,
    );
  return result.data;
}

async function currentTrackNo(itemId, user) {
  const item = await getItem(itemId, user);
  const trackNo = String(item.trackingNumber || '').trim();
  assert(trackNo, '该商品明细尚未填写内部物流单号');
  assert(trackNo.length <= 255 && !/[\r\n]/.test(trackNo), '物流单号格式无效');
  return trackNo;
}

export async function getTracking(itemId, user, options) {
  const trackNo = await currentTrackNo(itemId, user);
  const data = await track123Request('query', { trackNoInfos: [{ trackNo }] }, options);
  const content = data.accepted?.content ?? [];
  assert(Array.isArray(content), 'Track123 查询结果格式无效', 502);
  return {
    trackNo,
    shipments: content.filter((shipment) => shipment?.trackNo === trackNo).map(publicShipment),
    rejected: (data.rejected || [])
      .filter((entry) => entry?.trackNo === trackNo)
      .map((entry) => ({ error: { code: text(entry.error?.code), msg: text(entry.error?.msg) } })),
  };
}

export async function registerTracking(itemId, user, options) {
  const trackNo = await currentTrackNo(itemId, user);
  const data = await track123Request('import', [{ trackNo }], options);
  assert(
    Array.isArray(data.accepted) && Array.isArray(data.rejected),
    'Track123 注册结果格式无效',
    502,
  );
  const accepted = data.accepted.some((entry) => entry?.trackNo === trackNo);
  const rejection = data.rejected.find((entry) => entry?.trackNo === trackNo);
  return {
    trackNo,
    accepted,
    rejection: rejection
      ? { code: text(rejection.error?.code), message: text(rejection.error?.msg) }
      : null,
  };
}

export async function listTrackingItems(query, user) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(query.pageSize) || 20));
  const q = String(query.q || '')
    .trim()
    .slice(0, 100);
  const where = {};
  if (q) {
    const search = `%${q}%`;
    where[Op.or] = [
      { '$purchase.trackingNumber$': { [Op.like]: search } },
      { '$order.orderNumber$': { [Op.like]: search } },
      { shopName: { [Op.like]: search } },
      { walmartSku: { [Op.like]: search } },
    ];
  }
  const include = [
    { model: Order, as: 'order', attributes: ['orderNumber'], required: true },
    {
      model: Purchase,
      as: 'purchase',
      attributes: ['trackingNumber'],
      required: true,
      where: {
        trackingNumber: { [Op.ne]: null },
        [Op.and]: sqlWhere(fn('TRIM', col('purchase.trackingNumber')), { [Op.ne]: '' }),
      },
    },
  ];
  if (user.role === 'operations')
    include.push({
      model: Store,
      as: 'store',
      attributes: [],
      required: true,
      where: { ownerId: user.id },
    });
  const result = await OrderItem.findAndCountAll({
    attributes: ['id', 'shopName', 'walmartSku', 'productName', 'orderDate'],
    where,
    include,
    limit: pageSize,
    offset: (page - 1) * pageSize,
    order: [
      ['orderDate', 'DESC'],
      ['id', 'DESC'],
    ],
    distinct: true,
    subQuery: false,
  });
  return {
    rows: result.rows.map((item) => ({
      id: item.id,
      orderNumber: item.order.orderNumber,
      shopName: item.shopName,
      walmartSku: item.walmartSku,
      productName: item.productName,
      orderDate: item.orderDate,
      trackingNumber: item.purchase.trackingNumber,
    })),
    total: result.count,
    page,
    pageSize,
  };
}
