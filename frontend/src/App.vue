<script setup>
import { defineAsyncComponent, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  Box,
  Document,
  Upload,
  Clock,
  User,
  SwitchButton,
  Key,
  ArrowRight,
  Setting,
  Expand,
  Fold,
} from '@element-plus/icons-vue';
import { useAuth } from './stores/auth';
import { useMeta } from './stores/meta';
import { ElMessageBox } from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { useMetadataSync } from './composables/useMetadataSync';
import BusinessClocks from './components/BusinessClocks.vue';
useMetadataSync();
const ChangePasswordDialog = defineAsyncComponent(
  () => import('./components/account/ChangePasswordDialog.vue'),
);
const auth = useAuth(),
  meta = useMeta(),
  route = useRoute(),
  router = useRouter();
const menus = [
  { path: '/orders', label: '订单管理', icon: Box },
  // 订单统一由 Walmart API 接入，保留 Excel 导入入口代码。
  // { path: '/imports/new', label: '导入订单', icon: Upload },
  { path: '/imports/purchases/new', label: '导入采购', icon: Upload },
  { path: '/templates', label: '导入模板', icon: Document },
  { path: '/imports', label: '导入记录', icon: Clock },
  { path: '/users', label: '账号管理', icon: User },
  { path: '/stores', label: '店铺管理', icon: Setting },
  { path: '/settings/channels', label: '采购渠道维护', icon: Setting },
  { path: '/settings/order-statuses', label: '运营订单状态维护', icon: Setting },
  { path: '/settings/purchase-statuses', label: '采购状态维护', icon: Setting },
];
const showPassword = ref(false);
const sidebarOpen = ref(false);
async function signOut() {
  try {
    await ElMessageBox.confirm('确认退出当前账号？', '退出登录', { type: 'info' });
    await auth.logout();
    router.replace('/login');
  } catch {}
}
</script>
<template>
  <el-config-provider :locale="zhCn">
    <router-view v-if="route.meta.public" />
    <div v-else class="app-shell">
      <div class="sidebar-container" :class="{ 'is-open': sidebarOpen }">
        <aside
          id="sidebar-navigation"
          class="sidebar"
          :inert="!sidebarOpen"
          :aria-hidden="!sidebarOpen"
        >
          <router-link to="/orders" class="brand"
            ><div class="brand-mark">
              <el-icon :size="24"><Box /></el-icon>
            </div>
            <div>订单协作台<small>ORDER WORKSPACE</small></div></router-link
          >
          <div class="nav-caption">业务工作台</div>
          <nav>
            <router-link
              v-for="item in menus"
              :key="item.path"
              :to="item.path"
              :class="{ active: route.path === item.path }"
              ><el-icon :size="19"><component :is="item.icon" /></el-icon
              ><span>{{ item.label }}</span
              ><span v-if="route.path === item.path" class="nav-dot"
            /></router-link>
          </nav>
          <div class="sidebar-note">
            <span class="live-dot" />本地工作空间
            <p>订单 · 采购 · 协作</p>
          </div>
          <div class="sidebar-user">
            <div class="avatar">{{ auth.user?.displayName?.slice(0, 1) }}</div>
            <div class="user-info">
              <strong>{{ auth.user?.displayName }}</strong
              ><small>{{ meta.roles[auth.user?.role] || '团队成员' }}</small>
            </div>
            <el-button text circle aria-label="退出登录" @click="signOut"
              ><el-icon><SwitchButton /></el-icon
            ></el-button>
          </div>
        </aside>
      </div>
      <div
        class="workspace"
        :class="{
          'workspace-orders': route.path === '/orders',
          'workspace-sidebar-open': sidebarOpen,
        }"
      >
        <header class="topbar">
          <div class="topbar-left">
            <el-button
              class="sidebar-toggle"
              text
              circle
              :icon="sidebarOpen ? Fold : Expand"
              :aria-label="sidebarOpen ? '收起导航' : '展开导航'"
              :aria-expanded="sidebarOpen"
              aria-controls="sidebar-navigation"
              @click="sidebarOpen = !sidebarOpen"
            />
            <span class="breadcrumb"
              >工作空间 <el-icon><ArrowRight /></el-icon>
              <strong>{{ route.meta.title }}</strong></span
            >
          </div>
          <div id="orders-topbar-warnings" v-show="route.path === '/orders'"></div>
          <div class="topbar-right">
            <BusinessClocks />
            <el-button text :icon="Key" @click="showPassword = true">修改密码</el-button>
          </div>
        </header>
        <main>
          <div v-if="route.path !== '/orders'" class="page-title">
            <div>
              <div class="eyebrow">OPERATIONS / WORKSPACE</div>
              <h1>{{ route.meta.title }}</h1>
              <p>{{ route.meta.subtitle }}</p>
            </div>
            <div class="workspace-badge"><span class="live-dot" />协作工作台</div>
          </div>
          <router-view />
        </main>
        <footer v-if="route.path !== '/orders'">
          订单协作台 <span>按商品分配 · 非空字段更新 · 7 天登录有效期</span>
        </footer>
      </div>
      <ChangePasswordDialog v-if="showPassword" v-model="showPassword" />
    </div>
  </el-config-provider>
</template>
