import axios from 'axios';
import { ElMessage } from 'element-plus';
export const api = axios.create({
  baseURL: '/api',
  timeout: 120000,
  withCredentials: true,
  headers: { 'X-Requested-With': 'XMLHttpRequest' },
});
let csrf = '';
export const setCsrf = (value) => {
  csrf = value || '';
};
api.interceptors.request.use((config) => {
  if (csrf) config.headers['X-CSRF-Token'] = csrf;
  return config;
});
api.interceptors.response.use(
  (r) => r.data,
  (error) => {
    const body = error.response?.data;
    const details = body?.details?.map((d) => `${d.label || d.field}：${d.message}`).join('；');
    if (!error.config?.silent)
      ElMessage.error(
        details ||
          body?.message ||
          (error.code === 'ECONNABORTED'
            ? '处理超时，请稍后检查导入记录，避免重复操作'
            : '请求失败，请检查后端是否启动'),
      );
    if (error.response?.status === 401 && !error.config?.url?.includes('/auth/login'))
      window.dispatchEvent(new Event('auth-expired'));
    return Promise.reject(error);
  },
);
