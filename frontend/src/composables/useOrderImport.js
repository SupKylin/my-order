import { ref, reactive, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { templateApi } from '../api/templates';
import { uploadApi } from '../api/uploads';
import { importApi } from '../api/imports';
import { useMeta } from '../stores/meta';
import { alignMappings, suggestedMappings, mappingIssues, selectedMappings } from '../mapping';

/** 管理上传、映射、预览、提交四个阶段的独立状态。 */
export function useOrderImport() {
  const meta = useMeta(),
    busy = ref(false),
    uploading = ref(false),
    step = ref(0),
    file = ref(null),
    info = ref(null),
    templates = ref([]),
    templateId = ref(null),
    preview = ref(null),
    result = ref(null);
  const form = reactive({
    name: '临时导入映射',
    sheetName: '',
    headerRow: 1,
    mappings: [],
    purchaseChannelId: null,
  });
  onMounted(async () => {
    await meta.load();
    templates.value = await templateApi.list();
  });
  async function upload(options) {
    uploading.value = true;
    try {
      const response = await uploadApi.excel(options.file);
      file.value = response;
      info.value = response;
      form.sheetName = response.sheetName;
      form.headerRow = 1;
      form.mappings = suggestedMappings(response.columns);
      step.value = 1;
      if (templateId.value) await chooseTemplate();
      options.onSuccess(response);
    } catch (e) {
      options.onError(e);
    } finally {
      uploading.value = false;
    }
  }
  async function inspect() {
    if (!file.value) return;
    busy.value = true;
    try {
      info.value = await uploadApi.inspect(file.value.id, form.sheetName, form.headerRow);
      if (!templateId.value) form.mappings = suggestedMappings(info.value.columns);
    } finally {
      busy.value = false;
    }
  }
  async function chooseTemplate() {
    const found = templates.value.find((t) => t.id === templateId.value);
    if (found) {
      Object.assign(form, {
        name: found.name,
        sheetName: found.sheetName,
        headerRow: found.headerRow,
        mappings: JSON.parse(JSON.stringify(found.mappings)),
        purchaseChannelId: found.purchaseChannelId ?? null,
      });
      if (file.value) {
        await inspect();
        const aligned = alignMappings(form.mappings, info.value.columns);
        form.mappings = aligned.mappings;
        if (aligned.missing.length)
          ElMessage.warning(
            `本文件缺少或无法唯一匹配：${aligned.missing.map((m) => m.header).join('、')}。可选字段将保留原值，请确认订单号已映射。`,
          );
      }
    } else if (info.value) {
      form.mappings = suggestedMappings(info.value.columns);
      form.name = '临时导入映射';
      form.purchaseChannelId = null;
    }
  }
  async function saveTemplate() {
    const issues = mappingIssues(form.mappings, meta.fields);
    if (issues.length) return ElMessage.warning(issues[0].message);
    try {
      const { value } = await ElMessageBox.prompt(
        '为当前字段映射命名，下次即可直接选择。',
        '保存为模板',
        {
          inputPlaceholder: '例如：店铺 A 日常订单',
          inputValidator: (v) => !!v?.trim() || '请输入模板名称',
        },
      );
      const saved = await templateApi.create({
        ...form,
        mappings: form.mappings,
        name: value.trim(),
      });
      templates.value = await templateApi.list();
      templateId.value = saved.id;
      form.name = saved.name;
      ElMessage.success('模板已保存');
    } catch {}
  }
  /** 预览只保存校验快照；用户确认 commit 后才写入订单。 */
  async function makePreview() {
    const issues = mappingIssues(form.mappings, meta.fields);
    if (issues.length) return ElMessage.warning(issues[0].message);
    busy.value = true;
    try {
      preview.value = await importApi.preview(file.value.id, {
        ...form,
        mappings: selectedMappings(form.mappings),
      });
      step.value = 2;
    } finally {
      busy.value = false;
    }
  }
  async function commit() {
    busy.value = true;
    try {
      result.value = await importApi.commit(preview.value.id);
      step.value = 3;
      ElMessage.success('订单导入完成');
    } finally {
      busy.value = false;
    }
  }
  function reset() {
    step.value = 0;
    file.value = null;
    info.value = null;
    preview.value = null;
    result.value = null;
    templateId.value = null;
    Object.assign(form, {
      name: '临时导入映射',
      sheetName: '',
      headerRow: 1,
      mappings: [],
      purchaseChannelId: null,
    });
  }

  return {
    busy,
    uploading,
    step,
    file,
    info,
    templates,
    templateId,
    preview,
    result,
    form,
    upload,
    inspect,
    chooseTemplate,
    saveTemplate,
    makePreview,
    commit,
    reset,
  };
}
