<script setup>
import { computed, nextTick, ref } from 'vue';
import { UploadFilled } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { riskAddressApi } from '../api/riskAddresses';

const visible = defineModel({ type: Boolean });
const emit = defineEmits(['imported']);
const uploader = ref(null);
const file = ref(null),
  files = ref([]),
  busy = ref(false),
  result = ref(null),
  page = ref(1);
const skippedRows = computed(
  () => result.value?.details.slice((page.value - 1) * 20, page.value * 20) || [],
);
async function choose(upload) {
  if (!/\.xlsx$/i.test(upload.name) || upload.size > 10 * 1024 * 1024) {
    file.value = null;
    result.value = null;
    ElMessage.warning('请选择不超过 10 MB 的 .xlsx 文件');
    // 等上传组件同步完文件列表后清空，避免无效文件占用唯一上传名额。
    await nextTick();
    uploader.value?.clearFiles();
    return;
  }
  file.value = upload.raw;
  result.value = null;
}
async function submit() {
  if (busy.value || !file.value || result.value) return;
  busy.value = true;
  try {
    result.value = await riskAddressApi.importExcel(file.value);
    page.value = 1;
    ElMessage.success(`导入完成：新增 ${result.value.created} 条，跳过 ${result.value.skipped} 条`);
    emit('imported');
  } catch {
    // HTTP 拦截器已显示错误，保留文件以便用户修正或重试。
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <el-dialog
    v-model="visible"
    title="批量上传风险地址"
    width="min(1000px, 94vw)"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
  >
    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="使用下载模板填写，读取第一个工作表的第 1 行表头；地址一、城市、州、邮编必填。重复和无效行将跳过，已有信息保持不变。"
    />
    <el-upload
      ref="uploader"
      class="risk-import-upload"
      v-model:file-list="files"
      drag
      accept=".xlsx"
      :auto-upload="false"
      :limit="1"
      :disabled="busy"
      :on-change="choose"
      :on-remove="
        () => {
          file = null;
          result = null;
        }
      "
      :on-exceed="() => ElMessage.warning('请先移除原文件再选择新文件')"
    >
      <el-icon class="el-icon--upload"><UploadFilled /></el-icon>
      <div class="el-upload__text">将 Excel 拖到这里，或<em>点击选择</em></div>
      <template #tip
        ><div class="el-upload__tip">
          每次 1 个 .xlsx 文件，最多 1000 条地址，文件不超过 10 MB。邮编请按文本填写。
        </div></template
      >
    </el-upload>
    <template v-if="result">
      <el-alert
        :type="result.skipped ? 'warning' : 'success'"
        :closable="false"
        show-icon
        :title="`共 ${result.total} 条：新增 ${result.created} 条，重复 ${result.duplicate} 条，无效 ${result.invalid} 条`"
      />
      <el-table
        v-if="result.details.length"
        :data="skippedRows"
        max-height="320"
        class="risk-import-result"
      >
        <el-table-column prop="rowNumber" label="Excel 行号" width="95" />
        <el-table-column prop="address1" label="地址一" min-width="180" show-overflow-tooltip />
        <el-table-column prop="address2" label="地址二" min-width="120" show-overflow-tooltip />
        <el-table-column prop="city" label="城市" min-width="110" show-overflow-tooltip />
        <el-table-column prop="state" label="州" width="70" show-overflow-tooltip />
        <el-table-column prop="postalCode" label="邮编" width="100" />
        <el-table-column prop="reason" label="跳过原因" min-width="260" show-overflow-tooltip />
      </el-table>
      <el-pagination
        v-if="result.details.length"
        v-model:current-page="page"
        :total="result.details.length"
        :page-size="20"
        layout="total, prev, pager, next"
        class="risk-import-pagination"
      />
    </template>
    <template #footer>
      <el-button :disabled="busy" @click="visible = false">{{
        result ? '完成' : '取消'
      }}</el-button>
      <el-button type="primary" :loading="busy" :disabled="!file || !!result" @click="submit"
        >开始导入</el-button
      >
    </template>
  </el-dialog>
</template>
<style scoped>
.risk-import-upload,
.risk-import-result {
  margin-top: 16px;
}
.risk-import-upload {
  margin-bottom: 16px;
}
.risk-import-pagination {
  margin-top: 12px;
  justify-content: flex-end;
}
</style>
