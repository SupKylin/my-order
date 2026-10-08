<script setup>
import { computed, defineAsyncComponent, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Plus, Delete, UploadFilled } from '@element-plus/icons-vue';
import { useMeta } from '../stores/meta';
import { templateApi } from '../api/templates';
import { uploadApi } from '../api/uploads';
import { importApi } from '../api/imports';
import { excelFileFromClipboard } from '../utils/clipboardExcel';

const ImportPreview = defineAsyncComponent(() => import('../components/imports/ImportPreview.vue'));
const SkippedImportRows = defineAsyncComponent(
  () => import('../components/imports/SkippedImportRows.vue'),
);
const router = useRouter();
const meta = useMeta();
let nextZoneId = 0;
const newZone = () => ({ id: ++nextZoneId, templateId: null, file: null, uploading: false });
const zones = ref([newZone()]);
const templates = ref([]);
const stage = ref('upload');
const busy = ref(false);
const preview = ref(null);
const result = ref(null);
function canImportPurchase(template) {
  const fields = template.mappings
    .filter((mapping) => mapping.field)
    .map((mapping) => mapping.field);
  return (
    ['orderNumber', 'shopName', 'walmartSku'].every((key) => fields.includes(key)) &&
    fields.some((key) => meta.fieldMap[key]?.group === 'purchase')
  );
}
const purchaseTemplates = computed(() => templates.value.filter(canImportPurchase));
const readyCount = computed(
  () => zones.value.filter((zone) => zone.file && selectedTemplate(zone)).length,
);

onMounted(async () => {
  await meta.load();
  templates.value = await templateApi.list();
});
function selectedTemplate(zone) {
  return purchaseTemplates.value.find((template) => template.id === zone.templateId);
}
function purchaseTemplate(zone) {
  const template = selectedTemplate(zone);
  return {
    ...template,
    mappings: template.mappings.filter(
      (mapping) =>
        !mapping.field ||
        ['orderNumber', 'walmartSku', 'shopName'].includes(mapping.field) ||
        meta.fieldMap[mapping.field]?.group === 'purchase',
    ),
  };
}
function channelName(zone) {
  const id = selectedTemplate(zone)?.purchaseChannelId;
  return meta.purchaseChannels.find((channel) => channel.id === id)?.value || '按 Excel 内容导入';
}
async function uploadFile(zone, file) {
  if (!/\.xlsx$/i.test(file.name)) return ElMessage.warning('仅支持 .xlsx 文件');
  zone.uploading = true;
  try {
    zone.file = await uploadApi.excel(file);
    if (
      selectedTemplate(zone) &&
      !zone.file.sheets.some((sheet) => sheet.name === selectedTemplate(zone).sheetName)
    )
      ElMessage.warning(`${zone.file.name} 中没有模板指定的工作表`);
    return zone.file;
  } finally {
    zone.uploading = false;
  }
}
async function uploadZone(zone, options) {
  try {
    const file = await uploadFile(zone, options.file);
    if (file) options.onSuccess(file);
  } catch (error) {
    options.onError(error);
  }
}
async function pasteZone(event, zone) {
  const file = excelFileFromClipboard(event);
  if (!file) return ElMessage.warning('剪贴板中没有 .xlsx 文件');
  event.preventDefault();
  await uploadFile(zone, file);
}
async function previewSources(selectedZones) {
  if (selectedZones.some((zone) => !zone.file || !selectedTemplate(zone) || zone.uploading))
    return ElMessage.warning('请先选择模板并上传文件');
  if (new Set(selectedZones.map((zone) => zone.file.id)).size !== selectedZones.length)
    return ElMessage.warning('同一文件不能在多个上传区重复导入');
  busy.value = true;
  try {
    preview.value = await importApi.previewPurchases(
      selectedZones.map((zone) => ({ uploadId: zone.file.id, template: purchaseTemplate(zone) })),
    );
    stage.value = 'preview';
  } finally {
    busy.value = false;
  }
}
function previewAll() {
  if (readyCount.value !== zones.value.length)
    return ElMessage.warning('请为每个上传区选择模板和文件');
  return previewSources(zones.value);
}
async function commit() {
  busy.value = true;
  try {
    result.value = await importApi.commitPurchases(preview.value.id);
    stage.value = 'done';
    ElMessage.success('采购导入完成');
  } finally {
    busy.value = false;
  }
}
function reset() {
  zones.value = [newZone()];
  preview.value = null;
  result.value = null;
  stage.value = 'upload';
}
</script>

<template>
  <section v-if="stage === 'upload'" class="purchase-import-page">
    <el-alert
      title="按系统店铺名＋客户订单号＋Walmart SKU 匹配，仅更新唯一匹配的已有明细；未匹配或有重复明细的行跳过，并在结果中列出。"
      type="info"
      :closable="false"
      show-icon
    />
    <div class="purchase-upload-summary">
      <div class="purchase-upload-heading">
        <h2>
          文件上传 <span class="count-label">{{ zones.length }} / 10</span>
        </h2>
        <el-button
          :icon="Plus"
          type="primary"
          :disabled="zones.length >= 10 || busy"
          @click="zones.push(newZone())"
          >添加上传区</el-button
        >
      </div>
      <div class="purchase-upload-actions">
        <el-button
          type="primary"
          :loading="busy"
          :disabled="readyCount !== zones.length || zones.some((zone) => zone.uploading)"
          @click="previewAll"
          >全部上传并预览（{{ readyCount }} 份）</el-button
        >
      </div>
    </div>
    <section
      v-for="(zone, index) in zones"
      :key="zone.id"
      class="purchase-upload-zone"
      @paste="pasteZone($event, zone)"
    >
      <div class="purchase-zone-heading">
        <h3>上传区 {{ index + 1 }}</h3>
        <el-button
          v-if="zones.length > 1"
          text
          type="danger"
          :icon="Delete"
          aria-label="移除上传区"
          @click="zones.splice(index, 1)"
        />
      </div>
      <label class="purchase-zone-label">本区使用的模板</label>
      <el-select
        v-model="zone.templateId"
        class="purchase-template-select"
        placeholder="选择导入模板"
        filterable
      >
        <el-option
          v-for="template in templates"
          :key="template.id"
          :value="template.id"
          :label="
            canImportPurchase(template)
              ? template.name
              : `${template.name}（需映射三项匹配字段及采购字段）`
          "
          :disabled="!canImportPurchase(template)"
        />
      </el-select>
      <div v-if="selectedTemplate(zone)" class="purchase-template-detail">
        <strong>{{ selectedTemplate(zone).name }}</strong>
        <span
          >采购渠道：{{ channelName(zone) }} · {{ selectedTemplate(zone).sheetName }} · 表头第
          {{ selectedTemplate(zone).headerRow }} 行</span
        >
      </div>
      <el-upload
        drag
        accept=".xlsx"
        :show-file-list="false"
        :disabled="zone.uploading"
        :http-request="(options) => uploadZone(zone, options)"
        class="purchase-zone-upload"
      >
        <el-icon class="upload-icon"><UploadFilled /></el-icon>
        <h3>{{ zone.file ? zone.file.name : '将 Excel 文件拖到这里' }}</h3>
        <p>或点击选择文件</p>
      </el-upload>
      <div class="purchase-zone-footer">
        <span>{{
          zone.file ? `${zone.file.sheets.length} 个工作表` : '仅支持 .xlsx，每区 1 个文件'
        }}</span>
        <el-button :disabled="zone.uploading" @click="$event.currentTarget.focus()"
          >在此粘贴</el-button
        >
      </div>
      <div class="purchase-zone-actions">
        <el-button
          type="primary"
          :loading="busy"
          :disabled="!zone.file || !zone.templateId || zone.uploading"
          @click="previewSources([zone])"
          >上传并预览</el-button
        >
        <el-button :disabled="zone.uploading" @click="zone.file = null">更换文件</el-button>
      </div>
    </section>
    <el-empty
      v-if="!purchaseTemplates.length"
      description="暂无可用模板，请映射店铺名、订单号、Walmart SKU 及采购字段"
    >
      <el-button type="primary" @click="router.push('/templates')">前往导入模板</el-button>
    </el-empty>
  </section>
  <section v-else class="panel import-panel">
    <ImportPreview
      v-if="stage === 'preview'"
      :preview="preview"
      :busy="busy"
      kind="purchase"
      @back="stage = 'upload'"
      @reset="stage = 'upload'"
      @commit="commit"
    />
    <div v-else class="success-stage">
      <el-result
        icon="success"
        title="采购导入完成"
        :sub-title="`已处理 ${result.updated} 行更新，跳过 ${result.skipped} 行，未新增订单。`"
      >
        <template #extra>
          <el-button @click="reset">继续导入</el-button>
          <el-button type="primary" @click="router.push('/orders')">查看订单</el-button>
        </template>
      </el-result>
      <SkippedImportRows :rows="result.skippedRows" />
    </div>
  </section>
</template>
