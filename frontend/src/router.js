import { createRouter, createWebHistory } from 'vue-router';
import { useAuth } from './stores/auth';
import { useMeta } from './stores/meta';
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', component: () => import('./views/Login.vue'), meta: { public: true } },
    { path: '/', redirect: '/orders' },
    {
      path: '/orders',
      component: () => import('./views/Orders.vue'),
      meta: { title: '订单管理', subtitle: '同步 Walmart 官方订单，管理采购与交付进度。' },
    },
    {
      path: '/allocation',
      redirect: { path: '/orders', query: { assignedTo: 'unassigned' } },
    },
    // 订单统一从 Walmart API 接入；保留原页面与路由代码。
    // {
    //   path: '/imports/new',
    //   component: () => import('./views/Import.vue'),
    //   meta: { title: '导入订单', subtitle: '映射表头、检查预览，将每日订单有序同步到系统。' },
    // },
    {
      path: '/imports/purchases/new',
      component: () => import('./views/PurchaseImport.vue'),
      meta: {
        title: '采购导入',
        subtitle: '选择导入模板与 Excel 文件，预览匹配结果后更新采购信息。',
      },
    },
    {
      path: '/templates',
      component: () => import('./views/Templates.vue'),
      meta: { title: '导入模板', subtitle: '不同店铺、不同表头，维护一次映射即可反复使用。' },
    },
    {
      path: '/imports',
      component: () => import('./views/History.vue'),
      meta: { title: '导入记录', subtitle: '查看导入结果、更新时间和待确认的预览。' },
    },
    {
      path: '/users',
      component: () => import('./views/Users.vue'),
      meta: { title: '账号管理', subtitle: '维护团队账号与角色，当前三个角色均开放全部业务功能。' },
    },
    {
      path: '/stores',
      component: () => import('./views/Stores.vue'),
      meta: {
        title: '店铺管理',
        subtitle: '维护 Walmart 店铺与系统店铺名称，并保存 Client ID 和 Client Secret。',
      },
    },
    ...[
      ['channels', '采购渠道维护', 'purchaseChannel'],
      ['order-statuses', '运营订单状态维护', 'orderStatus'],
      ['purchase-statuses', '采购状态维护', 'purchaseStatus'],
    ].map(([path, title, dictionaryKind]) => ({
      path: `/settings/${path}`,
      component: () => import('./views/Dictionaries.vue'),
      meta: { title, dictionaryKind, subtitle: '集中维护下拉选项，修改后同步到订单与导入表单。' },
    })),
    { path: '/:pathMatch(.*)*', redirect: '/orders' },
  ],
});
router.beforeEach(async (to) => {
  const auth = useAuth();
  if (!auth.ready) await auth.restore();
  if (!to.meta.public && !auth.user) return { path: '/login', query: { redirect: to.fullPath } };
  if (to.path === '/login' && auth.user) return '/orders';
  if (!to.meta.public && auth.user) await useMeta().load(true);
});
window.addEventListener('auth-expired', () => {
  const auth = useAuth();
  auth.user = null;
  if (router.currentRoute.value.path !== '/login') router.replace('/login');
});
export default router;
