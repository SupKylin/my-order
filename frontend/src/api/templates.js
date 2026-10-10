import { api } from './http';

export const templateApi = {
  list: () => api.get('/templates'),
  create: (template) => api.post('/templates', template),
  copy: (id) => api.post(`/templates/${id}/copy`),
  update: (id, template) => api.put(`/templates/${id}`, template),
  remove: (id) => api.delete(`/templates/${id}`),
};
