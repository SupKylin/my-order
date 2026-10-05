import { defineStore } from 'pinia';
import { setCsrf } from '../api/http';
import { authApi } from '../api/auth';
export const useAuth = defineStore('auth', {
  state: () => ({ user: null, ready: false, expiresAt: null }),
  actions: {
    // 只保存公开账号信息；认证凭据由 HttpOnly Cookie 管理。
    accept(data) {
      this.user = data.user;
      this.expiresAt = data.expiresAt;
      setCsrf(data.csrfToken);
      this.ready = true;
    },
    async restore() {
      try {
        this.accept(await authApi.me());
      } catch {
        this.user = null;
        this.ready = true;
      }
    },
    async login(form) {
      this.accept(await authApi.login(form));
    },
    async logout() {
      await authApi.logout();
      this.user = null;
      setCsrf('');
    },
  },
});
