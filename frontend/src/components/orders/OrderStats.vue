<script setup>
import { Box, User, ShoppingCart, Warning, ArrowRight } from '@element-plus/icons-vue';
defineProps({ stats: { type: Object, required: true } });
const emit = defineEmits(['filter']);
const cards = [
  {
    label: '商品明细总数',
    icon: Box,
    caption: '按店铺名＋订单号＋WalmartSku 统计',
    kind: 'all',
    valueKey: 'total',
  },
  {
    label: '待分配采购',
    icon: User,
    caption: '尚未指定采购人员',
    kind: 'unassigned',
    valueKey: 'unassigned',
  },
  {
    label: '采购进行中',
    icon: ShoppingCart,
    caption: '采购状态为采购中',
    kind: 'progress',
    valueKey: 'inProgress',
  },
  {
    label: '售后跟进',
    icon: Warning,
    caption: '已标记需要售后',
    kind: 'afterSales',
    valueKey: 'afterSales',
  },
];
</script>
<template>
  <div class="stats-grid">
    <button
      v-for="(card, index) in cards"
      :key="card.kind"
      class="stat-card"
      @click="emit('filter', card.kind)"
    >
      <div class="stat-heading">
        <span>{{ card.label }}</span>
        <div class="stat-icon" :class="'tone-' + index">
          <el-icon :size="20"><component :is="card.icon" /></el-icon>
        </div>
      </div>
      <strong>{{ stats[card.valueKey].toLocaleString() }}</strong>
      <div class="stat-caption">
        {{ card.caption }}<el-icon><ArrowRight /></el-icon>
      </div>
    </button>
  </div>
</template>
