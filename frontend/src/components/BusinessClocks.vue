<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { businessClocks } from '../utils/businessTime';

const now = ref(Date.now());
const clocks = computed(() => businessClocks(now.value));
let timer;
onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 1000);
});
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <div class="business-clocks" aria-label="中美时间">
    <div>
      <span>中国 · 北京时间</span><time>{{ clocks.china }}</time>
    </div>
    <div title="美国西部标准时间，固定 UTC−8，不切换夏令时">
      <span>美国 · PST（UTC−8）</span><time>{{ clocks.platform }}</time>
    </div>
  </div>
</template>

<style scoped>
.business-clocks {
  display: grid;
  gap: 5px;
  font-size: 11px;
  line-height: 1.5;
}
.business-clocks > div {
  display: flex;
  justify-content: space-between;
  gap: 14px;
}
.business-clocks span {
  color: #84939c;
  white-space: nowrap;
}
.business-clocks time {
  color: #3c535e;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
@media (max-width: 640px) {
  .business-clocks {
    font-size: 10px;
  }
  .business-clocks > div {
    gap: 8px;
  }
}
</style>
