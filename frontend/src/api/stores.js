import { api } from './http';

export const storeApi = {
  list: () => api.get('/stores'),
  create: (payload) => api.post('/stores', payload),
  update: (id, payload) => api.put(`/stores/${id}`, payload),
  syncStatus: (id) => api.get(`/stores/${id}/walmart`),
  configureSync: (id, enabled) => api.put(`/stores/${id}/walmart`, { enabled }),
  sync: (id) => api.post(`/stores/${id}/walmart/sync`),
  preview: (id, payload) => api.post(`/stores/${id}/walmart/preview`, payload, { timeout: 600000 }),
};
