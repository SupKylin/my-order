<script setup>
import { ref, reactive } from 'vue';
import { ElMessage } from 'element-plus';
import { authApi } from '../../api/auth';
const showPassword = defineModel({ type: Boolean });
const saving = ref(false);
const password = reactive({ oldPassword: '', newPassword: '', confirm: '' });
async function changePassword() {
  if (saving.value) return;
  if (password.newPassword !== password.confirm) return ElMessage.warning('两次新密码不一致');
  saving.value = true;
  try {
    await authApi.changePassword(password.oldPassword, password.newPassword);
    ElMessage.success('密码已更新');
    showPassword.value = false;
    Object.assign(password, { oldPassword: '', newPassword: '', confirm: '' });
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <el-dialog
    v-model="showPassword"
    title="修改登录密码"
    width="440px"
    :close-on-click-modal="!saving"
    :close-on-press-escape="!saving"
    :show-close="!saving"
    destroy-on-close
    ><el-form :disabled="saving" label-position="top"
      ><el-form-item label="原密码"
        ><el-input
          v-model="password.oldPassword"
          type="password"
          show-password
          autocomplete="current-password" /></el-form-item
      ><el-form-item label="新密码（8 至 128 位）"
        ><el-input
          v-model="password.newPassword"
          type="password"
          show-password
          autocomplete="new-password" /></el-form-item
      ><el-form-item label="确认新密码"
        ><el-input
          v-model="password.confirm"
          type="password"
          show-password
          autocomplete="new-password" /></el-form-item></el-form
    ><template #footer
      ><el-button :disabled="saving" @click="showPassword = false">取消</el-button
      ><el-button type="primary" :loading="saving" @click="changePassword"
        >保存密码</el-button
      ></template
    ></el-dialog
  >
</template>
