import { api } from './http';

export const importApi = {
  list: () => api.get('/imports'),
  get: (id) => api.get(`/imports/${id}`),
  preview: (uploadId, template) => api.post('/imports/preview', { uploadId, template }),
  commit: (id) => api.post(`/imports/${id}/commit`),
  previewOrder: (uploadId, template) => api.post('/imports/orders/preview', { uploadId, template }),
  commitOrder: (id) => api.post(`/imports/orders/${id}/commit`),
  previewPurchases: (sources) => api.post('/imports/purchases/preview', { sources }),
  commitPurchases: (id) => api.post(`/imports/purchases/${id}/commit`),
};
