<script setup>
import ManagementList from '../components/ManagementList.vue';
import { defineAsyncComponent, ref, onMounted } from 'vue';
import { Plus, Document, Edit } from '@element-plus/icons-vue';
import { fmtDate } from '../utils/format';
import { useMeta } from '../stores/meta';
import { selectedMappings } from '../mapping';
const list = ref(null);
const TemplateEditor = defineAsyncComponent(() => import('../components/TemplateEditor.vue'));
const meta = useMeta(),
  dialog = ref(false),
  editing = ref(null);
async function load() {
  await list.value?.refresh();
}
function edit(row) {
  editing.value = row;
  dialog.value = true;
}
onMounted(async () => {
  await meta.load();
});
</script>
<template>
  <ManagementList
    ref="list"
    resource="templates"
    title="导入模板"
    placeholder="搜索模板名称、工作表"
    description="绑定渠道用于 Excel 未提供渠道时；未映射字段保留原值。"
  >
    <template #actions
      ><el-button type="primary" :icon="Plus" @click="edit(null)">创建模板</el-button></template
    >
    <el-table-column label="模板名称" min-width="220"
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
          ? meta.purchaseChannels.find((channel) => channel.id === row.purchaseChannelId)?.value ||
            '原渠道已停用'
          : '不绑定'
      }}</template></el-table-column
    ><el-table-column label="最后更新" min-width="185"
      ><template #default="{ row }">{{ fmtDate(row.updatedAt, true) }}</template></el-table-column
    ><el-table-column label="操作" width="180" fixed="right"
      ><template #default="{ row }"
        ><el-button link type="primary" :icon="Edit" @click="edit(row)">编辑</el-button></template
      ></el-table-column
    >
  </ManagementList>
  <TemplateEditor v-if="dialog" v-model="dialog" :template="editing" @saved="load" />
</template>
