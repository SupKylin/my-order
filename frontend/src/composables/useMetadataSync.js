import { onMounted, onUnmounted } from 'vue';
import { useAuth } from '../stores/auth';
import { useMeta } from '../stores/meta';

/** 同浏览器跨标签立即更新，其他用户的修改在重新聚焦或 15 秒内同步。 */
export function useMetadataSync() {
  const auth = useAuth();
  const meta = useMeta();
  let timer;
  const refresh = () => {
    if (auth.user && document.visibilityState === 'visible') meta.load(true).catch(() => {});
  };
  const storageChanged = (event) => {
    if (event.key === 'order-dictionaries-updated') refresh();
  };
  onMounted(() => {
    window.addEventListener('focus', refresh);
    window.addEventListener('storage', storageChanged);
    timer = window.setInterval(refresh, 15000);
  });
  onUnmounted(() => {
    window.removeEventListener('focus', refresh);
    window.removeEventListener('storage', storageChanged);
    window.clearInterval(timer);
  });
}
