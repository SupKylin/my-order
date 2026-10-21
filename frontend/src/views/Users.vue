<script setup>
import ManagementList from '../components/ManagementList.vue';
import { ref, reactive, onMounted } from 'vue';
import { Plus } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { userApi } from '../api/users';
import { fmtDate } from '../utils/format';
import { useMeta } from '../stores/meta';
const list = ref(null);
const meta = useMeta(),
  saving = ref(false),
  dialog = ref(false),
  editing = ref(null),
  form = reactive({
    username: '',
    displayName: '',
    role: 'operations',
    active: true,
    password: '',
  });
async function load() {
  await list.value?.refresh();
}
function edit(row) {
  editing.value = row;
  Object.assign(
    form,
    row
      ? {
          username: row.username,
          displayName: row.displayName,
          role: row.role,
          active: row.active,
          password: '',
        }
      : { username: '', displayName: '', role: 'operations', active: true, password: '' },
  );
  dialog.value = true;
}
async function save() {
  if (saving.value) return;
  saving.value = true;
  try {
    if (editing.value) await userApi.update(editing.value.id, { ...form });
    else await userApi.create({ ...form });
    ElMessage.success('账号已保存');
    dialog.value = false;
    await load();
  } finally {
    saving.value = false;
  }
}
onMounted(async () => {
  await meta.load();
});
</script>
<template>
  <ManagementList
    ref="list"
    resource="users"
    title="账号管理"
    placeholder="搜索登录账号、成员姓名"
    description="当前角色用于人员区分，所有启用账号均可使用全部业务功能。"
  >
    <template #actions
      ><el-button type="primary" :icon="Plus" @click="edit(null)">创建账号</el-button></template
    >
    <el-table-column label="成员" min-width="180"
      ><template #default="{ row }"
        ><div class="member-cell">
          <div class="avatar light">{{ row.displayName.slice(0, 1) }}</div>
          <strong>{{ row.displayName }}</strong>
        </div></template
      ></el-table-column
    ><el-table-column label="登录账号" prop="username" min-width="160" /><el-table-column
      label="角色"
      min-width="180"
      ><template #default="{ row }"
        ><el-tag
          :type="row.role === 'admin' ? 'warning' : row.role === 'purchasing' ? 'success' : 'info'"
          effect="plain"
          >{{ meta.roles[row.role] }}</el-tag
        ></template
      ></el-table-column
    ><el-table-column label="状态" min-width="110"
      ><template #default="{ row }"
        ><span :class="row.active ? 'success-text' : 'muted'">{{
          row.active ? '● 已启用' : '● 已停用'
        }}</span></template
      ></el-table-column
    ><el-table-column label="创建时间" min-width="185"
      ><template #default="{ row }">{{ fmtDate(row.createdAt, true) }}</template></el-table-column
    ><el-table-column label="操作" width="150" fixed="right"
      ><template #default="{ row }"
        ><el-button link type="primary" @click="edit(row)">编辑 / 重置密码</el-button></template
      ></el-table-column
    >
  </ManagementList>
  <el-dialog
    v-model="dialog"
    :title="editing ? '编辑团队账号' : '创建团队账号'"
    width="480px"
    :close-on-click-modal="false"
    :close-on-press-escape="!saving"
    :show-close="!saving"
    ><el-form :disabled="saving" label-position="top"
      ><el-form-item label="姓名"
        ><el-input
          v-model="form.displayName"
          maxlength="100"
          placeholder="团队中显示的姓名" /></el-form-item
      ><el-form-item label="登录账号"
        ><el-input
          v-model="form.username"
          maxlength="64"
          placeholder="3 至 64 位字母、数字或 _ . @ -"
          autocomplete="off" /></el-form-item
      ><el-form-item label="角色"
        ><el-select v-model="form.role"
          ><el-option
            v-for="(label, key) in meta.roles"
            :key="key"
            :value="key"
            :label="label" /></el-select></el-form-item
      ><el-form-item :label="editing ? '重置密码（留空则不修改）' : '登录密码（至少 8 位）'"
        ><el-input
          v-model="form.password"
          type="password"
          show-password
          autocomplete="new-password" /></el-form-item
      ><el-form-item label="启用账号"><el-switch v-model="form.active" /></el-form-item></el-form
    ><template #footer
      ><el-button :disabled="saving" @click="dialog = false">取消</el-button
      ><el-button type="primary" :loading="saving" @click="save">保存账号</el-button></template
    ></el-dialog
  >
</template>
