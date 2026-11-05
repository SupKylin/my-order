<script setup>
import ManagementList from '../components/ManagementList.vue';
import { computed, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { Plus } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { dictionaryApi } from '../api/dictionaries';
import { useMeta } from '../stores/meta';
import { discountPreview, fixedDecimal } from '../utils/purchaseCost';

const list = ref(null);
const route = useRoute();
const meta = useMeta();
const kind = computed(() => route.meta.dictionaryKind);
const saving = ref(false);
const dialog = ref(false);
const editing = ref(null);
const form = reactive({ value: '', sortOrder: 0, active: true });
const discountFields = [
  ['channelExchangeRate', '采购渠道汇率'],
  ['currentExchangeRate', '当前实时汇率'],
  ['taxMultiplier', '税金'],
];
const discount = computed(() => discountPreview(form));

async function load() {
  await list.value?.refresh();
}
function edit(row) {
  editing.value = row || null;
  Object.assign(
    form,
    row
      ? { value: row.value, sortOrder: row.sortOrder, active: row.active }
      : { value: '', sortOrder: list.value?.total || 0, active: true },
  );
  for (const [key] of discountFields) form[key] = row?.[key] == null ? undefined : Number(row[key]);
  dialog.value = true;
}
async function save() {
  if (saving.value) return;
  if (!form.value.trim()) return ElMessage.warning('请输入选项名称');
  saving.value = true;
  try {
    const payload = { ...form, version: editing.value?.version };
    if (kind.value === 'purchaseChannel')
      for (const [key] of discountFields) payload[key] = form[key] ?? null;
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
  },
  { immediate: true },
);
</script>

<template>
  <ManagementList
    ref="list"
    resource="dictionaries"
    :title="route.meta.title"
    :kind="kind"
    placeholder="搜索选项名称"
    description="停用后不再出现在下拉列表中；历史订单保留原名称。"
  >
    <template #actions
      ><el-button type="primary" :icon="Plus" @click="edit()">新增选项</el-button></template
    >

    <el-table-column label="选项名称" prop="value" min-width="260" />
    <el-table-column v-if="kind === 'purchaseChannel'" label="采购折扣" width="140">
      <template #default="{ row }">{{
        row.purchaseDiscount == null ? '未配置' : fixedDecimal(row.purchaseDiscount, 4)
      }}</template>
    </el-table-column>
    <el-table-column label="排序" prop="sortOrder" width="100" />
    <el-table-column label="使用状态" width="130"
      ><template #default="{ row }">
        <el-tag :type="row.active ? 'success' : 'info'">{{ row.active ? '启用' : '停用' }}</el-tag>
      </template></el-table-column
    >
    <el-table-column label="操作" width="110" fixed="right"
      ><template #default="{ row }">
        <el-button link type="primary" @click="edit(row)">编辑</el-button>
      </template></el-table-column
    >
  </ManagementList>
  <el-dialog
    v-model="dialog"
    :title="editing ? '编辑选项' : '新增选项'"
    width="480px"
    :close-on-click-modal="false"
    :close-on-press-escape="!saving"
    :show-close="!saving"
  >
    <el-form :disabled="saving" label-position="top">
      <el-form-item label="选项名称" required
        ><el-input v-model="form.value" maxlength="255" placeholder="填写下拉选项名称"
      /></el-form-item>
      <template v-if="kind === 'purchaseChannel'">
        <el-alert
          title="采购折扣 = 采购渠道汇率 ÷ 当前实时汇率 × 税金"
          description="税金直接作为乘数，例如1.08表示乘以1.08。最多2位小数，实时汇率须大于0；折扣保留4位小数。修改配置不改变已结算的历史成本。"
          type="info"
          :closable="false"
          style="margin-bottom: 18px"
        />
        <el-form-item v-for="[key, label] in discountFields" :key="key" :label="label">
          <el-input-number
            v-model="form[key]"
            :min="0"
            :max="999999999999.99"
            :precision="2"
            :step="0.01"
            controls-position="right"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="采购折扣（自动计算）"
          ><strong>{{ discount ?? '请完整填写三个数字' }}</strong></el-form-item
        >
      </template>
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
