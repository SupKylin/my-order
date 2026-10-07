<script setup>
import { UploadFilled } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { excelFileFromClipboard } from '../../utils/clipboardExcel';
const props = defineProps({ uploading: Boolean, upload: { type: Function, required: true } });
function pasteFile(event) {
  const file = excelFileFromClipboard(event);
  if (!file) return ElMessage.warning('剪贴板中没有 .xlsx 文件');
  event.preventDefault();
  props.upload({ file, onSuccess: () => {}, onError: () => {} });
}
</script>
<template>
  <div class="upload-stage" @paste="pasteFile">
    <el-upload
      drag
      accept=".xlsx"
      :show-file-list="false"
      :http-request="upload"
      :disabled="uploading"
      ><el-icon class="upload-icon"><UploadFilled /></el-icon>
      <h3>{{ uploading ? '正在读取文件与工作表…' : '拖拽 Excel 到这里，或点击选择文件' }}</h3>
      <p>支持 .xlsx，上传最大 2 GB；解压后内容最多 300 MB、最多 10000 行，可读取嵌入式图片。</p>
      <el-button type="primary" :loading="uploading">选择 Excel 文件</el-button></el-upload
    >
    <div class="upload-paste-row">
      <span>也可复制 Excel 文件后粘贴</span>
      <el-button :disabled="uploading" @click="$event.currentTarget.focus()">在此粘贴</el-button>
    </div>
    <div class="import-rule">
      <span class="rule-number">01</span>
      <div>
        <strong>按订单号、SKU、店铺名匹配</strong>
        <p>空值只匹配对应空值；多出的商品明细会新增。</p>
      </div>
    </div>
    <div class="import-rule">
      <span class="rule-number">02</span>
      <div>
        <strong>仅更新提供了内容的字段</strong>
        <p>未映射、缺少的列和空白单元格均保留原值。</p>
      </div>
    </div>
    <div class="import-rule">
      <span class="rule-number">03</span>
      <div>
        <strong>预览确认后才写入订单</strong>
        <p>发现错误时不会提交任何订单；请修正后重新预览。</p>
      </div>
    </div>
  </div>
</template>
