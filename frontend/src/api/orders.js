import { api } from './http';

export const orderApi = {
  list: (filters) => api.get('/orders', { params: filters }),
  dashboard: () => api.get('/dashboard'),
  create: (fields) => api.post('/orders', { fields }),
  update: (id, fields, version) => api.put(`/orders/${id}`, { fields, version }),
  remove: (id, version) => api.delete(`/orders/${id}`, { data: { version } }),
  removeMany: (items) => api.post('/orders/batch-delete', { items }),
  // 版本随明细一起提交，服务器拒绝覆盖其他人员刚刚做出的分配。
  assign: (items, assignedTo) => api.post('/assignments', { items, assignedTo }),
};
