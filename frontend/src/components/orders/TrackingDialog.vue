<script setup>
import { computed, onMounted, ref } from 'vue';
import { Refresh, Van } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import { orderApi } from '../../api/orders';

const props = defineProps({ item: { type: Object, required: true } });
const emit = defineEmits(['close']);
const loading = ref(false);
const registering = ref(false);
const result = ref(null);
const error = ref('');
const shipments = computed(() => result.value?.shipments || []);
const statusLabels = {
  PENDING: '待查询',
  INFO_RECEIVED: '已收到物流信息',
  IN_TRANSIT: '运输中',
  WAITING_DELIVERY: '派送中',
  DELIVERED: '已签收',
  EXCEPTION: '物流异常',
  EXPIRED: '查询过期',
};
const statusText = (status) => statusLabels[status] || status || '暂无状态';

async function load() {
  loading.value = true;
  error.value = '';
  try {
    result.value = await orderApi.tracking(props.item.id);
  } catch (cause) {
    result.value = null;
    error.value = cause.response?.data?.message || '物流信息查询失败';
  } finally {
    loading.value = false;
  }
}

async function register() {
  registering.value = true;
  try {
    const registration = await orderApi.registerTracking(props.item.id);
    if (registration.accepted) ElMessage.success('运单已提交追踪');
    else ElMessage.warning(registration.rejection?.message || 'Track123 未接受该运单');
    await load();
  } finally {
    registering.value = false;
  }
}

onMounted(load);
</script>

<template>
  <el-dialog
    :model-value="true"
    title="物流追踪"
    width="min(620px, 96vw)"
    destroy-on-close
    @close="emit('close')"
  >
    <div class="tracking-dialog-header">
      <div>
        <div class="muted">内部物流单号</div>
        <strong class="mono">{{ result?.trackNo || item.trackingNumber }}</strong>
      </div>
      <el-button :icon="Refresh" :loading="loading" :disabled="registering" @click="load"
        >刷新</el-button
      >
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <div v-else-if="loading && !result" v-loading="true" class="tracking-loading" />
    <template v-else-if="result">
      <template v-if="shipments.length">
        <section
          v-for="shipment in shipments"
          :key="shipment.trackNo + shipment.localLogisticsInfo?.courierCode"
          class="tracking-shipment"
        >
          <div class="tracking-status">
            <el-tag type="primary">{{ statusText(shipment.transitStatus) }}</el-tag>
            <span>{{
              shipment.localLogisticsInfo?.courierNameCN ||
              shipment.localLogisticsInfo?.courierNameEN ||
              '承运商识别中'
            }}</span>
          </div>
          <div v-if="shipment.lastTrackingTime" class="muted">
            最近更新：{{ shipment.lastTrackingTime }}
          </div>
          <el-timeline
            v-if="shipment.localLogisticsInfo?.trackingDetails?.length"
            class="tracking-events"
          >
            <el-timeline-item
              v-for="(event, index) in shipment.localLogisticsInfo.trackingDetails"
              :key="`${event.eventTime}-${index}`"
              :timestamp="event.eventTime"
            >
              <div>{{ event.eventDetail || statusText(event.transitSubStatus) }}</div>
              <div v-if="event.address" class="muted">{{ event.address }}</div>
            </el-timeline-item>
          </el-timeline>
          <div v-else class="muted tracking-empty">暂无物流轨迹</div>
        </section>
      </template>
      <div v-else class="tracking-unregistered">
        <el-empty description="Track123 尚无该运单的追踪记录" :image-size="80" />
        <el-button type="primary" :icon="Van" :loading="registering" @click="register"
          >注册追踪</el-button
        >
        <div v-if="result.rejected?.length" class="muted">
          {{ result.rejected[0].error?.msg }}
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.tracking-dialog-header,
.tracking-status {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.tracking-dialog-header {
  margin-bottom: 18px;
}
.tracking-dialog-header .mono {
  overflow-wrap: anywhere;
}
.tracking-shipment {
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 16px;
}
.tracking-shipment + .tracking-shipment {
  margin-top: 18px;
}
.tracking-status {
  justify-content: flex-start;
  margin-bottom: 8px;
}
.tracking-events {
  margin-top: 18px;
  padding-left: 4px;
}
.tracking-loading {
  min-height: 140px;
}
.tracking-unregistered {
  text-align: center;
}
.tracking-empty {
  margin: 18px 0;
}
</style>
