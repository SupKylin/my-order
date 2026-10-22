import { api } from './http';

// 使用独立空值条件，避免“未分配”与用户自定义的渠道名称冲突。
const queryFilters = (filters) => {
  const channels = Array.isArray(filters.purchaseChannel)
    ? filters.purchaseChannel
    : filters.purchaseChannel
      ? [filters.purchaseChannel]
      : [];
  return {
    ...filters,
    purchaseChannel: channels.filter((value) => value !== true),
    purchaseChannelEmpty: channels.includes(true),
  };
};

export const orderApi = {
  list: (filters) =>
    api.get('/orders', {
      params: {
        ...queryFilters(filters),
        purchaseChannel: JSON.stringify(queryFilters(filters).purchaseChannel),
        ...Object.fromEntries(
          ['purchaseStatus', 'orderStatus', 'trackingWarning', 'priceFactorLevel'].map((key) => [
            key,
            Array.isArray(filters[key]) ? JSON.stringify(filters[key]) : filters[key],
          ]),
        ),
        shopNames: JSON.stringify(filters.shopNames || []),
        purchasePlatforms: JSON.stringify(filters.purchasePlatforms || []),
      },
    }),
  exportProgress: (id) => api.get(`/orders/export-progress/${id}`, { silent: true, timeout: 5000 }),
  export: (filters, purchaseTemplate = false, exportId) =>
    api.post(
      purchaseTemplate ? '/orders/export-purchases' : '/orders/export',
      { filters: queryFilters(filters), exportId },
      {
        responseType: 'blob',
        timeout: 10 * 60 * 1000,
        silent: true,
      },
    ),
  dashboard: () => api.get('/dashboard'),
  create: (fields) => api.post('/orders', { fields }),
  update: (id, fields, version, baseFields) =>
    api.put(`/orders/${id}`, { fields, version, ...(baseFields ? { baseFields } : {}) }),
  remove: (id, version) => api.delete(`/orders/${id}`, { data: { version } }),
  removeMany: (items) => api.post('/orders/batch-delete', { items }),
  updateStatus: (items, orderStatus) => api.post('/orders/batch-status', { items, orderStatus }),
  updatePurchaseStatus: (items, purchaseStatus) =>
    api.post('/orders/batch-purchase-status', { items, purchaseStatus }),
  // 版本随明细一起提交，服务器拒绝覆盖其他人员刚刚做出的分配。
  assign: (items, purchaseChannel) => api.post('/assignments', { items, purchaseChannel }),
};
