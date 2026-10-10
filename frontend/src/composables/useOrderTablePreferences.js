import { computed, ref, watch } from 'vue';
import { authApi } from '../api/auth';
import { orderedColumns } from '../utils/orderTablePreferences';

/** 服务端为准；账号切换后立即丢弃前一账号的设置，避免串用。 */
export function useOrderTablePreferences(auth, columns) {
  const preferences = ref(null);
  const ready = ref(false);
  const saving = ref(false);
  const ordered = computed(() => orderedColumns(columns.value, preferences.value));
  const visible = computed(() =>
    ordered.value.filter((column) => !preferences.value?.hidden?.includes(column.key)),
  );
  let generation = 0;
  async function load() {
    const current = ++generation;
    const userId = auth.user?.id;
    ready.value = false;
    preferences.value = null;
    if (!userId) return;
    try {
      const result = await authApi.orderTablePreferences();
      if (current !== generation) return;
      preferences.value = result.preferences;
      // 首次升级仍显示本账号原有勾选；保存时一并迁移到数据库。
      if (!preferences.value) {
        try {
          const hidden = JSON.parse(localStorage.getItem(`my-order-order-columns-${userId}`));
          if (Array.isArray(hidden))
            preferences.value = {
              order: [],
              hidden: hidden.filter((key) => typeof key === 'string'),
            };
        } catch {
          /* 本地存储不可用时使用默认列。 */
        }
      }
      ready.value = true;
    } catch {
      // 请求层已提示错误；禁止用尚未读取的默认值覆盖账号设置。
    }
  }
  watch(() => auth.user?.id, load, { immediate: true });
  async function save(value) {
    if (!ready.value || saving.value) return false;
    const current = generation;
    saving.value = true;
    try {
      const result = await authApi.saveOrderTablePreferences(value);
      if (current !== generation) return false;
      preferences.value = result.preferences;
      return true;
    } catch {
      // 保留弹窗草稿，错误由请求层提示，用户可重试保存。
      return false;
    } finally {
      saving.value = false;
    }
  }
  return { ordered, visible, ready, saving, save, load };
}
