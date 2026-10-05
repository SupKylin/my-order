<script setup>
import { Check } from '@element-plus/icons-vue';
import { useMeta } from '../../stores/meta';
defineProps({ preview: { type: Object, required: true }, busy: Boolean });
const emit = defineEmits(['back', 'reset', 'commit']);
const meta = useMeta();
</script>
<template>
  <div class="preview-stage">
    <el-alert
      v-if="preview.purchaseChannel"
      :closable="false"
      type="info"
      :title="`模板绑定渠道：${preview.purchaseChannel}。Excel 非空渠道优先，空白或未映射时使用模板渠道。`"
    />
    <div class="preview-stats">
      <div>
        <span>新增商品明细</span><strong class="success-text">{{ preview.added }}</strong>
      </div>
      <div>
        <span>更新已有明细</span><strong>{{ preview.updated }}</strong>
      </div>
      <div>
        <span>校验错误</span
        ><strong :class="preview.errorCount ? 'danger-text' : 'success-text'">{{
          preview.errorCount
        }}</strong>
      </div>
    </div>
    <el-alert
      v-if="preview.errorCount"
      :title="`存在 ${preview.errorCount} 个错误，整批尚未写入订单。请修正后重新上传。`"
      type="error"
      show-icon
      :closable="false"
    /><el-alert
      v-else
      title="预览通过。优先按订单号＋采购渠道匹配，再按订单号匹配剩余的无渠道旧明细。重复行按文件出现顺序更新（旧明细按创建顺序），每条旧明细只更新一次；多出行新增，原有多出明细保留。仅更新非空的已映射字段。"
      type="success"
      show-icon
      :closable="false"
    /><el-table
      v-if="preview.errors.length"
      :data="preview.errors"
      max-height="220"
      class="errors-table"
      ><el-table-column label="Excel 行" prop="row" width="90" /><el-table-column
        label="字段"
        prop="label"
        width="150" /><el-table-column label="错误原因" prop="message" /></el-table
    ><el-alert
      v-for="(warning, index) in preview.warnings"
      :key="index"
      :title="`第 ${warning.row} 行：${warning.message}`"
      type="warning"
      :closable="false"
      class="warning-row"
    />
    <div class="preview-heading">
      <h3>商品明细预览</h3>
      <span class="muted">共 {{ preview.total }} 条，显示前 {{ preview.previewLimit }} 条</span>
    </div>
    <el-table :data="preview.rows" max-height="400"
      ><el-table-column label="Excel 行" prop="rowNumber" width="90" /><el-table-column
        label="操作"
        width="90"
        ><template #default="{ row }"
          ><el-tag :type="row.action === 'create' ? 'success' : 'warning'">{{
            row.action === 'create' ? '新增' : '更新'
          }}</el-tag></template
        ></el-table-column
      ><el-table-column label="订单号" prop="patch.orderNumber" min-width="170" /><el-table-column
        label="SKU"
        prop="patch.sku"
        min-width="145"
      /><el-table-column
        label="商品名称"
        prop="patch.productName"
        min-width="200"
      /><el-table-column label="采购渠道" min-width="180"
        ><template #default="{ row }">{{
          Array.isArray(row.patch.purchaseChannel)
            ? row.patch.purchaseChannel.join(' / ')
            : row.patch.purchaseChannel || '—'
        }}</template></el-table-column
      ><el-table-column label="图片" width="80"
        ><template #default="{ row }"
          ><el-image
            v-if="row.patch.productImage"
            :src="meta.imageUrl(row.patch.productImage, true)"
            :preview-src-list="[meta.imageUrl(row.patch.productImage)]"
            class="tiny-image"
            fit="contain"
            preview-teleported
          /><span v-else>—</span></template
        ></el-table-column
      ><el-table-column label="更新字段" min-width="240"
        ><template #default="{ row }"
          ><el-tooltip
            :content="
              Object.keys(row.patch)
                .map((k) => meta.fieldMap[k]?.label)
                .join('、')
            "
            ><span>{{ Object.keys(row.patch).length }} 个非空字段</span></el-tooltip
          ></template
        ></el-table-column
      ></el-table
    >
    <div class="stage-actions">
      <el-button @click="emit('back')">返回调整映射</el-button
      ><el-button v-if="preview.errorCount" @click="emit('reset')" type="primary"
        >重新上传文件</el-button
      ><el-button v-else type="primary" :loading="busy" :icon="Check" @click="emit('commit')"
        >确认导入 {{ preview.total }} 条</el-button
      >
    </div>
  </div>
</template>
