<script setup>
import { reactive, ref, watch, computed } from 'vue';
import { ElMessage } from 'element-plus';
import FieldInput from './FieldInput.vue';
import { useMeta } from '../stores/meta';
import { orderApi } from '../api/orders';
import { canEditOrder } from '../utils/orderWritePolicy';
import { fmtBeijingDate } from '../utils/format';
const platformReadOnly = (field) =>
  field.group === 'product' || ['orderNumber', 'shopName', 'fulfillmentParty'].includes(field.key);
const props = defineProps({ modelValue: Boolean, item: Object });
const emit = defineEmits(['update:modelValue', 'saved']);
const meta = useMeta(),
  form = reactive({}),
  original = ref({}),
  conflictMessage = ref(''),
  busy = ref(false),
  initializing = ref(false),
  uploadingFields = reactive(new Set()),
  openGroups = ref(['order', 'purchase']);
const visible = computed({ get: () => props.modelValue, set: (v) => emit('update:modelValue', v) });
// 多个图片字段可分别上传；全部结束后才能保存，避免丢失尚未返回的图片地址。
const blocked = computed(() => busy.value || initializing.value || uploadingFields.size > 0);
function trackUpload(key, uploading) {
  if (uploading) uploadingFields.add(key);
  else uploadingFields.delete(key);
}
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
        .filter((field) => !platformReadOnly(field))
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
              ><template v-if="platformReadOnly(field)">
                <el-image
                  v-if="field.type === 'image' && form[field.key]"
                  :src="meta.imageUrl(form[field.key], true)"
                  :preview-src-list="[meta.imageUrl(form[field.key])]"
                  fit="contain"
                  preview-teleported
                  style="width: 100px; height: 100px"
                />
                <span v-else style="overflow-wrap: anywhere">{{ form[field.key] ?? '—' }}</span>
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
