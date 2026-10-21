import { createHash } from 'node:crypto';
import { assert } from '../../errors.js';
import { walmartImage } from '../../lib/product-image.js';
import { hasCancellationIntent } from '../../lib/cancellation-intent.js';

export const lineStatuses = (line) =>
  (line.orderLineStatuses?.orderLineStatus ?? []).map((entry) => entry.status);
export const orderLines = (order) => order.orderLines?.orderLine ?? [];

const statusLabels = {
  Created: '待确认',
  Acknowledged: '已确认',
  Shipped: '已发货',
  Cancelled: '已取消',
  Delivered: '已送达',
};

export function platformStatusText(statuses = []) {
  return [...new Set(statuses)].map((status) => statusLabels[status] ?? status).join(', ');
}

/** 按接口属性顺序拼接属性值，不从标题或 SKU 推断颜色、款式等规格。 */
export function specificationText(attributes = []) {
  return attributes
    .filter(
      (attribute) =>
        attribute.value !== null && attribute.value !== undefined && attribute.value !== '',
    )
    .map((attribute) =>
      typeof attribute.value === 'object'
        ? JSON.stringify(attribute.value)
        : String(attribute.value),
    )
    .join(', ');
}

/** 美西标准时间固定 UTC-8；原始毫秒时间另存，绝不拼装平台截止时间。 */
export function platformDate(value) {
  if (value === null || value === undefined) return undefined;
  const millis = Number(value);
  assert(Number.isFinite(millis), 'Walmart 返回了无效时间戳');
  return new Date(millis - 8 * 3600000).toISOString().slice(0, 10);
}

export function sourceKey(systemStoreName, order, line) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        [systemStoreName, order.customerOrderId, line.item.sku].map((value) =>
          String(value ?? '').trim(),
        ),
      ),
    )
    .digest('hex');
}

/** 整单确认接口不能用于混有已发货/取消商品行的订单，保留待人工核对提示。 */
export function acknowledgementDecision(order) {
  if (order.shipNode?.type !== 'SellerFulfilled')
    return { action: 'skip', reason: '非卖家自配送订单，不自动确认' };
  const lines = orderLines(order);
  const statuses = lines.flatMap(lineStatuses);
  if (!lines.length || lines.some((line) => !lineStatuses(line).length))
    return { action: 'review', reason: '平台商品行状态缺失，需核对' };
  if (!statuses.includes('Created')) return { action: 'skip', reason: '平台已无 Created 商品行' };
  if (!statuses.every((status) => status === 'Created'))
    return { action: 'review', reason: '商品行状态混合，跳过整单自动确认，请在 Walmart 核对' };
  return { action: 'acknowledge', reason: '' };
}

export function isActiveOrder(order) {
  const statuses = orderLines(order).flatMap(lineStatuses);
  return (
    !statuses.length || !statuses.every((status) => ['Delivered', 'Cancelled'].includes(status))
  );
}

/** 费用为 API 商品行金额，用十进制整数相加，不按商品数量再次乘算。 */
function sumAmounts(values) {
  if (!values.length) return undefined;
  const scale = 10n ** 20n;
  const total = values.reduce((sum, value) => {
    const text = String(value);
    assert(/^\d+(\.\d{1,20})?$/.test(text), 'Walmart 金额格式无效');
    const [whole, fraction = ''] = text.split('.');
    return sum + BigInt(whole) * scale + BigInt(fraction.padEnd(20, '0'));
  }, 0n);
  return `${total / scale}.${String(total % scale).padStart(20, '0')}`;
}

export function mapOrderLine(store, order, line, catalog) {
  assert(typeof order.purchaseOrderId === 'string' && order.purchaseOrderId, '缺少 Walmart PO 号');
  assert(
    typeof order.customerOrderId === 'string' && order.customerOrderId,
    '缺少 Walmart 客户订单号',
  );
  assert(typeof line.lineNumber === 'string' && line.lineNumber, '缺少 Walmart 商品行号');
  assert(typeof line.item?.sku === 'string' && line.item.sku, '缺少 Walmart SKU');
  const address = order.shippingInfo?.postalAddress ?? {};
  const charges = line.charges?.charge ?? [];
  assert(
    charges.every(
      (charge) => !charge.chargeAmount?.currency || charge.chargeAmount.currency === 'USD',
    ),
    '暂不支持非 USD 订单',
  );
  const fields = {
    orderNumber: order.customerOrderId,
    shopName: store.systemStoreName,
    walmartSku: line.item.sku,
    productName: line.item.productName,
    quantity: line.orderLineQuantity?.amount,
    orderDate: platformDate(order.orderDate),
    platformShipDate: platformDate(order.shippingInfo?.estimatedShipDate),
    platformDeliveryDate: platformDate(order.shippingInfo?.estimatedDeliveryDate),
    recipientName: address.name,
    address1: address.address1,
    address2: address.address2,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    phone: order.shippingInfo?.phone,
    platformOrderStatus: platformStatusText(lineStatuses(line)),
    fulfillmentParty: order.shipNode?.type,
    orderAmount: sumAmounts(
      charges
        .filter(
          (c) => ['PRODUCT', 'SHIPPING'].includes(c.chargeType) && c.chargeAmount?.amount != null,
        )
        .map((c) => c.chargeAmount.amount),
    ),
    tax: sumAmounts(
      charges.filter((c) => c.tax?.taxAmount?.amount != null).map((c) => c.tax.taxAmount.amount),
    ),
  };
  const tracking = (line.orderLineStatuses?.orderLineStatus ?? [])
    .map((s) => s.trackingInfo?.trackingNumber)
    .filter(Boolean);
  if (tracking.length) fields.platformTrackingNumber = [...new Set(tracking)].join(', ');
  // 成功查询但没有属性时清空旧规格；查询失败时不提供该字段，保留原值。
  const productSpecification = catalog?.item
    ? {
        productSpecification:
          specificationText(catalog.item.variantGroupInfo?.groupingAttributes ?? []) || null,
      }
    : {};
  return {
    fields: {
      ...Object.fromEntries(
        Object.entries(fields).filter(
          ([, value]) => value !== null && value !== undefined && value !== '',
        ),
      ),
      ...productSpecification,
      productImage: walmartImage(line.item.imageUrl),
      // 官方收件地址明确不含地址二时清除旧房号，避免风险匹配沿用过期地址。
      ...(order.shippingInfo?.postalAddress ? { address2: address.address2 || null } : {}),
    },
    walmart: {
      commercialMappingVersion: 1,
      storeId: store.id,
      purchaseOrderId: order.purchaseOrderId,
      lineNumber: line.lineNumber,
      statuses: lineStatuses(line),
      // 取消意向独立于实际状态，不能将 Acknowledged 擅自改为 Cancelled。
      intentToCancel: hasCancellationIntent(line.intentToCancel),
      orderDate: order.orderDate,
      estimatedShipDate: order.shippingInfo?.estimatedShipDate,
      estimatedDeliveryDate: order.shippingInfo?.estimatedDeliveryDate,
      imageUrl: walmartImage(line.item.imageUrl),
      variantGroupId: catalog?.item?.variantGroupId ?? null,
      attributes: catalog?.item?.variantGroupInfo?.groupingAttributes ?? [],
      variantFetchedAt: catalog?.fetchedAt ?? null,
      variantError: catalog?.error ?? null,
    },
  };
}
