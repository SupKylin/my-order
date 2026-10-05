<script setup>
import { defineAsyncComponent, ref, onMounted } from 'vue';
import { Plus, Document, Edit, Delete } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { templateApi } from '../api/templates';
import { fmtDate } from '../utils/format';
import { useMeta } from '../stores/meta';
import { selectedMappings } from '../mapping';
const TemplateEditor = defineAsyncComponent(() => import('../components/TemplateEditor.vue'));
const meta = useMeta(),
  rows = ref([]),
  busy = ref(false),
  dialog = ref(false),
  editing = ref(null);
async function load() {
  busy.value = true;
  try {
    rows.value = await templateApi.list();
  } finally {
    busy.value = false;
  }
}
function edit(row) {
  editing.value = row;
  dialog.value = true;
}
async function remove(row) {
  try {
    await ElMessageBox.confirm(`删除模板“${row.name}”？已导入的订单不受影响。`, '删除模板', {
      type: 'warning',
    });
    await templateApi.remove(row.id);
    ElMessage.success('模板已删除');
    await load();
  } catch {}
}
onMounted(async () => {
  await meta.load();
  await load();
});
</script>
<template>
  <section class="panel">
    <div class="panel-heading">
      <div>
        <h2>
          映射模板 <span class="count-label">{{ rows.length }} 个</span>
        </h2>
        <p>为不同 Excel 格式维护独立模板，支持工作表和表头行设置。</p>
      </div>
      <el-button type="primary" :icon="Plus" @click="edit(null)">创建模板</el-button>
    </div>
    <el-table v-loading="busy" :data="rows"
      ><el-table-column label="模板名称" min-width="220"
        ><template #default="{ row }"
          ><div class="template-name">
            <span class="template-icon"
              ><el-icon><Document /></el-icon></span
            ><strong>{{ row.name }}</strong>
          </div></template
        ></el-table-column
      ><el-table-column label="工作表" prop="sheetName" min-width="150" /><el-table-column
        label="表头行"
        prop="headerRow"
        width="90"
      /><el-table-column label="已映射字段" min-width="140"
        ><template #default="{ row }"
          >{{ selectedMappings(row.mappings).length }} 个字段</template
        ></el-table-column
      ><el-table-column label="绑定采购渠道" min-width="180"
        ><template #default="{ row }">{{
          row.purchaseChannelId
            ? meta.purchaseChannels.find((channel) => channel.id === row.purchaseChannelId)
                ?.value || '原渠道已停用'
            : '不绑定'
        }}</template></el-table-column
      ><el-table-column label="最后更新" min-width="185"
        ><template #default="{ row }">{{ fmtDate(row.updatedAt, true) }}</template></el-table-column
      ><el-table-column label="操作" width="180"
        ><template #default="{ row }"
          ><el-button link type="primary" :icon="Edit" @click="edit(row)">编辑</el-button
          ><el-button link type="danger" :icon="Delete" @click="remove(row)"
            >删除</el-button
          ></template
        ></el-table-column
      ><template #empty
        ><el-empty description="暂无导入模板，上传示例 Excel 创建第一份映射" :image-size="100"
          ><el-button type="primary" :icon="Plus" @click="edit(null)">创建模板</el-button></el-empty
        ></template
      ></el-table
    >
  </section>
  <div class="hint-strip">
    <el-icon><Document /></el-icon
    ><span
      >模板可绑定采购渠道。Excel
      非空渠道优先；空白或未映射时使用绑定渠道，其他未提供字段保留原值。</span
    >
  </div>
  <TemplateEditor v-if="dialog" v-model="dialog" :template="editing" @saved="load" />
</template>
