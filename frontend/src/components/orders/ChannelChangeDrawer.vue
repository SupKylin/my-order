<script setup>
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { channelChangesApi } from '../../api/channel-change-tickets';
import { canAssignChannel } from '../../utils/permissions';
import { channelChangePurchaseFields } from '../../utils/channelChangePurchaseFields';
import ChannelChangeSummary from './ChannelChangeSummary.vue';
import { useAuth } from '../../stores/auth';
import { useMeta } from '../../stores/meta';
import { fmtDate, fmtBeijingDate } from '../../utils/format';
import AfterSaleComposer from './AfterSaleComposer.vue';
const props = defineProps({ ticketId: [String, Number], showMenu: Boolean });
const emit = defineEmits(['close', 'changed', 'loaded']);
const router = useRouter(),
  auth = useAuth(),
  meta = useMeta();
const detail = ref(null),
  detailLoading = ref(false),
  statusBusy = ref(false),
  composerBusy = ref(false),
  olderLoading = ref(false);
const recordsBox = ref(null),
  detailFailed = ref(false);
let detailVersion = 0,
  detailRequest = 0;
const roleLabels = { admin: '管理员', supervisor: '主管', operations: '运营', purchasing: '采购' };
const applyBusy = ref(false),
  targetChannels = ref([]);
watch(
  () => detail.value?.id,
  () => {
    targetChannels.value = [...(detail.value?.targetChannels || [])];
  },
);
const purchaseReviewFields = [
  ...channelChangePurchaseFields,
  ['purchaseLimit', '采购限价（自动计算）'],
];
const canApply = computed(() => canAssignChannel(auth.user?.role));
async function applyChange() {
  if (
    !detail.value ||
    applyBusy.value ||
    statusBusy.value ||
    composerBusy.value ||
    detailLoading.value
  )
    return;
  const ticket = detail.value;
  if (!targetChannels.value.length) return ElMessage.warning('请选择目标采购渠道');
  applyBusy.value = true;
  try {
    await ElMessageBox.confirm(
      `确认将采购渠道从“${ticket.beforeChannels.join(' / ') || '未分配'}”变更为“${targetChannels.value.join(' / ')}”${ticket.targetPurchase ? '，并一并更新申请中的采购信息' : ''}？采购状态及原采购成功时间将清空。`,
      '确认采购渠道变更',
      { type: 'warning' },
    );
    await channelChangesApi.apply(ticket.id, {
      version: ticket.version,
      targetChannels: [...targetChannels.value],
    });
    ElMessage.success('采购渠道已变更，采购状态已清空');
    await loadDetail(ticket.id);
    emit('changed');
  } catch (error) {
    if (error?.response?.status === 409) await loadDetail(ticket.id);
  } finally {
    applyBusy.value = false;
  }
}

function close() {
  if (!composerBusy.value && !statusBusy.value && !applyBusy.value) emit('close');
}
function goToMenu() {
  router.push({ path: '/channel-change-tickets', query: { ticket: props.ticketId } });
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
    const [data] = await Promise.all([channelChangesApi.detail(id), meta.load(true)]);
    if (
      version !== detailVersion ||
      request !== detailRequest ||
      String(props.ticketId) !== String(id)
    )
      return;
    detail.value = data;
    emit('loaded', data);
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
    const data = await channelChangesApi.detail(id, detail.value.before);
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
    emit('changed');
  }
}
async function changeStatus() {
  if (!detail.value || statusBusy.value || composerBusy.value || applyBusy.value) return;
  const ticket = detail.value,
    status = ticket.status === 'open' ? 'completed' : 'open';
  statusBusy.value = true;
  try {
    await ElMessageBox.confirm(
      status === 'completed'
        ? '确认关闭渠道变更工单？关闭不会自动变更或撤销订单渠道，历史记录将保留。'
        : '确认重新打开此工单继续沟通？',
      status === 'completed' ? '关闭工单' : '重新打开',
      { type: 'info' },
    );
    await channelChangesApi.status(ticket.id, { status, version: ticket.version });
    ElMessage.success(status === 'completed' ? '工单已关闭' : '已重新打开');
    await loadDetail(ticket.id);
    emit('changed');
  } catch (error) {
    if (error?.response?.status === 409) await loadDetail(ticket.id);
  } finally {
    statusBusy.value = false;
  }
}
watch(
  () => props.ticketId,
  (id) => {
    detailVersion++;
    detail.value = null;
    detailFailed.value = false;
    detailLoading.value = false;
    if (id) loadDetail(id);
  },
  { immediate: true },
);
defineExpose({
  refresh: (id) => (String(id) === String(props.ticketId) ? loadDetail(id) : undefined),
});
onBeforeUnmount(() => {
  detailVersion++;
});
</script>
<template>
  <el-drawer
    :model-value="Boolean(ticketId)"
    title="渠道变更工单"
    size="min(820px, 100vw)"
    class="channel-change-drawer"
    :close-on-click-modal="false"
    :show-close="!composerBusy && !statusBusy && !applyBusy"
    :close-on-press-escape="!composerBusy && !statusBusy && !applyBusy"
    append-to-body
    @close="close"
  >
    <div v-loading="detailLoading" class="ticket-panel">
      <template v-if="detail">
        <div class="ticket-summary">
          <ChannelChangeSummary :item="detail.item" />
          <dl class="ticket-procurement">
            <div>
              <dt>变更前采购渠道</dt>
              <dd>{{ detail.beforeChannels.join(' / ') || '未分配' }}</dd>
            </div>
            <div>
              <dt>目标采购渠道</dt>
              <dd>{{ detail.targetChannels.join(' / ') || '待分配' }}</dd>
            </div>
          </dl>
          <details v-if="detail.targetPurchase" class="purchase-review">
            <summary>查看申请采购信息（确认变更时一并写回）</summary>
            <table>
              <thead>
                <tr>
                  <th>字段</th>
                  <th>申请前</th>
                  <th>申请值</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="[key, label] in purchaseReviewFields" :key="key">
                  <th>{{ label }}</th>
                  <td>{{ detail.beforePurchase?.[key] ?? '—' }}</td>
                  <td>{{ detail.targetPurchase[key] ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </details>
          <p v-if="detail.appliedAt">
            已确认变更 · {{ detail.appliedByName }} ·
            {{ fmtDate(detail.appliedAt, true) }}（北京时间）
          </p>
          <p v-else>尚未确认变更，订单采购渠道尚未通过此工单更新。</p>
          <el-form
            v-if="
              canApply &&
              detail.status === 'open' &&
              !detail.appliedAt &&
              detail.item.manualEditable
            "
            label-position="top"
            :disabled="composerBusy || statusBusy || applyBusy || detailLoading"
          >
            <el-form-item label="目标采购渠道（仅采购或管理员可分配）">
              <el-select
                v-model="targetChannels"
                multiple
                filterable
                clearable
                placeholder="选择采购渠道（可多选）"
                style="width: 100%"
              >
                <el-option
                  v-for="channel in meta.fieldMap.purchaseChannel?.options"
                  :key="channel"
                  :value="channel"
                  :label="channel"
                />
              </el-select>
            </el-form-item>
          </el-form>
          <div class="ticket-actions">
            <el-button
              v-if="
                canApply &&
                detail.status === 'open' &&
                !detail.appliedAt &&
                detail.item.manualEditable
              "
              type="success"
              :loading="applyBusy"
              :disabled="composerBusy || statusBusy || detailLoading"
              @click="applyChange"
              >确认变更</el-button
            >
            <el-button
              v-if="showMenu"
              :disabled="composerBusy || statusBusy || applyBusy"
              @click="goToMenu"
              >前往渠道变更菜单</el-button
            >
            <el-tag :type="detail.status === 'open' ? 'warning' : 'success'">{{
              detail.status === 'open' ? '处理中' : '已关闭'
            }}</el-tag
            ><el-button
              :disabled="composerBusy || statusBusy || applyBusy"
              @click="loadDetail(detail.id)"
              >刷新记录</el-button
            ><el-button
              v-if="detail.item.manualEditable"
              type="primary"
              :loading="statusBusy"
              :disabled="composerBusy || detailLoading || applyBusy"
              @click="changeStatus"
              >{{ detail.status === 'open' ? '关闭工单' : '重新打开' }}</el-button
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
                ? 'WFS订单只读，保留已有工单记录'
                : '工单已关闭。如需继续沟通，请先重新打开工单。'
            "
            type="info"
            :closable="false"
          />
          <AfterSaleComposer
            subject="变更"
            :key="detail.id"
            :submit="(body) => channelChangesApi.reply(detail.id, body)"
            :disabled="
              statusBusy ||
              applyBusy ||
              detailLoading ||
              detail.status !== 'open' ||
              !detail.item.manualEditable
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
.ticket-panel {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.ticket-summary {
  flex-shrink: 0;
}
.purchase-review {
  margin-bottom: 12px;
}
.purchase-review summary {
  cursor: pointer;
  color: var(--el-color-primary);
}
.purchase-review table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  margin-top: 8px;
  font-size: 12px;
}
.purchase-review th,
.purchase-review td {
  padding: 6px;
  border: 1px solid var(--el-border-color-lighter);
  text-align: left;
  overflow-wrap: anywhere;
}
.ticket-summary p {
  margin: 8px 0 12px;
  color: var(--el-text-color-secondary);
  overflow-wrap: anywhere;
}
.ticket-procurement {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
  margin: 0 0 12px;
}
.ticket-procurement > div {
  display: flex;
  flex: 1 1 280px;
  min-width: 0;
  gap: 8px;
}
.ticket-procurement dt {
  flex-shrink: 0;
  color: var(--el-text-color-secondary);
}
.ticket-procurement dd {
  margin: 0;
  min-width: 0;
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
@media (max-height: 850px) {
  .ticket-panel {
    height: auto;
    min-height: 100%;
  }
  .ticket-compose {
    max-height: none;
  }
  .ticket-records {
    flex: none;
    height: 240px;
  }
}
</style>
<style>
.channel-change-drawer .el-drawer__body {
  min-height: 0;
  overflow: auto;
}
</style>
