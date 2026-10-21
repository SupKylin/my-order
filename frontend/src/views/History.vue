<script setup>
import ManagementList from '../components/ManagementList.vue';
import { ref, onMounted, defineAsyncComponent } from 'vue';
import { importApi } from '../api/imports';
import { fmtDate } from '../utils/format';
import { useMeta } from '../stores/meta';
const list = ref(null);
const SkippedImportRows = defineAsyncComponent(
  () => import('../components/imports/SkippedImportRows.vue'),
);
const details = ref(null),
  show = ref(false);
const viewing = ref(null);
async function view(row) {
  if (viewing.value !== null) return;
  viewing.value = row.id;
  try {
    details.value = await importApi.get(row.id);
    details.value.createdBy = row.createdBy;
    show.value = true;
  } finally {
    viewing.value = null;
  }
}
onMounted(async () => {
  await useMeta().load();
});
</script>
<template>
  <ManagementList
    ref="list"
    resource="imports"
    title="导入结果"
    :deletable="false"
    placeholder="搜索导入文件名"
    description="只读查看导入结果；普通账号仅查看自己的记录。提交请在导入采购页面完成。"
  >
    <el-table-column label="文件名" prop="filename" min-width="230" /><el-table-column
      label="状态"
      width="110"
      ><template #default="{ row }"
        ><el-tag :type="row.status === 'completed' ? 'success' : 'info'">{{
          row.status === 'completed' ? '已导入' : '仅预览'
        }}</el-tag></template
      ></el-table-column
    ><el-table-column label="新增" width="85"
      ><template #default="{ row }">{{
        row.status === 'completed' ? row.added : '—'
      }}</template></el-table-column
    ><el-table-column label="更新" width="85"
      ><template #default="{ row }">{{
        row.status === 'completed' ? row.updated : '—'
      }}</template></el-table-column
    ><el-table-column label="预览时间" min-width="180"
      ><template #default="{ row }">{{ fmtDate(row.createdAt, true) }}</template></el-table-column
    ><el-table-column label="提交时间" min-width="180"
      ><template #default="{ row }">{{ fmtDate(row.committedAt, true) }}</template></el-table-column
    ><el-table-column label="操作" width="100" fixed="right"
      ><template #default="{ row }"
        ><el-button
          link
          type="primary"
          :loading="viewing === row.id"
          :disabled="viewing !== null && viewing !== row.id"
          @click="view(row)"
          >查看详情</el-button
        ></template
      ></el-table-column
    >
  </ManagementList>
  <el-dialog v-model="show" title="导入详情" width="760px"
    ><template v-if="details"
      ><SkippedImportRows :rows="details.skippedRows" /><el-descriptions :column="3" border
        ><el-descriptions-item label="新增">{{ details.added }}</el-descriptions-item
        ><el-descriptions-item label="更新">{{ details.updated }}</el-descriptions-item
        ><el-descriptions-item label="错误">{{
          details.errorCount
        }}</el-descriptions-item></el-descriptions
      ><el-table :data="details.errors.length ? details.errors : details.rows"
        ><el-table-column label="行" width="70"
          ><template #default="{ row }">{{ row.row || row.rowNumber }}</template></el-table-column
        ><el-table-column v-if="details.errors.length" label="错误原因" prop="message" /><template
          v-else
          ><el-table-column label="订单号" prop="patch.orderNumber" /><el-table-column
            label="WalmartSku"
            prop="patch.walmartSku" /><el-table-column
            label="商品"
            prop="patch.productName" /></template
      ></el-table>
      <p class="muted">
        预览最多显示 100 条明细、200
        个错误；跳过清单可翻页查看全部。采购导入仅更新唯一匹配的已有明细。
      </p></template
    ><template #footer><el-button @click="show = false">关闭</el-button></template></el-dialog
  >
</template>
