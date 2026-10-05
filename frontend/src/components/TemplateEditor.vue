<script setup>
import { ref, reactive, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { Upload } from '@element-plus/icons-vue';
import { templateApi } from '../api/templates';
import { uploadApi } from '../api/uploads';
import MappingEditor from './MappingEditor.vue';
import ChannelBinding from './ChannelBinding.vue';
import { useMeta } from '../stores/meta';
import { alignMappings, suggestedMappings, mappingIssues } from '../mapping';
const props = defineProps({ modelValue: Boolean, template: Object });
const emit = defineEmits(['update:modelValue', 'saved']);
const visible = computed({ get: () => props.modelValue, set: (v) => emit('update:modelValue', v) }),
  meta = useMeta(),
  busy = ref(false),
  info = ref(null),
  uploadId = ref(null);
const form = reactive({
  name: '',
  sheetName: '',
  headerRow: 1,
  mappings: [],
  purchaseChannelId: null,
});
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    await meta.load();
    info.value = null;
    uploadId.value = null;
    Object.assign(
      form,
      props.template
        ? JSON.parse(JSON.stringify(props.template))
        : { name: '', sheetName: '', headerRow: 1, mappings: [], purchaseChannelId: null },
    );
    if (props.template)
      info.value = {
        columns: form.mappings.map((m) => ({ ...m, samples: [] })),
        sheets: [{ name: form.sheetName }],
      };
  },
  { immediate: true },
);
async function upload(options) {
  busy.value = true;
  try {
    const result = await uploadApi.excel(options.file);
    uploadId.value = result.id;
    info.value = result;
    form.sheetName = result.sheetName;
    form.headerRow = 1;
    if (!props.template) form.mappings = suggestedMappings(result.columns);
    else form.mappings = alignMappings(form.mappings, result.columns).mappings;
    options.onSuccess(result);
  } catch (e) {
    options.onError(e);
  } finally {
    busy.value = false;
  }
}
async function inspect() {
  if (!uploadId.value) return;
  busy.value = true;
  try {
    info.value = await uploadApi.inspect(uploadId.value, form.sheetName, form.headerRow);
    form.mappings = suggestedMappings(info.value.columns);
  } finally {
    busy.value = false;
  }
}
async function save() {
  const issues = mappingIssues(form.mappings, meta.fields);
  if (issues.length) return ElMessage.warning(issues[0].message);
  busy.value = true;
  try {
    const payload = {
      name: form.name,
      sheetName: form.sheetName,
      headerRow: form.headerRow,
      mappings: form.mappings,
      purchaseChannelId: form.purchaseChannelId,
    };
    if (props.template?.id) await templateApi.update(props.template.id, payload);
    else await templateApi.create(payload);
    ElMessage.success('模板已保存');
    visible.value = false;
    emit('saved');
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <el-dialog
    v-model="visible"
    :title="template ? '编辑导入模板' : '创建导入模板'"
    width="900px"
    :close-on-click-modal="false"
    destroy-on-close
    ><el-form label-position="top"
      ><div class="template-controls">
        <el-form-item label="模板名称" class="flex-one"
          ><el-input
            v-model="form.name"
            placeholder="例如：店铺 A 每日订单"
            maxlength="100" /></el-form-item
        ><el-upload :show-file-list="false" accept=".xlsx" :http-request="upload" :disabled="busy"
          ><el-button :icon="Upload" :loading="busy">上传示例 Excel</el-button></el-upload
        >
      </div>
      <ChannelBinding v-model="form.purchaseChannelId" :disabled="busy" />
      <div v-if="info" class="template-controls">
        <el-form-item label="工作表"
          ><el-select v-model="form.sheetName" :disabled="!uploadId" @change="inspect"
            ><el-option
              v-for="sheet in info.sheets"
              :key="sheet.name"
              :value="sheet.name"
              :label="sheet.name" /></el-select></el-form-item
        ><el-form-item label="表头所在行"
          ><el-input-number
            v-model="form.headerRow"
            :min="1"
            :max="100"
            :disabled="!uploadId"
            @change="inspect"
        /></el-form-item></div></el-form
    ><MappingEditor
      v-if="info"
      :info="info"
      v-model="form.mappings"
      :manual-source="!uploadId"
      :max-height="null"
      :disabled="busy"
    /><el-empty
      v-else
      description="上传示例文件后，选择每一列对应的系统字段"
      :image-size="90"
    /><template #footer
      ><el-button @click="visible = false">取消</el-button
      ><el-button type="primary" :loading="busy" :disabled="!info" @click="save"
        >保存模板</el-button
      ></template
    ></el-dialog
  >
</template>
