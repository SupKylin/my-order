<script setup>
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { afterSalesApi } from '../../api/purchase-after-sales';
import { useAuth } from '../../stores/auth';
import { useMeta } from '../../stores/meta';
import { fmtDate, fmtBeijingDate, money } from '../../utils/format';
import { canManageProcurement } from '../../utils/permissions';
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
  olderLoading = ref(false),
  feedbackBusy = ref(false);
const recordsBox = ref(null),
  detailFailed = ref(false);
let detailVersion = 0,
  detailRequest = 0;
const roleLabels = { admin: '管理员', supervisor: '主管', operations: '运营', purchasing: '采购' };
const canFeedback = computed(() => canManageProcurement(auth.user?.role));
const refundDraft = ref(''),
  refundOriginal = ref(''),
  refundVersion = ref(null),
  refundBusy = ref(false);
const refundDirty = computed(() => refundDraft.value !== refundOriginal.value);
function resetRefundDraft() {
  refundDraft.value = refundOriginal.value = detail.value?.purchaseRefundAmount ?? '';
  refundVersion.value = detail.value?.version ?? null;
}
async function saveRefund() {
  const ticket = detail.value;
  if (
    !ticket ||
    refundBusy.value ||
    statusBusy.value ||
    composerBusy.value ||
    detailLoading.value ||
    feedbackBusy.value
  )
    return;
  const amount = refundDraft.value.trim();
  if (amount && !/^\d{1,16}(?:\.\d{1,2})?$/.test(amount)) {
    ElMessage.warning('采购退款金额须为非负数字，最多16位整数、2位小数');
    return;
  }
  refundBusy.value = true;
  try {
    const result = await afterSalesApi.refundAmount(ticket.id, {
      purchaseRefundAmount: amount || null,
      version: refundVersion.value,
    });
    if (detail.value?.id === ticket.id) {
      Object.assign(detail.value, result);
      resetRefundDraft();
    }
    ElMessage.success('采购退款金额已保存');
    emit('loaded', detail.value);
    emit('changed');
  } catch (error) {
    if (error?.response?.status === 409 && detail.value?.id === ticket.id)
      await loadDetail(ticket.id);
  } finally {
    refundBusy.value = false;
  }
}

function close() {
  if (!composerBusy.value && !statusBusy.value && !refundBusy.value && !feedbackBusy.value)
    emit('close');
}
function goToMenu() {
  router.push({ path: '/purchase-after-sales', query: { ticket: props.ticketId } });
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
      String(props.ticketId) !== String(id)
    )
      return;
    detail.value = data;
    emit('loaded', data);
    if (!refundDirty.value) resetRefundDraft();
    else if ((data.purchaseRefundAmount ?? '') === refundOriginal.value)
      refundVersion.value = data.version;
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
    emit('changed');
  }
}
async function markFeedback() {
  const ticket = detail.value;
  if (
    !ticket ||
    !canFeedback.value ||
    ticket.supplierFeedback ||
    !ticket.item.manualEditable ||
    feedbackBusy.value ||
    statusBusy.value ||
    composerBusy.value ||
    refundBusy.value ||
    detailLoading.value
  )
    return;
  feedbackBusy.value = true;
  try {
    const result = await afterSalesApi.feedback(ticket.id);
    if (detail.value?.id === ticket.id) Object.assign(detail.value, result);
    ElMessage.success('已标记反馈供应商');
    emit('changed');
    await loadDetail(ticket.id);
  } catch (error) {
    if (error?.response?.status === 409 && detail.value?.id === ticket.id)
      await loadDetail(ticket.id);
  } finally {
    feedbackBusy.value = false;
  }
}
async function changeStatus() {
  if (
    !detail.value ||
    statusBusy.value ||
    composerBusy.value ||
    refundBusy.value ||
    feedbackBusy.value
  )
    return;
  const ticket = detail.value,
    status = ticket.status === 'open' ? 'completed' : 'open';
  if (status === 'completed') {
    if (refundDirty.value) {
      ElMessage.warning('请先保存采购退款金额，再标记售后完毕');
      return;
    }
    if (ticket.purchaseRefundAmount == null) {
      ElMessage.warning('请先填写并保存采购退款金额，无退款请填0');
      return;
    }
  }
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
    resetRefundDraft();
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
    title="采购售后工单"
    size="min(820px, 100vw)"
    class="after-sale-drawer"
    :close-on-click-modal="false"
    :show-close="!composerBusy && !statusBusy && !refundBusy && !feedbackBusy"
    :close-on-press-escape="!composerBusy && !statusBusy && !refundBusy && !feedbackBusy"
    append-to-body
    @close="close"
  >
    <div v-loading="detailLoading" class="ticket-panel">
      <template v-if="detail">
        <div class="ticket-summary">
          <div>
            <strong>{{ detail.item.shopName }} · {{ detail.item.orderNumber }}</strong>
            <p>{{ detail.item.walmartSku }} · {{ detail.item.productName }}</p>
          </div>
          <dl class="ticket-procurement">
            <div>
              <dt>采购渠道</dt>
              <dd>{{ detail.item.purchaseChannel?.join(' / ').trim() || '未分配' }}</dd>
            </div>
            <div>
              <dt>采购状态</dt>
              <dd>{{ detail.item.purchaseStatus?.trim() || '未填写' }}</dd>
            </div>
            <div>
              <dt>采购成本（USD）</dt>
              <dd>{{ money(detail.item.purchaseCost) }}</dd>
            </div>
          </dl>
          <div class="ticket-refund">
            <label for="purchase-refund-amount">采购退款金额</label>
            <template v-if="detail.status === 'open' && detail.item.manualEditable">
              <el-input
                id="purchase-refund-amount"
                v-model="refundDraft"
                inputmode="decimal"
                maxlength="19"
                placeholder="无退款请填0"
                aria-label="采购退款金额"
                :disabled="
                  refundBusy || statusBusy || composerBusy || detailLoading || feedbackBusy
                "
              />
              <el-button
                :loading="refundBusy"
                :disabled="
                  !refundDirty || statusBusy || composerBusy || detailLoading || feedbackBusy
                "
                @click="saveRefund"
                >保存金额</el-button
              >
              <el-button
                v-if="refundDirty"
                text
                :disabled="
                  refundBusy || statusBusy || composerBusy || detailLoading || feedbackBusy
                "
                @click="resetRefundDraft"
                >恢复已保存金额</el-button
              >
              <span class="refund-hint">关闭前必填，支持0，最多2位小数</span>
            </template>
            <span v-else>{{ detail.purchaseRefundAmount ?? '未填写' }}</span>
          </div>
          <div class="ticket-actions">
            <el-button
              v-if="showMenu"
              :disabled="composerBusy || statusBusy || refundBusy || feedbackBusy"
              @click="goToMenu"
              >前往采购售后菜单</el-button
            >
            <el-tag :type="detail.status === 'open' ? 'warning' : 'success'">{{
              detail.status === 'open' ? '处理中' : '售后完毕'
            }}</el-tag
            ><el-button
              v-if="canFeedback && detail.item.manualEditable"
              type="primary"
              plain
              :loading="feedbackBusy"
              :disabled="
                detail.supplierFeedback || composerBusy || statusBusy || refundBusy || detailLoading
              "
              @click="markFeedback"
              >已反馈</el-button
            ><el-button
              :disabled="composerBusy || statusBusy || refundBusy || feedbackBusy"
              @click="loadDetail(detail.id)"
              >刷新记录</el-button
            ><el-button
              v-if="detail.item.manualEditable"
              type="primary"
              :loading="statusBusy"
              :disabled="composerBusy || detailLoading || refundBusy || feedbackBusy"
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
              statusBusy ||
              feedbackBusy ||
              refundBusy ||
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
.ticket-refund {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.ticket-refund .el-input {
  width: 200px;
  max-width: 100%;
}
.ticket-refund .el-button + .el-button {
  margin-left: 0;
}
.refund-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
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
