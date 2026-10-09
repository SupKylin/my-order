import { api } from './http';

export const riskAddressApi = {
  list: () => api.get('/risk-addresses'),
  create: (data) => api.post('/risk-addresses', data),
  update: (id, data) => api.put(`/risk-addresses/${id}`, data),
  remove: (id, version) => api.delete(`/risk-addresses/${id}`, { data: { version } }),
};
