<script setup>
import DailyStatistics from '../components/home/DailyStatistics.vue';
import StoreOverview from '../components/home/StoreOverview.vue';
</script>

<template>
  <div class="overview-scroll">
    <div class="summary-section">
      <StoreOverview />
    </div>
    <div class="summary-section">
      <DailyStatistics by-store />
    </div>
  </div>
</template>

<style scoped>
.overview-scroll {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-gutter: stable;
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding-right: 8px;
}
.summary-section {
  flex: 0 0 auto;
  height: max(680px, calc(100vh - 180px));
  min-width: 0;
}
</style>
