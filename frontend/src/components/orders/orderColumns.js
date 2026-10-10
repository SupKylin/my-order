// 主表先展示订单信息，再展示采购信息；商品及收件字段仅在折叠区展示。
const orderKeys = [
  'shopName',
  'orderNumber',
  'orderDate',
  'platformShipDate',
  'platformTrackingNumber',
  'platformDeliveryDate',
  'actualDeliveryDate',
  'orderStatus',
  'platformOrderStatus',
  'fulfillmentParty',
  'orderAmount',
  'tax',
];
const purchaseKeys = [
  'purchaseSku',
  'purchaseStatus',
  'purchaseConfirmedAt',
  'purchasePlatform',
  'shippingMode',
  'merchantName',
  'purchaseLinkAmount',
  'purchaseAmount',
  'purchaseLimit',
  'priceFactor',
  'allocatable',
  'unallocatableReason',
  'supervisorConfirmed',
  'purchaseChannel',
  'purchaseScreenshot',
  'trackingNumber',
  'trackingScreenshot1',
  'trackingScreenshot2',
];
const labels = { purchaseStatus: '采购状态（刘贞填）', merchantName: '商家名' };
const widths = {
  shopName: 125,
  orderNumber: 220,
  platformShipDate: 155,
  platformTrackingNumber: 200,
  orderStatus: 210,
  platformOrderStatus: 145,
  purchaseStatus: 200,
  purchaseChannel: 190,
  trackingNumber: 200,
  purchaseLinkAmount: 160,
};
export function orderColumns(fields) {
  const byKey = new Map(fields.map((field) => [field.key, field]));
  // 服务端自动维护的只读列，不加入可编辑/可导入字段元数据。
  byKey.set('purchaseConfirmedAt', {
    key: 'purchaseConfirmedAt',
    label: '采购成功时间',
    group: 'purchase',
    type: 'datetime',
  });
  // 组内指定字段优先，其余字段沿用元数据顺序，新增字段也能自动归组。
  const groupColumns = (group, keys) => {
    const prioritized = new Set(keys);
    return [
      ...keys.map((key) => byKey.get(key)).filter(Boolean),
      ...fields.filter((field) => field.group === group && !prioritized.has(field.key)),
    ];
  };
  return [
    ...groupColumns('order', orderKeys),
    ...groupColumns('purchase', purchaseKeys),
    { key: 'storeOwner', label: '店铺所属账号', type: 'storeOwner' },
  ].map((field) => ({
    ...field,
    label: labels[field.key] || field.label,
    width:
      widths[field.key] ||
      { image: 140, textarea: 220, url: 230, datetime: 185, date: 135 }[field.type] ||
      145,
    fixed: ['shopName', 'orderNumber'].includes(field.key) ? 'left' : false,
  }));
}
