import { api } from './http';

export const track123DocsApi = {
  endpoints: (q) => api.get('/track123-docs/endpoints', { params: { q } }),
  endpoint: (path, method) => api.get('/track123-docs/endpoint', { params: { path, method } }),
};
