<script setup>
import { computed } from 'vue';
import { useMeta } from '../stores/meta';
const channelId = defineModel({ type: Number, default: null });
defineProps({ disabled: Boolean });
const meta = useMeta();
const unavailable = computed(
  () => channelId.value && !meta.purchaseChannels.some((channel) => channel.id === channelId.value),
);
</script>
<template>
  <el-form-item label="绑定采购渠道（可选）">
    <el-select
      v-model="channelId"
      clearable
      filterable
      :disabled="disabled"
      placeholder="不绑定，按 Excel 内容导入"
      :value-on-clear="null"
    >
      <el-option
        v-if="unavailable"
        :value="channelId"
        label="原渠道已停用，请重选或清空"
        disabled
      />
      <el-option
        v-for="channel in meta.purchaseChannels"
        :key="channel.id"
        :value="channel.id"
        :label="channel.value"
      />
    </el-select>
    <p class="mapping-footnote">Excel 已映射的采购渠道有值时优先使用；空白或未映射时使用此渠道。</p>
  </el-form-item>
</template>
