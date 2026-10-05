<script setup>
import { reactive, ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { Box, Right, Lock, User } from '@element-plus/icons-vue';
import { useAuth } from '../stores/auth';
import { ElMessage } from 'element-plus';
const form = reactive({ username: '', password: '' }),
  busy = ref(false),
  auth = useAuth(),
  router = useRouter(),
  route = useRoute();
async function login() {
  if (!form.username || !form.password) return ElMessage.warning('请输入账号和密码');
  busy.value = true;
  try {
    await auth.login(form);
    const target = String(route.query.redirect || '/orders');
    router.replace(target.startsWith('/') && !target.startsWith('//') ? target : '/orders');
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="login-page">
    <section class="login-story">
      <div class="login-brand">
        <el-icon :size="30"><Box /></el-icon>订单协作台
      </div>
      <div class="story-body">
        <div class="eyebrow">A CLEARER WAY TO WORK</div>
        <h1>让每一笔订单，<br />有序抵达。</h1>
        <p>连接运营与采购，让商品分配、物流跟进和团队协作<br />在同一个工作空间里完成。</p>
        <div class="story-flow">
          <span>订单导入</span><el-icon><Right /></el-icon><span>商品采购</span
          ><el-icon><Right /></el-icon><span>物流交付</span>
        </div>
        <div class="story-card">
          <div class="story-card-top"><span class="live-dot" />以商品为单位，清晰跟进</div>
          <div class="mini-lines"><i /><i /><i /></div>
          <div class="story-tags">
            <span>模板映射</span><span>图片提取</span><span>团队协作</span>
          </div>
        </div>
      </div>
      <div class="story-footer">ORDER WORKSPACE / 运营采购管理系统</div>
    </section>
    <section class="login-panel">
      <div class="login-form">
        <div class="eyebrow">WELCOME BACK</div>
        <h2>登录工作空间</h2>
        <p class="muted">使用你的团队账号，继续今日的工作。</p>
        <el-form label-position="top" @submit.prevent="login"
          ><el-form-item label="账号"
            ><el-input
              v-model="form.username"
              :prefix-icon="User"
              size="large"
              placeholder="请输入账号"
              autocomplete="username" /></el-form-item
          ><el-form-item label="密码"
            ><el-input
              v-model="form.password"
              :prefix-icon="Lock"
              size="large"
              type="password"
              show-password
              placeholder="请输入密码"
              autocomplete="current-password"
          /></el-form-item>
          <div class="login-helper">
            <el-icon><Lock /></el-icon>登录状态保留 7 天
          </div>
          <el-button
            type="primary"
            size="large"
            native-type="submit"
            :loading="busy"
            class="login-submit"
            >登录工作空间<el-icon><Right /></el-icon></el-button
        ></el-form>
        <div class="login-contact">没有账号？请联系系统账号管理员创建。</div>
      </div>
      <div class="login-bottom">运营 / 采购 / 团队协作</div>
    </section>
  </div>
</template>
