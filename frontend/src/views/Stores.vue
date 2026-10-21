<script setup>
import ManagementList from '../components/ManagementList.vue';
import { defineAsyncComponent, reactive, ref } from 'vue';
import { Plus } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { storeApi } from '../api/stores';
import { userApi } from '../api/users';
import { fmtDate } from '../utils/format';

const list = ref(null);
const WalmartSyncDialog = defineAsyncComponent(
  () => import('../components/stores/WalmartSyncDialog.vue'),
);
const syncingStore = ref(null);
const saving = ref(false);
const opening = ref(false);
const dialog = ref(false);
const editing = ref(null);
const users = ref([]);
const form = reactive({
  walmartStoreName: '',
  systemStoreName: '',
  ownerId: null,
  clientId: '',
  clientSecret: '',
});

async function load() {
  await list.value?.refresh();
}

async function edit(row = null) {
  if (opening.value) return;
  opening.value = true;
  try {
    users.value = await userApi.list();
    editing.value = row;
    Object.assign(
      form,
      row
        ? {
            walmartStoreName: row.walmartStoreName,
            systemStoreName: row.systemStoreName,
            ownerId: row.ownerId ?? null,
            clientId: row.clientId,
            clientSecret: row.clientSecret,
          }
        : {
            walmartStoreName: '',
            systemStoreName: '',
            ownerId: null,
            clientId: '',
            clientSecret: '',
          },
    );
    dialog.value = true;
  } finally {
    opening.value = false;
  }
}

async function save() {
  if (saving.value) return;
  if (!form.walmartStoreName.trim() || !form.systemStoreName.trim())
    return ElMessage.warning('请填写 Walmart 店铺名和系统店铺名');
  if (!editing.value && (!form.clientId.trim() || !form.clientSecret.trim()))
    return ElMessage.warning('请填写 Client ID 和 Client Secret');
  saving.value = true;
  try {
    const payload = { ...form, ownerId: form.ownerId || null, version: editing.value?.version };
    if (editing.value) await storeApi.update(editing.value.id, payload);
    else await storeApi.create(payload);
    dialog.value = false;
    ElMessage.success('店铺信息已保存');
    await load();
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <ManagementList
    ref="list"
    resource="stores"
    title="店铺管理"
    placeholder="搜索 Walmart 店铺名、系统店铺名"
    description="维护店铺名称对应关系与 API 认证信息。"
  >
    <template #actions
      ><el-button type="primary" :icon="Plus" :loading="opening" @click="edit()"
        >新增店铺</el-button
      ></template
    >

    <el-table-column label="Walmart 店铺名" prop="walmartStoreName" min-width="220" />
    <el-table-column label="系统店铺名" prop="systemStoreName" min-width="220" />
    <el-table-column label="店铺所属账号" min-width="160">
      <template #default="{ row }">{{ row.owner?.displayName || '未绑定' }}</template>
    </el-table-column>
    <el-table-column label="Client ID" prop="clientId" min-width="260" show-overflow-tooltip />
    <el-table-column
      label="Client Secret"
      prop="clientSecret"
      min-width="300"
      show-overflow-tooltip
    />
    <el-table-column label="自动同步" width="120"
      ><template #default="{ row }"
        ><el-tag :type="row.syncEnabled ? 'success' : 'info'">{{
          row.syncEnabled ? '已开启' : '未开启'
        }}</el-tag></template
      ></el-table-column
    >
    <el-table-column label="更新时间" min-width="180">
      <template #default="{ row }">{{ fmtDate(row.updatedAt, true) }}</template>
    </el-table-column>
    <el-table-column label="操作" width="180" fixed="right">
      <template #default="{ row }">
        <el-button link type="primary" :loading="opening" @click="edit(row)">编辑</el-button>
        <el-button link type="primary" @click="syncingStore = row">订单同步</el-button>
      </template>
    </el-table-column>
  </ManagementList>
  <WalmartSyncDialog
    v-if="syncingStore"
    :store="syncingStore"
    @close="
      syncingStore = null;
      load();
    "
  />

  <el-dialog
    v-model="dialog"
    :title="editing ? '编辑店铺' : '新增店铺'"
    width="560px"
    :close-on-click-modal="false"
    :close-on-press-escape="!saving"
    :show-close="!saving"
  >
    <el-form :disabled="saving" label-position="top">
      <el-form-item label="Walmart 店铺名" required>
        <el-input v-model="form.walmartStoreName" maxlength="191" />
      </el-form-item>
      <el-form-item label="系统店铺名" required>
        <el-input v-model="form.systemStoreName" maxlength="191" />
      </el-form-item>
      <el-form-item label="店铺所属账号">
        <el-select v-model="form.ownerId" placeholder="选择所属账号，可留空" clearable filterable>
          <el-option
            v-for="user in users.filter((entry) => entry.active || entry.id === editing?.ownerId)"
            :key="user.id"
            :value="user.id"
            :label="`${user.displayName} · ${user.username}${user.active ? '' : '（已停用）'}`"
            :disabled="!user.active"
          />
        </el-select>
      </el-form-item>
      <el-form-item :label="editing ? 'Client ID（留空保留原值）' : 'Client ID'" required>
        <el-input v-model="form.clientId" maxlength="255" />
      </el-form-item>
      <el-form-item :label="editing ? 'Client Secret（留空保留原值）' : 'Client Secret'" required>
        <el-input v-model="form.clientSecret" type="textarea" :rows="5" maxlength="10000" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button :disabled="saving" @click="dialog = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="save">保存店铺</el-button>
    </template>
  </el-dialog>
</template>
