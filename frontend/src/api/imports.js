import { api } from './http';

export const importApi = {
  list: () => api.get('/imports'),
  get: (id) => api.get(`/imports/${id}`),
  preview: (uploadId, template) => api.post('/imports/preview', { uploadId, template }),
  commit: (id) => api.post(`/imports/${id}/commit`),
};
