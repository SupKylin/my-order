<script setup>
import { UploadFilled } from '@element-plus/icons-vue';
defineProps({ uploading: Boolean, upload: { type: Function, required: true } });
</script>
<template>
  <div class="upload-stage">
    <el-upload
      drag
      accept=".xlsx"
      :show-file-list="false"
      :http-request="upload"
      :disabled="uploading"
      ><el-icon class="upload-icon"><UploadFilled /></el-icon>
      <h3>{{ uploading ? '正在读取文件与工作表…' : '拖拽 Excel 到这里，或点击选择文件' }}</h3>
      <p>支持 .xlsx，最大 50 MB；可读取嵌入式图片。</p>
      <el-button type="primary" :loading="uploading">选择 Excel 文件</el-button></el-upload
    >
    <div class="import-rule">
      <span class="rule-number">01</span>
      <div>
        <strong>同订单同渠道优先匹配，无渠道旧明细按订单号匹配</strong>
        <p>同订单不同渠道分别保存。多选渠道按完整组合匹配，SKU 可留空或不映射。</p>
      </div>
    </div>
    <div class="import-rule">
      <span class="rule-number">02</span>
      <div>
        <strong>仅更新提供了内容的字段</strong>
        <p>未映射、缺少的列和空白单元格均保留原值，采购字段也遵循此规则。</p>
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
