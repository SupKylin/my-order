<script setup>
import { reactive, ref, watch, computed } from 'vue';
import { ElMessage } from 'element-plus';
import FieldInput from './FieldInput.vue';
import { useMeta } from '../stores/meta';
import { useAuth } from '../stores/auth';
import { canManageProcurement } from '../utils/permissions';
import { orderApi } from '../api/orders';
import { canEditOrder } from '../utils/orderWritePolicy';
import { fmtBeijingDate } from '../utils/format';
import { imageValues as parseImageValues } from '../utils/image-values';
import { costPreview, fixedDecimal } from '../utils/purchaseCost';
const platformReadOnly = (field) =>
  field.group === 'product' || ['orderNumber', 'shopName', 'fulfillmentParty'].includes(field.key);
const derivedPurchaseFields = new Set(['purchaseLimit', 'priceFactor']);
const props = defineProps({ modelValue: Boolean, item: Object });
const emit = defineEmits(['update:modelValue', 'saved']);
const meta = useMeta(),
  auth = useAuth(),
  form = reactive({}),
  original = ref({}),
  conflictMessage = ref(''),
  busy = ref(false),
  initializing = ref(false),
  uploadingFields = reactive(new Set()),
  openGroups = ref(['order', 'purchase']);
const fieldReadOnly = (field) =>
  field.readOnly ||
  platformReadOnly(field) ||
  derivedPurchaseFields.has(field.key) ||
  (!canManageProcurement(auth.user?.role) &&
    ['purchaseStatus', 'purchaseChannel'].includes(field.key));
const visible = computed({ get: () => props.modelValue, set: (v) => emit('update:modelValue', v) });
const costChannels = computed(() => form.purchaseChannel || []);
const costChanged = computed(
  () => (form.purchaseCostChannel || null) !== (original.value.purchaseCostChannel || null),
);
const newCostSnapshot = computed(
  () =>
    form.settlement === '已结算' && (original.value.settlement !== '已结算' || costChanged.value),
);
const costChannel = computed(() =>
  costChanged.value
    ? form.purchaseCostChannel
    : newCostSnapshot.value && costChannels.value.length === 1
      ? costChannels.value[0]
      : form.purchaseCostChannel,
);
const costDiscount = computed(() =>
  form.settlement !== '已结算'
    ? null
    : newCostSnapshot.value
      ? meta.purchaseChannels.find((channel) => channel.value === costChannel.value)
          ?.purchaseDiscount
      : original.value.purchaseDiscount,
);
const displayedDiscount = computed(() =>
  costDiscount.value == null ? '—' : fixedDecimal(costDiscount.value, 4),
);
const displayedCost = computed(() =>
  form.settlement !== '已结算'
    ? '—'
    : newCostSnapshot.value || form.purchaseAmount !== original.value.purchaseAmount
      ? (costPreview(costDiscount.value, form.purchaseAmount) ?? '—')
      : (original.value.purchaseCost ?? '—'),
);
// 多个图片字段可分别上传；全部结束后才能保存，避免丢失尚未返回的图片地址。
const blocked = computed(() => busy.value || initializing.value || uploadingFields.size > 0);
function trackUpload(key, uploading) {
  if (uploading) uploadingFields.add(key);
  else uploadingFields.delete(key);
}
const imageListFor = (value) => parseImageValues(value);
const imageUrlsFor = (value) => imageListFor(value).map((path) => meta.imageUrl(path));
const sections = [
  { key: 'order', label: '订单信息', note: '订单身份、平台时间与状态' },
  { key: 'product', label: '商品与收件信息', note: '由 Walmart 同步 · 只读' },
  { key: 'purchase', label: '采购与交付', note: '采购准备、物流记录、售后及结算' },
];
watch(
  () => props.modelValue,
  async (show) => {
    if (!show) return;
    initializing.value = true;
    try {
      await meta.load();
      openGroups.value = ['order', 'purchase'];
      conflictMessage.value = '';
      for (const f of meta.fields) {
        let value = props.item?.[f.key] ?? null;
        if (f.type === 'datetime' && value)
          value = new Date(value).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
        form[f.key] = value;
      }
      original.value = JSON.parse(JSON.stringify(form));
    } finally {
      initializing.value = false;
    }
  },
  { immediate: true },
);
/** 只提交用户实际修改的字段及其原值，避免旧表单覆盖后台同步或他人的无关修改。 */
async function save() {
  if (blocked.value) return;
  if (!canEditOrder(props.item)) return ElMessage.warning('WFS 订单只读，不能修改');
  busy.value = true;
  try {
    const fields = Object.fromEntries(
      meta.fields
        .filter((field) => !fieldReadOnly(field))
        .filter(
          (field) => JSON.stringify(form[field.key]) !== JSON.stringify(original.value[field.key]),
        )
        .map((field) => [field.key, form[field.key]]),
    );
    if (!Object.keys(fields).length) {
      ElMessage.info('没有需要保存的修改');
      return;
    }
    const baseFields = Object.fromEntries(
      Object.keys(fields).map((key) => [key, original.value[key]]),
    );
    if (
      ['settlement', 'purchaseAmount', 'purchaseCostChannel'].some((key) =>
        Object.hasOwn(fields, key),
      )
    )
      for (const key of [
        'settlement',
        'purchaseAmount',
        'purchaseCostChannel',
        'purchaseChannel',
        'purchaseDiscount',
      ])
        baseFields[key] = original.value[key];
    if (props.item?.id)
      await orderApi.update(props.item.id, fields, props.item.version, baseFields);
    else await orderApi.create(fields);
    ElMessage.success('商品明细已保存');
    emit('saved');
    visible.value = false;
  } catch (error) {
    if (error.response?.status === 409) {
      const details = error.response.data.details;
      conflictMessage.value = details?.length
        ? `以下字段已发生变化：${details.map((entry) => entry.label || entry.field).join('、')}。本次填写内容已保留，请核对最新数据后再修改。`
        : `${error.response.data.message}。本次填写内容已保留。`;
    }
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <el-drawer
    v-model="visible"
    :title="item?.id ? '编辑商品明细' : '新增商品明细'"
    size="800px"
    :close-on-click-modal="false"
    :close-on-press-escape="!blocked"
    :show-close="!blocked"
    destroy-on-close
    ><div class="drawer-intro">
      <span class="pill">{{ item?.orderNumber || '新订单' }}</span
      ><span class="muted">{{
        item?.walmartSku || '店铺名＋订单号＋WalmartSku 识别明细，WalmartSku、店铺名可留空'
      }}</span>
    </div>
    <el-alert
      v-if="conflictMessage"
      :title="conflictMessage"
      type="warning"
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="item?.addressRisk"
      title="风险地址订单"
      :description="item.addressRiskNote || '收件地址与风险地址库匹配，请核对后采购。'"
      type="error"
      :closable="false"
      show-icon
    />
    <el-form v-loading="initializing" :disabled="busy || initializing" label-position="top"
      ><el-collapse v-model="openGroups"
        ><el-collapse-item v-for="section in sections" :key="section.key" :name="section.key"
          ><template #title
            ><div class="section-heading">
              <strong>{{ section.label }}</strong
              ><span>{{ section.note }}</span>
            </div></template
          >
          <div class="form-grid">
            <el-form-item v-if="section.key === 'purchase'" label="采购成功时间（北京时间）">
              <span>{{ fmtBeijingDate(item?.purchaseConfirmedAt) }}</span>
            </el-form-item>
            <el-form-item
              v-for="field in meta.fields.filter((f) => f.group === section.key)"
              :key="field.key"
              :label="field.label"
              :required="field.required"
              :class="{ 'full-width': ['textarea', 'url'].includes(field.type) }"
              ><template v-if="field.key === 'purchaseCostChannel'">
                <el-select
                  :model-value="costChannel"
                  clearable
                  placeholder="选择成本计算渠道"
                  @update:model-value="form.purchaseCostChannel = $event || null"
                >
                  <el-option
                    v-for="channel in costChannels"
                    :key="channel"
                    :label="channel"
                    :value="channel"
                  />
                  <el-option
                    v-if="costChannel && !costChannels.includes(costChannel)"
                    :label="`${costChannel}（历史结算渠道）`"
                    :value="costChannel"
                    disabled
                  />
                </el-select>
                <span class="muted"
                  >单渠道结算时自动使用；多渠道请选择一个。更改此项并保存会使用新渠道当前折扣。</span
                >
              </template>
              <template v-else-if="['purchaseDiscount', 'purchaseCost'].includes(field.key)">
                <span>{{
                  field.key === 'purchaseDiscount' ? displayedDiscount : displayedCost
                }}</span>
                <span class="muted">{{
                  field.key === 'purchaseDiscount'
                    ? '采购渠道汇率 ÷ 当前实时汇率 × 税金；结算时保存折扣'
                    : '采购成本 = 已保存的采购折扣 × 采购金额；保存后生效'
                }}</span>
              </template>
              <template v-else-if="fieldReadOnly(field)">
                <el-tag
                  v-if="field.key === 'shopName' && item?.storeIsThirdParty"
                  size="small"
                  type="warning"
                  >三方</el-tag
                >
                <div
                  v-if="field.type === 'image' && imageListFor(form[field.key]).length"
                  class="image-preview-list"
                >
                  <el-image
                    v-for="(path, index) in imageListFor(form[field.key])"
                    :key="path"
                    :src="meta.imageUrl(path, true)"
                    :preview-src-list="imageUrlsFor(form[field.key])"
                    :initial-index="index"
                    fit="contain"
                    preview-teleported
                    style="width: 100px; height: 100px"
                  />
                </div>
                <span v-else style="overflow-wrap: anywhere">{{
                  Array.isArray(form[field.key])
                    ? form[field.key].join(' / ') || '—'
                    : (form[field.key] ?? '—')
                }}</span>
              </template>
              <template v-else-if="field.key === 'purchaseChannel' && form.allocatable !== '是'">
                <span>{{ form.purchaseChannel?.join(' / ') || '未分配' }}</span>
                <el-button
                  v-if="form.purchaseChannel?.length"
                  text
                  @click="form.purchaseChannel = null"
                  >清空渠道</el-button
                >
                <span class="muted">请先将是否可分配设置为“是”后选择渠道</span>
              </template>
              <FieldInput
                v-else
                :field="field"
                v-model="form[field.key]"
                @uploading="trackUpload(field.key, $event)"
              />
            </el-form-item></div></el-collapse-item></el-collapse></el-form
    ><template #footer
      ><span class="muted drawer-tip">页面内清空字段并保存，会主动清除该字段。</span
      ><el-button :disabled="blocked" @click="visible = false">取消</el-button
      ><el-button
        type="primary"
        :loading="busy"
        :disabled="initializing || uploadingFields.size > 0"
        @click="save"
        >保存修改</el-button
      ></template
    ></el-drawer
  >
</template>
