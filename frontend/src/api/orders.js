import { api } from './http';

export const orderApi = {
  list: (filters) =>
    api.get('/orders', {
      params: { ...filters, shopNames: JSON.stringify(filters.shopNames || []) },
    }),
  export: (filters, ids) =>
    api.post(
      '/orders/export',
      { filters, ...(ids.length ? { ids } : {}) },
      {
        responseType: 'blob',
        timeout: 10 * 60 * 1000,
        silent: true,
      },
    ),
  dashboard: () => api.get('/dashboard'),
  create: (fields) => api.post('/orders', { fields }),
  update: (id, fields, version) => api.put(`/orders/${id}`, { fields, version }),
  remove: (id, version) => api.delete(`/orders/${id}`, { data: { version } }),
  removeMany: (items) => api.post('/orders/batch-delete', { items }),
  updateStatus: (items, orderStatus) => api.post('/orders/batch-status', { items, orderStatus }),
  // 版本随明细一起提交，服务器拒绝覆盖其他人员刚刚做出的分配。
  assign: (items, assignedTo) => api.post('/assignments', { items, assignedTo }),
};
