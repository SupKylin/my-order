import { api } from './http';
import { useAuth } from '../stores/auth';

const pending = new WeakMap();
// 店铺汇总的两个列表同时挂载时共用在途请求；完成后不缓存，下一次刷新重新统计。
export function loadHomeReport() {
  const user = useAuth().user;
  if (!user) return api.get('/home');
  if (!pending.has(user)) {
    const request = api.get('/home').finally(() => {
      pending.delete(user);
    });
    pending.set(user, request);
  }
  return pending.get(user);
}
