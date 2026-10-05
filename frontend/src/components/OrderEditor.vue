<script setup>
import { reactive, ref, watch, computed } from 'vue';
import { ElMessage } from 'element-plus';
import FieldInput from './FieldInput.vue';
import { useMeta } from '../stores/meta';
import { orderApi } from '../api/orders';
const props = defineProps({ modelValue: Boolean, item: Object });
const emit = defineEmits(['update:modelValue', 'saved']);
const meta = useMeta(),
  form = reactive({}),
  busy = ref(false),
  openGroups = ref(['order', 'purchase']);
const visible = computed({ get: () => props.modelValue, set: (v) => emit('update:modelValue', v) });
const sections = [
  { key: 'order', label: '订单信息', note: '订单身份、平台时间与状态' },
  { key: 'product', label: '商品与收件信息', note: '商品、数量及收件地址 · 默认折叠' },
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
/** 人工编辑提交完整表单：用户主动清空的 null 必须保留，不能按导入规则过滤。 */
async function save() {
  busy.value = true;
  try {
    if (props.item?.id) await orderApi.update(props.item.id, { ...form }, props.item.version);
    else await orderApi.create({ ...form });
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
      ><span class="muted">{{ item?.sku || '订单号＋采购渠道识别明细，SKU 可留空' }}</span>
    </div>
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
            <el-form-item
              v-for="field in meta.fields.filter((f) => f.group === section.key)"
              :key="field.key"
              :label="field.label"
              :required="field.required"
              :class="{ 'full-width': ['textarea', 'url'].includes(field.type) }"
              ><FieldInput :field="field" v-model="form[field.key]"
            /></el-form-item></div></el-collapse-item></el-collapse></el-form
    ><template #footer
      ><span class="muted drawer-tip">页面内清空字段并保存，会主动清除该字段。</span
      ><el-button @click="visible = false">取消</el-button
      ><el-button type="primary" :loading="busy" @click="save">保存修改</el-button></template
    ></el-drawer
  >
</template>
