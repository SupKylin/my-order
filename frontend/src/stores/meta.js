import { defineStore } from 'pinia';
import { getMetadata } from '../api/meta';
import { useAuth } from './auth';
let pending;
export const useMeta = defineStore('meta', {
  state: () => ({ fields: [], roles: {}, publicBase: '', purchaseChannels: [], currentRole: '' }),
  getters: { fieldMap: (state) => Object.fromEntries(state.fields.map((f) => [f.key, f])) },
  actions: {
    async load(force = false) {
      if (!force && this.fields.length) return;
      if (!pending)
        pending = getMetadata().finally(() => {
          pending = null;
        });
      Object.assign(this, await pending);
      const auth = useAuth();
      if (auth.user && this.currentRole) auth.user.role = this.currentRole;
    },
    async publishChange() {
      // 等待可能正在进行的旧请求结束，再强制读取保存后的选项。
      if (pending) await pending.catch(() => {});
      await this.load(true);
      try {
        localStorage.setItem('order-dictionaries-updated', String(Date.now()));
      } catch {}
    },
    imageUrl(path, thumb = false) {
      if (!path) return '';
      if (/^https:\/\//i.test(path)) return path;
      return this.publicBase + (thumb ? path.replace('.webp', '.thumb.webp') : path);
    },
  },
});
