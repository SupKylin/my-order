<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Plus, Refresh } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { dictionaryApi } from '../api/dictionaries';
import { useMeta } from '../stores/meta';

const route = useRoute();
const meta = useMeta();
const kind = computed(() => route.meta.dictionaryKind);
const rows = ref([]);
const loading = ref(false);
const saving = ref(false);
const dialog = ref(false);
const editing = ref(null);
const form = reactive({ value: '', sortOrder: 0, active: true });
let requestVersion = 0;

async function load() {
  const version = ++requestVersion;
  loading.value = true;
  try {
    const result = await dictionaryApi.list(kind.value);
    if (version === requestVersion) rows.value = result;
  } finally {
    if (version === requestVersion) loading.value = false;
  }
}
function edit(row) {
  editing.value = row || null;
  Object.assign(
    form,
    row
      ? { value: row.value, sortOrder: row.sortOrder, active: row.active }
      : { value: '', sortOrder: rows.value.length, active: true },
  );
  dialog.value = true;
}
async function save() {
  if (!form.value.trim()) return ElMessage.warning('请输入选项名称');
  saving.value = true;
  try {
    const payload = { ...form, version: editing.value?.version };
    if (editing.value) await dictionaryApi.update(kind.value, editing.value.id, payload);
    else await dictionaryApi.create(kind.value, payload);
    // 同页下拉立即刷新，其他已打开页面通过元数据同步订阅更新。
    await meta.publishChange();
    dialog.value = false;
    ElMessage.success('已保存，下拉选项已同步');
    await load();
  } finally {
    saving.value = false;
  }
}
watch(
  kind,
  () => {
    dialog.value = false;
    rows.value = [];
    load();
  },
  { immediate: true },
);
</script>

<template>
  <section class="panel">
    <div class="panel-heading">
      <div>
        <h2>
          {{ route.meta.title }} <span class="count-label">{{ rows.length }} 项</span>
        </h2>
        <p>新增、修改名称、排序或停用选项。历史订单保留原名称。</p>
      </div>
      <div class="button-row">
        <el-button :icon="Refresh" @click="load">刷新</el-button>
        <el-button type="primary" :icon="Plus" @click="edit()">新增选项</el-button>
      </div>
    </div>
    <el-table :data="rows" v-loading="loading">
      <el-table-column label="选项名称" prop="value" min-width="260" />
      <el-table-column label="排序" prop="sortOrder" width="100" />
      <el-table-column label="使用状态" width="130"
        ><template #default="{ row }">
          <el-tag :type="row.active ? 'success' : 'info'">{{
            row.active ? '启用' : '停用'
          }}</el-tag>
        </template></el-table-column
      >
      <el-table-column label="操作" width="110"
        ><template #default="{ row }">
          <el-button link type="primary" @click="edit(row)">编辑</el-button>
        </template></el-table-column
      >
    </el-table>
    <p class="mapping-footnote">
      排序数值越小越靠前。停用后不再出现在可选列表中；历史记录仍可显示和保留原值。已绑定模板的渠道改名后，后续导入使用新名称。
    </p>
  </section>
  <el-dialog
    v-model="dialog"
    :title="editing ? '编辑选项' : '新增选项'"
    width="480px"
    :close-on-click-modal="false"
  >
    <el-form label-position="top">
      <el-form-item label="选项名称" required
        ><el-input v-model="form.value" maxlength="255" placeholder="填写下拉选项名称"
      /></el-form-item>
      <el-form-item label="排序"
        ><el-input-number v-model="form.sortOrder" :min="0" :max="100000" :precision="0"
      /></el-form-item>
      <el-form-item label="使用状态"
        ><el-switch v-model="form.active" active-text="启用" inactive-text="停用"
      /></el-form-item>
    </el-form>
    <template #footer
      ><el-button :disabled="saving" @click="dialog = false">取消</el-button
      ><el-button type="primary" :loading="saving" @click="save">保存选项</el-button></template
    >
  </el-dialog>
</template>
