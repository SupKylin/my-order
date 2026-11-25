<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { channelChangesApi } from '../../api/channel-change-tickets';
import { api } from '../../api/http';
import { useMeta } from '../../stores/meta';
import AfterSaleComposer from './AfterSaleComposer.vue';
import FieldInput from '../FieldInput.vue';
import { channelChangePurchaseFields } from '../../utils/channelChangePurchaseFields';
import { costPreview } from '../../utils/purchaseCost';
import ChannelChangeSummary from './ChannelChangeSummary.vue';
const props = defineProps({ item: { type: Object, required: true } });
const emit = defineEmits(['close', 'created']);
const meta = useMeta(),
  busy = ref(false),
  loading = ref(true),
  current = ref(null);
const purchaseFields = reactive({});
const purchaseLimit = computed(() => {
  const amount = purchaseFields.purchaseLinkAmount;
  const order = current.value?.orderAmount;
  const tax = current.value?.tax ?? '0';
  if (
    order == null ||
    !Number.isFinite(Number(order)) ||
    !Number.isFinite(Number(tax)) ||
    Number(amount) + Number(tax) <= 0
  )
    return null;
  return costPreview('1.1', amount);
});
onMounted(async () => {
  try {
    const [item] = await Promise.all([api.get(`/orders/${props.item.id}`), meta.load(true)]);
    current.value = item;
    for (const [key] of channelChangePurchaseFields) purchaseFields[key] = item[key] ?? null;
  } catch {
    /* 请求拦截器提示错误，保留关闭和重试入口。 */
  } finally {
    loading.value = false;
  }
});
async function submit(body) {
  return channelChangesApi.create({
    ...body,
    itemId: current.value.id,
    itemVersion: current.value.version,
    purchaseFields: { ...purchaseFields },
  });
}
</script>
<template>
  <el-dialog
    :model-value="true"
    title="创建渠道变更工单"
    width="760px"
    style="max-width: calc(100vw - 24px)"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    @close="emit('close')"
  >
    <div v-loading="loading">
      <template v-if="current">
        <ChannelChangeSummary :item="current" />
        <p>
          变更前采购渠道：<strong>{{ current.purchaseChannel?.join(' / ') || '未分配' }}</strong>
        </p>
        <el-form label-position="top" :disabled="busy">
          <div class="purchase-fields">
            <el-form-item
              v-for="[key, label] in channelChangePurchaseFields"
              :key="key"
              :label="label"
              :class="{ full: key === 'purchaseUrl' }"
            >
              <FieldInput
                v-if="meta.fieldMap[key]"
                :field="meta.fieldMap[key]"
                v-model="purchaseFields[key]"
              />
            </el-form-item>
            <el-form-item label="采购限价（自动计算）">
              <el-input
                :model-value="purchaseLimit ?? ''"
                readonly
                placeholder="根据采购商品链接金额计算"
              />
              <span class="limit-hint">采购商品链接金额 × 1.1</span>
            </el-form-item>
          </div>
        </el-form>
        <el-alert
          title="创建仅提交变更申请。由采购或管理员选择采购渠道并确认变更后，才会一起更新订单采购渠道及申请的采购信息。清空字段后确认会清除对应订单值。"
          type="info"
          :closable="false"
          style="margin-bottom: 16px"
        />
        <AfterSaleComposer
          subject="变更"
          label="创建工单"
          :disabled="!current.manualEditable"
          :submit="submit"
          @busy="busy = $event"
          @sent="emit('created', $event)"
        />
      </template>
      <el-empty v-else-if="!loading" description="订单信息加载失败，请关闭后重试" />
    </div>
  </el-dialog>
</template>

<style scoped>
.purchase-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 20px;
}
.full {
  grid-column: 1 / -1;
}
.limit-hint {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
@media (max-width: 540px) {
  .purchase-fields {
    grid-template-columns: 1fr;
  }
}
</style>
