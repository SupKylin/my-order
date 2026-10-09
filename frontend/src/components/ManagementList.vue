<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { Delete, Refresh, Search } from '@element-plus/icons-vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api/http';
import { useAuth } from '../stores/auth';
import { useMeta } from '../stores/meta';

const props = defineProps({
  resource: { type: String, required: true },
  title: { type: String, required: true },
  kind: { type: String, default: '' },
  description: { type: String, default: '' },
  placeholder: { type: String, default: '输入关键词' },
});
const auth = useAuth();
const meta = useMeta();
const table = ref(null),
  rows = ref([]),
  total = ref(0),
  page = ref(1),
  pageSize = ref(20);
const loading = ref(false),
  deleting = ref(false),
  selected = ref([]);
const draft = reactive({ q: '', dates: [], active: '', role: '', status: '', enabled: '' });
let applied = {},
  requestVersion = 0;
const filters = computed(
  () =>
    ({
      users: [
        {
          key: 'role',
          label: '全部角色',
          options: [
            ['operations', '运营'],
            ['purchasing', '采购'],
            ['admin', '最高权限总账号'],
          ],
        },
        {
          key: 'active',
          label: '全部启用状态',
          options: [
            ['true', '启用'],
            ['false', '停用'],
          ],
        },
      ],
      stores: [
        {
          key: 'enabled',
          label: '全部同步状态',
          options: [
            ['true', '同步已开启'],
            ['false', '同步未开启'],
          ],
        },
      ],
      imports: [
        {
          key: 'status',
          label: '全部导入状态',
          options: [
            ['preview', '仅预览'],
            ['completed', '已导入'],
          ],
        },
      ],
      dictionaries: [
        {
          key: 'active',
          label: '全部使用状态',
          options: [
            ['true', '启用'],
            ['false', '停用'],
          ],
        },
      ],
    })[props.resource] || [],
);

async function refresh() {
  const version = ++requestVersion;
  loading.value = true;
  selected.value = [];
  table.value?.clearSelection();
  try {
    const result = await api.get(`/management/${props.resource}`, {
      params: {
        ...applied,
        kind: props.kind || undefined,
        page: page.value,
        pageSize: pageSize.value,
      },
    });
    if (version !== requestVersion) return;
    total.value = result.total;
    const lastPage = Math.max(1, Math.ceil(result.total / pageSize.value));
    if (page.value > lastPage) {
      page.value = lastPage;
      return await refresh();
    }
    rows.value = result.rows;
  } catch {
    // HTTP 拦截器已提示错误，清空旧列表，避免把旧筛选结果误当成本次查询结果。
    if (version === requestVersion) {
      rows.value = [];
      total.value = 0;
    }
  } finally {
    if (version === requestVersion) loading.value = false;
  }
}
function query() {
  applied = { q: draft.q.trim(), startDate: draft.dates?.[0], endDate: draft.dates?.[1] };
  for (const filter of filters.value) applied[filter.key] = draft[filter.key];
  page.value = 1;
  return refresh();
}
function reset() {
  Object.assign(draft, { q: '', dates: [], active: '', role: '', status: '', enabled: '' });
  return query();
}
function resizePage() {
  page.value = 1;
  refresh();
}
function selectable(row) {
  return props.resource !== 'users' || row.id !== auth.user?.id;
}
const deleteNote = computed(
  () =>
    ({
      stores:
        '将停止这些店铺的同步并删除店铺配置，已有订单和采购数据保留。正在同步的店铺不能删除。',
      templates: '仅删除模板，已有订单和采购数据保留。',
      imports: '仅删除导入记录，已导入的订单和采购数据保留；未提交的预览将无法继续提交。',
      users:
        '当前登录账号和最后一个启用的总账号不能删除。该账号绑定的店铺将变为未绑定，订单及采购渠道保留。',
      dictionaries: '已被模板绑定的选项不能删除。历史订单保留原名称。',
      'risk-addresses': '删除后匹配订单的地址风险标记将解除。',
    })[props.resource],
);
async function removeSelected() {
  if (!selected.value.length || deleting.value) return;
  // 确认框打开时固定本次删除对象，不受后续勾选变化影响。
  const targets = selected.value.map((row) => ({
    id: row.id,
    version: row.version,
    updatedAt: row.updatedAt,
  }));
  const resource = props.resource,
    kind = props.kind;
  deleting.value = true;
  try {
    try {
      await ElMessageBox.confirm(
        `确认删除已勾选的 ${targets.length} 条记录？${deleteNote.value}`,
        '批量删除',
        { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
    if (resource !== props.resource || kind !== props.kind) return;
    const result = await api.post(`/management/${resource}/batch-delete`, {
      rows: targets,
      kind: kind || undefined,
    });
    ElMessage.success(`已删除 ${result.deleted} 条记录`);
    if (['dictionaries', 'stores', 'users'].includes(resource)) await meta.publishChange();
    await refresh();
  } catch {
    // 服务端拒绝时保留数据并刷新版本，错误由 HTTP 拦截器显示。
    await refresh();
  } finally {
    deleting.value = false;
  }
}
watch(
  () => [props.resource, props.kind],
  () => {
    rows.value = [];
    reset();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  requestVersion += 1;
});
defineExpose({ refresh, total });
</script>

<template>
  <section class="panel management-panel">
    <div class="panel-heading">
      <h2>
        {{ title }} <span class="count-label">{{ total }} 条</span>
      </h2>
      <div class="button-row">
        <el-button :icon="Refresh" :loading="loading" :disabled="deleting" @click="refresh"
          >刷新</el-button
        >
        <el-button
          type="danger"
          plain
          :icon="Delete"
          :disabled="!selected.length || loading"
          :loading="deleting"
          @click="removeSelected"
          >批量删除</el-button
        >
        <slot name="actions" />
      </div>
    </div>
    <form class="management-filters" @submit.prevent="query">
      <el-input
        v-model="draft.q"
        class="management-keyword"
        :placeholder="placeholder"
        :prefix-icon="Search"
        maxlength="255"
        clearable
      />
      <el-select
        v-for="filter in filters"
        :key="filter.key"
        v-model="draft[filter.key]"
        :placeholder="filter.label"
        clearable
        :aria-label="filter.label"
      >
        <el-option
          v-for="[value, label] in filter.options"
          :key="value"
          :value="value"
          :label="label"
        />
      </el-select>
      <el-date-picker
        v-model="draft.dates"
        type="daterange"
        value-format="YYYY-MM-DD"
        start-placeholder="创建开始日期"
        end-placeholder="创建结束日期"
        range-separator="至"
        :unlink-panels="true"
      />
      <div class="button-row management-query-actions">
        <el-button
          type="primary"
          plain
          :icon="Search"
          native-type="submit"
          :disabled="deleting"
          :loading="loading"
          >查询</el-button
        >
        <el-button :disabled="deleting" @click="reset">重置</el-button>
      </div>
    </form>
    <div class="management-table-region">
      <el-table
        ref="table"
        v-loading="loading || deleting"
        :data="rows"
        height="100%"
        row-key="id"
        @selection-change="selected = $event"
      >
        <el-table-column type="selection" width="44" fixed="left" :selectable="selectable" />
        <slot />
        <template #empty><el-empty description="暂无符合条件的数据" :image-size="70" /></template>
      </el-table>
    </div>
    <div class="management-footer">
      <span class="muted"
        >{{ description
        }}<template v-if="selected.length"> 已勾选 {{ selected.length }} 条</template></span
      >
      <el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[20, 50, 100]"
        :pager-count="5"
        layout="total, sizes, prev, pager, next"
        :disabled="loading || deleting"
        @current-change="refresh"
        @size-change="resizePage"
      />
    </div>
  </section>
</template>
