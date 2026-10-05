<script setup>
import { defineAsyncComponent } from 'vue';
import { useRouter } from 'vue-router';
import { ArrowRight, Document } from '@element-plus/icons-vue';
import MappingEditor from '../components/MappingEditor.vue';
import ChannelBinding from '../components/ChannelBinding.vue';
import ImportUpload from '../components/imports/ImportUpload.vue';
import { useOrderImport } from '../composables/useOrderImport';
const ImportPreview = defineAsyncComponent(() => import('../components/imports/ImportPreview.vue'));
const router = useRouter();
const {
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
} = useOrderImport();
</script>
<template>
  <section class="panel import-panel">
    <el-steps :active="step" finish-status="success" class="import-steps" align-center
      ><el-step title="上传文件" description="选择每日订单 Excel" /><el-step
        title="映射字段"
        description="使用模板或配置映射" /><el-step
        title="预览确认"
        description="检查新增、更新与错误" /><el-step
        title="导入完成"
        description="同步至订单工作台"
    /></el-steps>
    <ImportUpload v-if="step === 0" :uploading="uploading" :upload="upload" />
    <div v-else-if="step === 1" class="mapping-stage" v-loading="uploading">
      <div class="file-banner">
        <el-icon :size="24"><Document /></el-icon>
        <div>
          <strong>{{ file.name }}</strong
          ><span>{{ info?.sheets?.length || 0 }} 个工作表</span>
        </div>
        <el-button text @click="reset">更换文件</el-button>
      </div>
      <el-form label-position="top"
        ><div class="template-controls">
          <el-form-item label="导入模板" class="flex-one"
            ><el-select
              v-model="templateId"
              clearable
              filterable
              placeholder="自动识别 / 自定义映射"
              @change="chooseTemplate"
              ><el-option
                v-for="item in templates"
                :key="item.id"
                :label="item.name"
                :value="item.id" /></el-select></el-form-item
          ><el-form-item label="工作表"
            ><el-select
              v-model="form.sheetName"
              @change="
                templateId = null;
                inspect();
              "
              ><el-option
                v-for="sheet in file.sheets"
                :key="sheet.name"
                :value="sheet.name"
                :label="sheet.name" /></el-select></el-form-item
          ><el-form-item label="表头所在行"
            ><el-input-number
              v-model="form.headerRow"
              :min="1"
              :max="100"
              @change="
                templateId = null;
                inspect();
              "
          /></el-form-item>
        </div>
        <ChannelBinding v-model="form.purchaseChannelId" :disabled="busy || uploading" /> </el-form
      ><MappingEditor :info="info" v-model="form.mappings" :disabled="busy || uploading" />
      <div class="stage-actions">
        <el-button @click="saveTemplate">保存当前映射为模板</el-button
        ><el-button type="primary" :loading="busy" @click="makePreview"
          >生成导入预览<el-icon class="el-icon--right"><ArrowRight /></el-icon
        ></el-button>
      </div>
    </div>
    <ImportPreview
      v-else-if="step === 2"
      :preview="preview"
      :busy="busy"
      @back="step = 1"
      @reset="reset"
      @commit="commit"
    />
    <div v-else class="success-stage">
      <el-result
        icon="success"
        title="导入完成"
        :sub-title="`新增 ${result.added} 条商品明细，更新 ${result.updated} 条商品明细。`"
        ><template #extra
          ><el-button @click="reset">继续导入</el-button
          ><el-button type="primary" @click="router.push('/orders')">查看订单</el-button></template
        ></el-result
      >
      <p>未提供的字段与空白单元格均已保留原值。</p>
    </div>
  </section>
</template>
