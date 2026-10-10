<script setup>
import { reactive, ref, watch, computed } from 'vue';
import { ElMessage } from 'element-plus';
import FieldInput from './FieldInput.vue';
import { useMeta } from '../stores/meta';
import { orderApi } from '../api/orders';
import { canEditOrder } from '../utils/orderWritePolicy';
import { fmtDate } from '../utils/format';
const platformReadOnly = (field) =>
  field.group === 'product' || ['orderNumber', 'shopName', 'fulfillmentParty'].includes(field.key);
const props = defineProps({ modelValue: Boolean, item: Object });
const emit = defineEmits(['update:modelValue', 'saved']);
const meta = useMeta(),
  form = reactive({}),
  busy = ref(false),
  openGroups = ref(['order', 'purchase']);
const visible = computed({ get: () => props.modelValue, set: (v) => emit('update:modelValue', v) });
const sections = [
  { key: 'order', label: '订单信息', note: '订单身份、平台时间与状态' },
  { key: 'product', label: '商品与收件信息', note: '由 Walmart 同步 · 只读' },
  { key: 'purchase', label: '采购与交付', note: '采购准备、物流记录、售后及结算' },
];
watch(
  () => props.modelValue,
  async (show) => {
    if (!show) return;
    await meta.load();
    openGroups.value = ['order', 'purchase'];
    for (const f of meta.fields) {
      let value = props.item?.[f.key] ?? null;
      if (f.type === 'datetime' && value)
        value = new Date(value).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
      form[f.key] = value;
    }
  },
  { immediate: true },
);
/** 仅提交可编辑字段；用户主动清空的 null 必须保留，商品字段由官方同步维护。 */
async function save() {
  if (!canEditOrder(props.item)) return ElMessage.warning('WFS 订单只读，不能修改');
  busy.value = true;
  try {
    const fields = Object.fromEntries(
      meta.fields
        .filter((field) => field.group !== 'product')
        .map((field) => [field.key, form[field.key]]),
    );
    if (props.item?.id) await orderApi.update(props.item.id, fields, props.item.version);
    else await orderApi.create(fields);
    ElMessage.success('商品明细已保存');
    emit('saved');
    visible.value = false;
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
    destroy-on-close
    ><div class="drawer-intro">
      <span class="pill">{{ item?.orderNumber || '新订单' }}</span
      ><span class="muted">{{
        item?.walmartSku || '店铺名＋订单号＋WalmartSku 识别明细，WalmartSku、店铺名可留空'
      }}</span>
    </div>
    <el-alert
      v-if="item?.addressRisk"
      title="风险地址订单"
      :description="item.addressRiskNote || '收件地址与风险地址库匹配，请核对后采购。'"
      type="error"
      :closable="false"
      show-icon
    />
    <el-form label-position="top"
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
              <span>{{ fmtDate(item?.purchaseConfirmedAt, true) }}</span>
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
              <FieldInput v-else :field="field" v-model="form[field.key]"
            /></el-form-item></div></el-collapse-item></el-collapse></el-form
    ><template #footer
      ><span class="muted drawer-tip">页面内清空字段并保存，会主动清除该字段。</span
      ><el-button @click="visible = false">取消</el-button
      ><el-button type="primary" :loading="busy" @click="save">保存修改</el-button></template
    ></el-drawer
  >
</template>
