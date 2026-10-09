<script setup>
import ManagementList from '../components/ManagementList.vue';
import { reactive, ref } from 'vue';
import { Plus } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { riskAddressApi } from '../api/riskAddresses';

const list = ref(null);
const fields = [
  { key: 'address1', label: '地址一' },
  { key: 'address2', label: '地址二' },
  { key: 'city', label: '城市' },
  { key: 'state', label: '州' },
  { key: 'postalCode', label: '邮编' },
];
const saving = ref(false),
  dialog = ref(false),
  editing = ref(null);
const form = reactive({});
async function load() {
  await list.value?.refresh();
}
function edit(row = null) {
  editing.value = row;
  for (const key of [...fields.map((field) => field.key), 'note']) form[key] = row?.[key] || '';
  dialog.value = true;
}
async function save() {
  if (fields.some((field) => field.key !== 'address2' && !form[field.key].trim()))
    return ElMessage.warning('请填写地址一、城市、州和邮编');
  saving.value = true;
  try {
    const data = { ...form, version: editing.value?.version };
    if (editing.value) await riskAddressApi.update(editing.value.id, data);
    else await riskAddressApi.create(data);
    dialog.value = false;
    ElMessage.success('风险地址已保存，新旧订单均按最新地址库匹配');
    await load();
  } finally {
    saving.value = false;
  }
}
</script>
<template>
  <ManagementList
    ref="list"
    resource="risk-addresses"
    title="风险地址维护"
    placeholder="搜索地址、城市、州、邮编、备注"
    description="完整匹配地址一、地址二、城市、州、邮编，忽略大小写和多余空格。"
  >
    <template #actions
      ><el-button type="primary" :icon="Plus" @click="edit()">新增风险地址</el-button></template
    >

    <el-table-column
      v-for="field in fields"
      :key="field.key"
      :prop="field.key"
      :label="field.label"
      :min-width="field.key.startsWith('address') ? 220 : 110"
      show-overflow-tooltip
    />
    <el-table-column prop="note" label="风险备注" min-width="200" show-overflow-tooltip />
    <el-table-column label="操作" width="140" fixed="right"
      ><template #default="{ row }">
        <el-button link type="primary" @click="edit(row)">编辑</el-button>
      </template></el-table-column
    >
  </ManagementList>
  <el-dialog
    v-model="dialog"
    :title="editing ? '编辑风险地址' : '新增风险地址'"
    width="640px"
    :close-on-click-modal="false"
    :show-close="!saving"
  >
    <el-form label-position="top" @submit.prevent="save"
      ><div class="form-grid">
        <el-form-item
          v-for="field in fields"
          :key="field.key"
          :label="field.label"
          :required="field.key !== 'address2'"
        >
          <el-input v-model="form[field.key]" maxlength="255" />
        </el-form-item>
        <el-form-item label="风险备注" class="full-width"
          ><el-input v-model="form.note" type="textarea" :rows="3" maxlength="12000"
        /></el-form-item></div
    ></el-form>
    <template #footer
      ><el-button :disabled="saving" @click="dialog = false">取消</el-button
      ><el-button type="primary" :loading="saving" @click="save">保存</el-button></template
    >
  </el-dialog>
</template>
