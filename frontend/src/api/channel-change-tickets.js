import { api } from './http';
const base = '/channel-change-tickets';
export const channelChangesApi = {
  list: (params) =>
    api.get(base, {
      params: {
        ...params,
        shopNames: JSON.stringify(params.shopNames || []),
        ...Object.fromEntries(
          ['purchaseChannel', 'purchaseStatus'].flatMap((key) => [
            [key, JSON.stringify((params[key] || []).filter((value) => value !== true))],
            [`${key}Empty`, (params[key] || []).includes(true)],
          ]),
        ),
      },
    }),
  export: (filters, exportId) =>
    api.post(`${base}/export`, { filters, exportId }, { responseType: 'blob', timeout: 0 }),
  batchApply: (body) => api.post(`${base}/batch-apply`, body, { timeout: 0 }),
  options: () => api.get(`${base}/options`),
  create: (body) => api.post(base, body),
  detail: (id, before) => api.get(`${base}/${id}`, { params: { before } }),
  reply: (id, body) => api.post(`${base}/${id}/records`, body),
  status: (id, body) => api.post(`${base}/${id}/status`, body),
  apply: (id, body) => api.post(`${base}/${id}/apply`, body),
};
