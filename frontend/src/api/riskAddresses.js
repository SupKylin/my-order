import { api } from './http';

export const riskAddressApi = {
  list: () => api.get('/risk-addresses'),
  create: (data) => api.post('/risk-addresses', data),
  update: (id, data) => api.put(`/risk-addresses/${id}`, data),
  remove: (id, version) => api.delete(`/risk-addresses/${id}`, { data: { version } }),
  template: () => api.get('/risk-addresses/import-template', { responseType: 'blob' }),
  importExcel: (file) => {
    const body = new FormData();
    body.append('file', file);
    return api.post('/risk-addresses/import', body);
  },
};
