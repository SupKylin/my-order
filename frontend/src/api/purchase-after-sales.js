import { api } from './http';
export const afterSalesApi = {
  list: (params) =>
    api.get('/purchase-after-sales', {
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
  options: () => api.get('/purchase-after-sales/options'),
  create: (body) => api.post('/purchase-after-sales', body),
  detail: (id, before) => api.get(`/purchase-after-sales/${id}`, { params: { before } }),
  reply: (id, body) => api.post(`/purchase-after-sales/${id}/records`, body),
  status: (id, body) => api.post(`/purchase-after-sales/${id}/status`, body),
  feedback: (id) => api.post(`/purchase-after-sales/${id}/supplier-feedback`),
  refundAmount: (id, body) => api.put(`/purchase-after-sales/${id}/refund-amount`, body),
};
