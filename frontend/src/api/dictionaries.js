import { api } from './http';

export const dictionaryApi = {
  list: (kind) => api.get(`/dictionaries/${kind}`),
  create: (kind, option) => api.post(`/dictionaries/${kind}`, option),
  update: (kind, id, option) => api.put(`/dictionaries/${kind}/${id}`, option),
};
