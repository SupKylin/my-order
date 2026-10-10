<script setup>
import ManagementList from '../components/ManagementList.vue';
import { defineAsyncComponent, ref } from 'vue';
import { Plus, Document, Edit } from '@element-plus/icons-vue';
import { fmtDate } from '../utils/format';
import { selectedMappings } from '../mapping';
const list = ref(null);
const TemplateEditor = defineAsyncComponent(() => import('../components/TemplateEditor.vue'));
const dialog = ref(false),
  editing = ref(null);
async function load() {
  await list.value?.refresh();
}
function edit(row) {
  editing.value = row;
  dialog.value = true;
}
</script>
<template>
  <ManagementList
    ref="list"
    resource="templates"
    title="导入模板"
    placeholder="搜索模板名称"
    description="导入时选择工作表；采购渠道不参与导入，未映射字段保留原值。"
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
    ><el-table-column label="表头行" prop="headerRow" width="90" /><el-table-column
      label="已映射字段"
      min-width="140"
      ><template #default="{ row }"
        >{{
          selectedMappings(row.mappings).filter((mapping) => mapping.field !== 'purchaseChannel')
            .length
        }}
        个字段</template
      ></el-table-column
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
