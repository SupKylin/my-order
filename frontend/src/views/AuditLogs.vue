<script setup>
import { computed, defineAsyncComponent, onMounted, ref } from 'vue';
import ManagementList from '../components/ManagementList.vue';
import { api } from '../api/http';
import { useAuth } from '../stores/auth';
import { useMeta } from '../stores/meta';
import { fmtDate } from '../utils/format';
import { auditActions as actions, auditResource } from '../utils/auditLabels';
const History = defineAsyncComponent(() => import('./History.vue'));
const auth = useAuth(),
  meta = useMeta();
const tab = ref('audit'),
  details = ref(null),
  show = ref(false),
  users = ref([]);
const filters = computed(() => [
  { key: 'action', label: '全部操作类型', options: Object.entries(actions) },
  ...(auth.user?.role === 'admin'
    ? [
        {
          key: 'userId',
          label: '全部操作账号',
          options: users.value.map((user) => [
            String(user.id),
            `${user.displayName}（${user.username}）`,
          ]),
        },
      ]
    : []),
]);
const changes = computed(() =>
  Object.entries(details.value?.details?.changes || {}).map(([key, value]) => ({
    field:
      meta.fieldMap[key]?.label ||
      {
        displayName: '姓名',
        role: '角色',
        ownerId: '店铺所属账号',
        systemStoreName: '系统店铺名',
        walmartStoreName: 'Walmart店铺名',
        active: '启用状态',
        value: '选项名称',
        name: '名称',
        mappings: '映射关系',
      }[key] ||
      key,
    before: text(value.before),
    after: text(value.after),
  })),
);
function text(value) {
  return value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
}
const summary = computed(() => {
  const { changes: _, ...rest } = details.value?.details || {};
  return JSON.stringify(rest, null, 2);
});
async function view(row) {
  details.value = await api.get(`/audit-logs/${row.id}`);
  show.value = true;
}
onMounted(async () => {
  if (auth.user?.role === 'admin') users.value = await api.get('/users');
});
</script>

<template>
  <div class="audit-page">
    <div class="button-row audit-tabs">
      <el-button :type="tab === 'audit' ? 'primary' : 'default'" @click="tab = 'audit'"
        >操作日志</el-button
      >
      <el-button :type="tab === 'imports' ? 'primary' : 'default'" @click="tab = 'imports'"
        >导入结果</el-button
      >
    </div>
    <ManagementList
      v-if="tab === 'audit'"
      resource="audit-logs"
      title="操作日志"
      :deletable="false"
      :extra-filters="filters"
      placeholder="搜索对象ID或操作代码"
      description="仅保留最近两个月；日志自动生成，只读。普通账号仅查看自己的操作。"
    >
      <el-table-column label="操作时间" min-width="175"
        ><template #default="{ row }">{{ fmtDate(row.createdAt, true) }}</template></el-table-column
      >
      <el-table-column label="操作人" min-width="150"
        ><template #default="{ row }"
          >{{ row.actor?.displayName
          }}<small class="muted"> {{ row.actor?.username }}</small></template
        ></el-table-column
      >
      <el-table-column label="操作类型" min-width="150"
        ><template #default="{ row }">{{
          actions[row.action] || row.action
        }}</template></el-table-column
      >
      <el-table-column label="操作模块" min-width="160" show-overflow-tooltip
        ><template #default="{ row }">{{ auditResource(row.resource) }}</template></el-table-column
      >
      <el-table-column prop="entityId" label="对象ID" min-width="130" show-overflow-tooltip />
      <el-table-column label="结果" width="100"
        ><template #default="{ row }"
          ><el-tag :type="row.status >= 400 ? 'danger' : 'success'">{{
            row.status >= 400 ? '失败/拒绝' : '成功'
          }}</el-tag></template
        ></el-table-column
      >
      <el-table-column label="详情" width="90" fixed="right"
        ><template #default="{ row }"
          ><el-button link type="primary" @click="view(row)">查看</el-button></template
        ></el-table-column
      >
    </ManagementList>
    <History v-else />
    <el-dialog v-model="show" title="操作详情（只读）" width="900px" destroy-on-close>
      <template v-if="details">
        <p>
          {{ actions[details.action] || details.action }} · {{ fmtDate(details.createdAt, true) }}
        </p>
        <el-table v-if="changes.length" :data="changes" max-height="380">
          <el-table-column prop="field" label="字段" width="170" />
          <el-table-column prop="before" label="修改前" min-width="220" />
          <el-table-column prop="after" label="修改后" min-width="220" />
        </el-table>
        <el-descriptions :column="2">
          <el-descriptions-item label="操作账号">{{
            details.details?.actor?.displayName || details.userId
          }}</el-descriptions-item>
          <el-descriptions-item label="记录编号">{{
            details.entityId || '—'
          }}</el-descriptions-item>
          <el-descriptions-item label="操作模块">{{
            auditResource(details.details?.resource || details.details?.path)
          }}</el-descriptions-item>
          <el-descriptions-item label="执行结果">{{
            details.details?.status >= 400 ? '失败/拒绝' : '成功'
          }}</el-descriptions-item>
        </el-descriptions>
        <el-collapse
          ><el-collapse-item title="查看筛选条件及完整记录">
            <pre class="audit-summary">{{ summary }}</pre>
          </el-collapse-item></el-collapse
        >
      </template>
      <template #footer><el-button @click="show = false">关闭</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.audit-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: 12px;
}
.audit-tabs {
  flex-shrink: 0;
}
.audit-summary {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 16px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  line-height: 1.7;
}
</style>
