import { api } from './http';

// 使用独立空值条件，避免“未分配”与用户自定义的渠道名称冲突。
const queryFilters = (filters) => ({
  ...filters,
  purchaseChannel: filters.purchaseChannel === true ? '' : filters.purchaseChannel,
  purchaseChannelEmpty: filters.purchaseChannel === true,
});

export const orderApi = {
  list: (filters) =>
    api.get('/orders', {
      params: {
        ...queryFilters(filters),
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
  // 版本随明细一起提交，服务器拒绝覆盖其他人员刚刚做出的分配。
  assign: (items, purchaseChannel) => api.post('/assignments', { items, purchaseChannel }),
};
