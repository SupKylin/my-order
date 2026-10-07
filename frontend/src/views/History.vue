<script setup>
import { ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { importApi } from '../api/imports';
import { fmtDate } from '../utils/format';
import { useMeta } from '../stores/meta';
import { useAuth } from '../stores/auth';
const rows = ref([]),
  busy = ref(false),
  details = ref(null),
  show = ref(false),
  committing = ref(false),
  auth = useAuth();
async function load() {
  busy.value = true;
  try {
    rows.value = await importApi.list();
  } finally {
    busy.value = false;
  }
}
async function view(row) {
  details.value = await importApi.get(row.id);
  details.value.createdBy = row.createdBy;
  show.value = true;
}
async function commit() {
  try {
    await ElMessageBox.confirm(
      '确认提交该预览？如果预览后商品发生变化，系统会要求重新预览。',
      '确认导入',
    );
    committing.value = true;
    const result = await importApi.commit(details.value.id);
    ElMessage.success(`已新增 ${result.added} 条，更新 ${result.updated} 条`);
    show.value = false;
    await load();
  } catch {
  } finally {
    committing.value = false;
  }
}
onMounted(async () => {
  await useMeta().load();
  await load();
});
</script>
<template>
  <section class="panel">
    <div class="panel-heading">
      <div>
        <h2>最近导入记录</h2>
        <p>显示最近 100 次预览与导入，预览有效期为 2 小时。</p>
      </div>
      <el-button @click="load">刷新</el-button>
    </div>
    <el-table v-loading="busy" :data="rows"
      ><el-table-column label="文件名" prop="filename" min-width="230" /><el-table-column
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
        ><template #default="{ row }">{{
          fmtDate(row.committedAt, true)
        }}</template></el-table-column
      ><el-table-column label="操作" width="100"
        ><template #default="{ row }"
          ><el-button link type="primary" @click="view(row)">查看详情</el-button></template
        ></el-table-column
      ><template #empty><el-empty description="暂无导入记录" :image-size="90" /></template
    ></el-table>
  </section>
  <el-dialog v-model="show" title="导入详情" width="760px"
    ><template v-if="details"
      ><el-descriptions :column="3" border
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
            prop="patch.walmartSku" /><el-table-column label="商品" prop="patch.productName" /></template
      ></el-table>
      <p class="muted">预览最多显示 100 条明细、200 个错误；完整有效数据会整体提交。</p></template
    ><template #footer
      ><el-button @click="show = false">关闭</el-button
      ><el-button
        v-if="
          details?.status === 'preview' &&
          !details?.errorCount &&
          details?.createdBy === auth.user?.id
        "
        type="primary"
        :loading="committing"
        @click="commit"
        >确认提交</el-button
      ></template
    ></el-dialog
  >
</template>
