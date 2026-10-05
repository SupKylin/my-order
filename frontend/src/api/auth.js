import { api } from './http';

export const authApi = {
  me: () => api.get('/auth/me', { silent: true }),
  login: (credentials) => api.post('/auth/login', credentials),
  logout: () => api.post('/auth/logout'),
  changePassword: (oldPassword, newPassword) =>
    api.put('/auth/password', { oldPassword, newPassword }),
};
