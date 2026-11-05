<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { afterSalesApi } from '../api/purchase-after-sales';
import { useAuth } from '../stores/auth';
import { useMeta } from '../stores/meta';
import { fmtDate, fmtBeijingDate } from '../utils/format';
import AfterSaleComposer from '../components/orders/AfterSaleComposer.vue';
import StoreOwnerSelect from '../components/home/StoreOwnerSelect.vue';

const route = useRoute(),
  router = useRouter(),
  auth = useAuth(),
  meta = useMeta();
const draft = reactive({
  q: '',
  status: '',
  supplierFeedback: '',
  shopNames: [],
  dates: [],
  ownerId: null,
  purchaseChannel: [],
  purchaseStatus: [],
});
const stores = ref([]),
  optionsLoading = ref(false),
  openCount = ref(null),
  unfeedbackCount = ref(null);
const rows = ref([]),
  total = ref(0),
  page = ref(1),
  pageSize = ref(20),
  loading = ref(false);
const detail = ref(null),
  detailLoading = ref(false),
  statusBusy = ref(false),
  composerBusy = ref(false),
  olderLoading = ref(false);
const recordsBox = ref(null),
  detailFailed = ref(false);
let applied = {},
  listVersion = 0,
  detailVersion = 0,
  detailRequest = 0;
const roleLabels = { admin: '管理员', operations: '运营', purchasing: '采购' };
const canFeedback = computed(() => ['admin', 'purchasing'].includes(auth.user?.role));
const feedbackBusy = reactive(new Set());

async function markFeedback(row) {
  if (
    !canFeedback.value ||
    row.supplierFeedback ||
    !row.item.manualEditable ||
    feedbackBusy.has(row.id)
  )
    return;
  feedbackBusy.add(row.id);
  try {
    const result = await afterSalesApi.feedback(row.id);
    Object.assign(row, result);
    ElMessage.success('已标记反馈供应商');
    await loadList();
    if (detail.value?.id === row.id) await loadDetail(row.id);
  } catch {
    /* 统一请求提示，失败保留原标记。 */
  } finally {
    feedbackBusy.delete(row.id);
  }
}

async function loadList() {
  const version = ++listVersion;
  loading.value = true;
  try {
    const data = await afterSalesApi.list({
      ...applied,
      page: page.value,
      pageSize: pageSize.value,
    });
    if (version === listVersion) {
      rows.value = data.rows;
      total.value = data.total;
      openCount.value = data.openCount ?? null;
      unfeedbackCount.value = data.unfeedbackCount ?? null;
    }
  } catch {
    if (version === listVersion) {
      rows.value = [];
      total.value = 0;
      openCount.value = null;
      unfeedbackCount.value = null;
    }
  } finally {
    if (version === listVersion) loading.value = false;
  }
}
function search() {
  applied = {
    q: draft.q.trim(),
    status: draft.status,
    supplierFeedback: draft.supplierFeedback,
    shopNames: [...draft.shopNames],
    purchaseChannel: [...draft.purchaseChannel],
    purchaseStatus: [...draft.purchaseStatus],
    ownerId: draft.ownerId || undefined,
    startDate: draft.dates?.[0],
    endDate: draft.dates?.[1],
  };
  page.value = 1;
  loadList();
}
function reset() {
  Object.assign(draft, {
    q: '',
    status: '',
    supplierFeedback: '',
    shopNames: [],
    dates: [],
    ownerId: null,
    purchaseChannel: [],
    purchaseStatus: [],
  });
  search();
}
function resize() {
  page.value = 1;
  loadList();
}
function open(row) {
  router.push({ path: '/purchase-after-sales', query: { ticket: row.id } });
}
function close() {
  if (composerBusy.value || statusBusy.value) return;
  router.replace({ path: '/purchase-after-sales' });
}
async function scrollBottom() {
  await nextTick();
  if (recordsBox.value) recordsBox.value.scrollTop = recordsBox.value.scrollHeight;
}
async function loadDetail(id) {
  const version = detailVersion;
  const request = ++detailRequest;
  detailLoading.value = true;
  try {
    const data = await afterSalesApi.detail(id);
    if (
      version !== detailVersion ||
      request !== detailRequest ||
      String(route.query.ticket) !== String(id)
    )
      return;
    detail.value = data;
    detailFailed.value = false;
    await scrollBottom();
  } catch (error) {
    if (version !== detailVersion || request !== detailRequest) return;
    detailFailed.value = true;
    // 普通网络失败保留已加载的记录和输入草稿；失去权限时立即隐藏详情。
    if ([401, 403, 404].includes(error.response?.status)) detail.value = null;
  } finally {
    if (version === detailVersion && request === detailRequest) detailLoading.value = false;
  }
}
async function older() {
  if (!detail.value?.hasMore || olderLoading.value) return;
  const id = detail.value.id,
    version = detailVersion;
  olderLoading.value = true;
  const oldHeight = recordsBox.value?.scrollHeight || 0;
  try {
    const data = await afterSalesApi.detail(id, detail.value.before);
    if (version !== detailVersion || !detail.value) return;
    const records = new Map([...data.records, ...detail.value.records].map((row) => [row.id, row]));
    detail.value = {
      ...detail.value,
      records: [...records.values()].sort((a, b) => a.id - b.id),
      hasMore: data.hasMore,
      before: data.before,
    };
    await nextTick();
    if (recordsBox.value) recordsBox.value.scrollTop += recordsBox.value.scrollHeight - oldHeight;
  } catch {
    /* HTTP拦截器提示，保留已加载记录。 */
  } finally {
    olderLoading.value = false;
  }
}
async function sent() {
  if (detail.value) {
    await loadDetail(detail.value.id);
    loadList();
  }
}
async function changeStatus() {
  if (!detail.value || statusBusy.value || composerBusy.value) return;
  const ticket = detail.value,
    status = ticket.status === 'open' ? 'completed' : 'open';
  statusBusy.value = true;
  try {
    await ElMessageBox.confirm(
      status === 'completed'
        ? '确认该商品售后已处理完毕？历史记录将保留。'
        : '确认重新打开此工单继续沟通？',
      status === 'completed' ? '售后完毕' : '重新打开',
      { type: 'info' },
    );
    await afterSalesApi.status(ticket.id, { status, version: ticket.version });
    ElMessage.success(status === 'completed' ? '已标记售后完毕' : '已重新打开');
    await loadDetail(ticket.id);
    loadList();
  } catch (error) {
    if (error?.response?.status === 409) await loadDetail(ticket.id);
  } finally {
    statusBusy.value = false;
  }
}
watch(
  () => route.query.ticket,
  (id) => {
    detailVersion++;
    detail.value = null;
    detailFailed.value = false;
    detailLoading.value = false;
    if (id) loadDetail(id);
  },
  { immediate: true },
);
async function loadOptions() {
  optionsLoading.value = true;
  try {
    stores.value = (await afterSalesApi.options()).stores;
    await meta.load(true);
  } catch {
    /* 保留已有选项，错误由统一拦截器提示。 */
  } finally {
    optionsLoading.value = false;
  }
}
function refresh() {
  loadList();
  loadOptions();
}
onMounted(refresh);
onBeforeUnmount(() => {
  listVersion++;
  detailVersion++;
});
</script>

<template>
  <section class="after-sale-page">
    <div class="after-sale-heading">
      <h2>
        采购售后 <el-tag type="info" size="small">{{ total }} 条</el-tag>
        <el-tag
          type="warning"
          size="small"
          class="open-count"
          title="按已查询的店铺、创建日期、所属账号、关键词、采购渠道、采购状态和反馈筛选统计全部处理中工单，不受售后状态筛选和分页影响"
          >处理中 {{ openCount ?? '—' }} 条</el-tag
        >
        <el-tag
          type="danger"
          size="small"
          class="unfeedback-count"
          title="统计其他已查询条件下的全部未反馈工单，包含已完毕工单，不受售后状态、是否已反馈供应商筛选及分页影响"
          >未反馈 {{ unfeedbackCount ?? '—' }} 条</el-tag
        >
      </h2>
      <el-button :loading="loading || optionsLoading" @click="refresh">刷新</el-button>
    </div>
    <div class="after-sale-filters">
      <el-input
        v-model="draft.q"
        clearable
        placeholder="搜索店铺名、订单号、SKU或商品名称"
        @keyup.enter="search"
      />
      <el-select
        v-model="draft.shopNames"
        multiple
        filterable
        clearable
        collapse-tags
        collapse-tags-tooltip
        :loading="optionsLoading"
        placeholder="全部店铺"
        aria-label="采购售后店铺筛选"
      >
        <el-option
          v-for="store in stores"
          :key="store.id"
          :value="store.name"
          :label="store.name + (store.isThirdParty ? '（三方）' : '')"
        />
      </el-select>
      <StoreOwnerSelect v-model="draft.ownerId" :stores="stores" />
      <el-select
        v-model="draft.purchaseChannel"
        multiple
        filterable
        clearable
        collapse-tags
        collapse-tags-tooltip
        placeholder="采购渠道"
        aria-label="采购渠道筛选"
      >
        <el-option label="未分配" :value="true" />
        <el-option
          v-for="option in meta.fieldMap.purchaseChannel?.options"
          :key="option"
          :label="option"
          :value="option"
        />
      </el-select>
      <el-select
        v-model="draft.purchaseStatus"
        multiple
        filterable
        clearable
        collapse-tags
        collapse-tags-tooltip
        placeholder="采购状态"
        aria-label="采购状态筛选"
      >
        <el-option label="未填写（空值）" :value="true" />
        <el-option
          v-for="option in meta.fieldMap.purchaseStatus?.options"
          :key="option"
          :label="option"
          :value="option"
        />
      </el-select>
      <el-date-picker
        v-model="draft.dates"
        type="daterange"
        value-format="YYYY-MM-DD"
        start-placeholder="创建开始日期（北京时间）"
        end-placeholder="创建结束日期（北京时间）"
        range-separator="至"
        class="created-date-filter"
      />
      <el-select v-model="draft.status" clearable placeholder="全部售后状态"
        ><el-option label="处理中" value="open" /><el-option label="售后完毕" value="completed"
      /></el-select>
      <el-select
        v-model="draft.supplierFeedback"
        clearable
        placeholder="是否已反馈供应商"
        aria-label="是否已反馈供应商筛选"
      >
        <el-option label="全部" value="" />
        <el-option label="是" value="yes" />
        <el-option label="否" value="no" />
      </el-select>
      <el-button type="primary" plain :loading="loading" @click="search">查询</el-button
      ><el-button :disabled="loading" @click="reset">重置</el-button>
    </div>
    <div class="after-sale-table">
      <el-table :data="rows" v-loading="loading" height="100%" row-key="id">
        <el-table-column label="店铺名" min-width="180"
          ><template #default="{ row }"
            >{{ row.item.shopName }}
            <el-tag v-if="row.item.storeIsThirdParty" size="small" type="warning"
              >三方</el-tag
            ></template
          ></el-table-column
        >
        <el-table-column prop="item.orderNumber" label="订单号" min-width="190" />
        <el-table-column
          prop="item.walmartSku"
          label="Walmart SKU"
          min-width="180"
          show-overflow-tooltip
        />
        <el-table-column label="采购渠道" min-width="180" show-overflow-tooltip>
          <template #default="{ row }">{{
            row.item.purchaseChannel?.join(' / ') || '未分配'
          }}</template>
        </el-table-column>
        <el-table-column label="采购状态" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">{{ row.item.purchaseStatus?.trim() || '未填写' }}</template>
        </el-table-column>
        <el-table-column label="售后状态" width="120"
          ><template #default="{ row }"
            ><el-tag :type="row.status === 'open' ? 'warning' : 'success'">{{
              row.status === 'open' ? '处理中' : '售后完毕'
            }}</el-tag></template
          ></el-table-column
        >
        <el-table-column prop="creatorName" label="发起人" width="120" />
        <el-table-column label="是否已反馈供应商" min-width="160">
          <template #default="{ row }">
            <el-tag
              :type="row.supplierFeedback ? 'success' : 'info'"
              :title="
                row.supplierFeedback
                  ? `${row.supplierFeedbackName || ''} · ${fmtDate(row.supplierFeedbackAt, true)}（北京时间）`
                  : ''
              "
              >{{ row.supplierFeedback ? '是' : '否' }}</el-tag
            >
          </template>
        </el-table-column>
        <el-table-column label="创建时间（北京）" width="185"
          ><template #default="{ row }">{{
            fmtDate(row.createdAt, true)
          }}</template></el-table-column
        >
        <el-table-column label="最后更新（北京）" width="185"
          ><template #default="{ row }">{{
            fmtDate(row.lastActivityAt, true)
          }}</template></el-table-column
        >
        <el-table-column label="操作" fixed="right" :min-width="canFeedback ? 180 : 110">
          <template #default="{ row }">
            <div class="after-sale-row-actions">
              <el-button link type="primary" @click="open(row)">查看工单</el-button>
              <el-button
                v-if="canFeedback && row.item.manualEditable"
                link
                type="primary"
                :loading="feedbackBusy.has(row.id)"
                :disabled="row.supplierFeedback"
                @click="markFeedback(row)"
                >已反馈</el-button
              >
            </div>
          </template>
        </el-table-column>
        <template #empty
          ><el-empty description="暂无采购售后工单，可从订单列表发起" :image-size="80"
        /></template>
      </el-table>
    </div>
    <div class="after-sale-footer">
      <span>工单按商品明细建立，沟通记录永久保留</span
      ><el-pagination
        v-model:current-page="page"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[20, 50, 100]"
        :disabled="loading"
        layout="total, sizes, prev, pager, next"
        @current-change="loadList"
        @size-change="resize"
      />
    </div>
  </section>
  <el-drawer
    :model-value="Boolean(route.query.ticket)"
    title="采购售后工单"
    size="min(820px, 100vw)"
    class="after-sale-drawer"
    :close-on-click-modal="false"
    :show-close="!composerBusy && !statusBusy"
    :close-on-press-escape="!composerBusy && !statusBusy"
    @close="close"
  >
    <div v-loading="detailLoading" class="ticket-panel">
      <template v-if="detail">
        <div class="ticket-summary">
          <div>
            <strong>{{ detail.item.shopName }} · {{ detail.item.orderNumber }}</strong>
            <p>{{ detail.item.walmartSku }} · {{ detail.item.productName }}</p>
          </div>
          <div class="ticket-actions">
            <el-tag :type="detail.status === 'open' ? 'warning' : 'success'">{{
              detail.status === 'open' ? '处理中' : '售后完毕'
            }}</el-tag
            ><el-button :disabled="composerBusy || statusBusy" @click="loadDetail(detail.id)"
              >刷新记录</el-button
            ><el-button
              v-if="detail.item.manualEditable"
              type="primary"
              :loading="statusBusy"
              :disabled="composerBusy || detailLoading"
              @click="changeStatus"
              >{{ detail.status === 'open' ? '售后完毕' : '重新打开' }}</el-button
            >
          </div>
        </div>
        <el-alert
          v-if="detailFailed"
          title="记录更新失败，当前显示上次结果，请点击刷新记录"
          type="warning"
          :closable="false"
        />
        <div ref="recordsBox" class="ticket-records">
          <div v-if="detail.hasMore" class="record-date">
            <el-button text :loading="olderLoading" @click="older">加载更早记录</el-button>
          </div>
          <template v-for="(record, index) in detail.records" :key="record.id">
            <div
              v-if="
                !index ||
                fmtBeijingDate(record.createdAt) !==
                  fmtBeijingDate(detail.records[index - 1].createdAt)
              "
              class="record-date"
            >
              {{ fmtBeijingDate(record.createdAt) }}（北京时间）
            </div>
            <div v-if="record.kind !== 'message'" class="record-event">
              {{ record.actorName }} · {{ record.content }} · {{ fmtDate(record.createdAt, true) }}
            </div>
            <article
              v-else
              class="record-message"
              :class="{ mine: record.actorId === auth.user.id }"
            >
              <div class="record-author">
                {{ record.actorName }} · {{ roleLabels[record.actorRole] || record.actorRole }} ·
                {{ fmtDate(record.createdAt, true) }}
              </div>
              <div class="record-bubble">
                <div class="record-content">{{ record.content }}</div>
                <div v-if="record.images.length" class="record-images">
                  <el-image
                    v-for="(path, imageIndex) in record.images"
                    :key="path"
                    :src="meta.imageUrl(path, true)"
                    :preview-src-list="record.images.map((p) => meta.imageUrl(p))"
                    :initial-index="imageIndex"
                    fit="contain"
                    preview-teleported
                    lazy
                  />
                </div>
              </div>
            </article>
          </template>
        </div>
        <div class="ticket-compose">
          <el-alert
            v-if="detail.status !== 'open' || !detail.item.manualEditable"
            :title="
              !detail.item.manualEditable
                ? 'WFS订单只读，保留已有售后记录'
                : '售后已完毕。如需继续沟通，请先重新打开工单。'
            "
            type="info"
            :closable="false"
          />
          <AfterSaleComposer
            :key="detail.id"
            :submit="(body) => afterSalesApi.reply(detail.id, body)"
            :disabled="
              statusBusy || detailLoading || detail.status !== 'open' || !detail.item.manualEditable
            "
            @busy="composerBusy = $event"
            @sent="sent"
          />
        </div>
      </template>
      <el-empty v-else-if="!detailLoading" description="工单加载失败或无权查看" />
    </div>
  </el-drawer>
</template>
<style scoped>
.after-sale-page {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: white;
  border-radius: 8px;
  padding: 16px;
  gap: 16px;
}
.after-sale-heading,
.after-sale-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
h2 {
  margin: 0;
  font-size: 16px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.after-sale-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.after-sale-filters .el-input {
  width: 360px;
  max-width: 100%;
}
.after-sale-filters .el-select {
  width: 160px;
}
.after-sale-filters .created-date-filter {
  flex: 0 1 390px;
  max-width: 100%;
}
.after-sale-filters .store-owner-select {
  width: 210px;
}
.after-sale-filters .el-button + .el-button {
  margin-left: 0;
}
.after-sale-table {
  flex: 1;
  min-height: 0;
}
.after-sale-row-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.after-sale-row-actions .el-button + .el-button {
  margin-left: 0;
}
.after-sale-footer {
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.ticket-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.ticket-summary p {
  margin: 8px 0 12px;
  color: var(--el-text-color-secondary);
  overflow-wrap: anywhere;
}
.ticket-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.ticket-actions .el-button + .el-button {
  margin-left: 0;
}
.ticket-records {
  flex: 1;
  min-height: 120px;
  overflow-y: auto;
  padding: 16px;
  background: var(--el-fill-color-lighter);
  border-radius: 6px;
}
.record-date,
.record-event {
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  margin: 12px 0;
}
.record-message {
  display: flex;
  align-items: flex-start;
  flex-direction: column;
  margin-bottom: 18px;
}
.record-message.mine {
  align-items: flex-end;
}
.record-author {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-bottom: 6px;
}
.record-bubble {
  background: white;
  padding: 12px;
  border-radius: 8px;
  max-width: 92%;
}
.mine .record-bubble {
  background: var(--el-color-primary-light-9);
}
.record-content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.6;
}
.record-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}
.record-images .el-image {
  width: 88px;
  height: 88px;
  border-radius: 4px;
  background: white;
}
.ticket-compose {
  max-height: 45%;
  overflow: auto;
  flex-shrink: 0;
}
</style>
<style>
.after-sale-drawer .el-drawer__body {
  min-height: 0;
  overflow: hidden;
}
</style>
