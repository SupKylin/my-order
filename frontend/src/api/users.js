import { api } from './http';

export const userApi = {
  list: () => api.get('/users'),
  create: (user) => api.post('/users', user),
  update: (id, user) => api.put(`/users/${id}`, user),
};
