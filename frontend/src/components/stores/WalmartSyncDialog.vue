<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { storeApi } from '../../api/stores';
import WalmartDetails from '../orders/WalmartDetails.vue';

const props = defineProps({ store: { type: Object, required: true } });
const emit = defineEmits(['close']);
const status = ref({ state: null, problems: [] });
const busy = ref(false);
const initializing = ref(true);
const previewing = ref(false);
const preview = ref(null);
const now = new Date();
const dates = ref([new Date(now.getTime() - 86400000), now]);
let timer;
let loading = false;
const labels = {
  idle: '等待首次同步',
  running: '同步中',
  completed: '同步完成',
  partial: '部分完成，请查看问题',
  failed: '同步失败',
};
const time = (value) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        dateStyle: 'short',
        timeStyle: 'medium',
        hourCycle: 'h23',
      }).format(new Date(value))
    : '—';

async function load() {
  if (loading) return;
  loading = true;
  try {
    status.value = await storeApi.syncStatus(props.store.id);
  } finally {
    loading = false;
  }
}
async function toggle() {
  if (busy.value || initializing.value) return;
  busy.value = true;
  try {
    const enabled = !status.value.state?.enabled;
    if (enabled) {
      try {
        await ElMessageBox.confirm(
          '启用后每店约 20 分钟同步一次，最多同时处理 3 家店铺，繁忙时排队；保存成功后自动确认 Created 订单。首次从 2026 年 10 月 1 日 00:00（美西标准时间）起拉取，之后每轮回查 48 小时、每 24 小时核对最近 7 天，此日期之前的订单不接入。',
          '启用 Walmart 同步',
          { type: 'warning', confirmButtonText: '启用', cancelButtonText: '取消' },
        );
      } catch {
        return;
      }
    }
    status.value = await storeApi.configureSync(props.store.id, enabled);
    if (enabled) await storeApi.sync(props.store.id);
    ElMessage.success(
      enabled ? '已启用每 20 分钟同步，支持店铺并发' : '已暂停，正在执行的接口请求结束后停止',
    );
    await load();
  } finally {
    busy.value = false;
  }
}
async function sync() {
  if (busy.value || initializing.value) return;
  busy.value = true;
  try {
    await storeApi.sync(props.store.id);
    ElMessage.success('同步任务已启动，可关闭弹框');
    await load();
  } finally {
    busy.value = false;
  }
}
async function queryPreview() {
  if (previewing.value) return;
  if (!dates.value?.length) return ElMessage.warning('请选择预览时间范围');
  previewing.value = true;
  try {
    preview.value = await storeApi.preview(props.store.id, {
      start: dates.value[0].toISOString(),
      end: dates.value[1].toISOString(),
    });
  } finally {
    previewing.value = false;
  }
}
onMounted(() => {
  // 仅首次打开显示区域加载，后续状态轮询保持静默。
  void load().finally(() => {
    initializing.value = false;
  });
  timer = setInterval(() => void load().catch(() => {}), 5000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <el-dialog
    :model-value="true"
    :title="`${store.systemStoreName} · Walmart 订单同步`"
    width="1000px"
    @close="emit('close')"
    :close-on-click-modal="false"
  >
    <div v-loading="initializing">
      <el-alert
        type="info"
        :closable="false"
        title="正式环境：成功保存订单后，仅自动确认卖家自配送的 Created 订单。采购信息保留，WFS 跳过确认。"
      />
      <div class="sync-actions">
        <el-tag :type="status.state?.enabled ? 'success' : 'info'">{{
          status.state?.enabled ? '每 20 分钟同步 · 店铺并发' : '未启用 / 已暂停'
        }}</el-tag>
        <el-button :loading="busy" @click="toggle">{{
          status.state?.enabled ? '暂停同步' : '启用自动同步'
        }}</el-button>
        <el-button
          type="primary"
          :loading="busy"
          :disabled="!status.state?.enabled || status.state?.status === 'running'"
          @click="sync"
          >立即同步 / 重试</el-button
        >
      </div>
      <p>订单接收范围：2026-10-01 00:00（美西标准时间）起，包含 10 月 1 日</p>
      <p v-if="status.state?.startedAt">
        当前任务起点：{{ time(status.state.startedAt) }}（北京时间）
      </p>
      <p v-if="status.state?.result?.range">
        本轮查询：{{
          { backfill: '首次补查', reconcile: '每日核对', recent: '48 小时回查' }[
            status.state.result.range.mode
          ]
        }}
        · {{ time(status.state.result.range.start) }} 至
        {{ time(status.state.result.range.end) }}（北京时间）
      </p>
      <p>
        状态：{{ labels[status.state?.status] || '尚未开始' }} · 上次开始：{{
          time(status.state?.lastRunAt)
        }}
        · 上次结束：{{ time(status.state?.finishedAt) }}
      </p>
      <el-alert
        v-if="status.state?.error"
        type="error"
        :closable="false"
        :title="status.state.error"
      />
      <p v-if="status.state?.result">
        本次订单 {{ status.state.result.orders }} 个 · 新增 {{ status.state.result.added }} 条明细 ·
        更新 {{ status.state.result.updated }} 条 · 确认成功
        {{ status.state.result.acknowledged }} 个 · 失败 {{ status.state.result.failed }} 个 ·
        待核对 {{ status.state.result.review }} 个 · 变体查询失败
        {{ status.state.result.variantErrors }} 个
      </p>
      <el-table v-if="status.problems.length" :data="status.problems" max-height="220">
        <el-table-column prop="customerOrderId" label="待处理订单" min-width="180" />
        <el-table-column prop="ackAttempts" label="确认次数" width="90" />
        <el-table-column prop="lastError" label="原因" min-width="280" />
      </el-table>
      <p
        v-for="error in status.state?.result?.errors || []"
        :key="error.purchaseOrderId"
        class="sync-error"
      >
        PO {{ error.purchaseOrderId }}：{{ error.message }}
      </p>
    </div>
    <el-divider>只读预览（不保存订单、不自动确认）</el-divider>
    <div class="sync-actions">
      <el-date-picker
        v-model="dates"
        type="datetimerange"
        range-separator="至"
        start-placeholder="开始时间"
        end-placeholder="结束时间"
      />
      <el-button :loading="previewing" @click="queryPreview">查询预览</el-button>
    </div>
    <p class="muted">
      选择器使用当前浏览器当地时间；订单详情显示固定 PST（UTC−8）。最多预览 31 天、200 个订单。
    </p>
    <template v-if="preview">
      <p>返回 {{ preview.orders.length }} 个订单</p>
      <el-collapse>
        <el-collapse-item
          v-for="order in preview.orders"
          :key="order.purchaseOrderId"
          :name="order.purchaseOrderId"
          :title="`${order.customerOrderId} · ${order.lines.length} 条明细`"
        >
          <div v-for="line in order.lines" :key="line.walmart.lineNumber" class="preview-line">
            <strong>SKU {{ line.fields.walmartSku }} · 数量 {{ line.fields.quantity }}</strong>
            <p>{{ line.fields.productName }}</p>
            <p>
              平台订单状态：{{ line.fields.platformOrderStatus || '—' }} · 商品规格：{{
                line.fields.productSpecification || '—'
              }}
            </p>
            <WalmartDetails :value="line.walmart" />
          </div>
        </el-collapse-item>
      </el-collapse>
    </template>
    <template #footer><el-button @click="emit('close')">关闭</el-button></template>
  </el-dialog>
</template>

<style scoped>
.sync-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin: 16px 0;
}
.preview-line {
  padding: 12px 0;
  border-bottom: 1px solid var(--el-border-color-light);
}
.sync-error {
  color: var(--el-color-danger);
}
</style>
