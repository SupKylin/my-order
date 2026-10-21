<script setup>
import { computed } from 'vue';

const props = defineProps({
  stores: { type: Array, default: () => [] },
  modelValue: { type: [Number, String], default: null },
});
const emit = defineEmits(['update:modelValue']);
const options = computed(() => {
  const owners = new Map();
  for (const store of props.stores) {
    if (store.ownerId == null) continue;
    owners.set(store.ownerId, {
      id: store.ownerId,
      label: store.ownerUsername ? `${store.owner}（${store.ownerUsername}）` : store.owner,
    });
  }
  return [...owners.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
});
</script>

<template>
  <el-select
    :model-value="modelValue"
    class="store-owner-select"
    placeholder="全部所属账号"
    aria-label="店铺所属账号"
    filterable
    clearable
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-option v-for="owner in options" :key="owner.id" :value="owner.id" :label="owner.label" />
  </el-select>
</template>

<style scoped>
.store-owner-select {
  width: 210px;
  max-width: 100%;
}
</style>
