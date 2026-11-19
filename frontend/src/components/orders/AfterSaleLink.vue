<script setup>
import { inject } from 'vue';
defineProps({ ticket: Object });
const openInOrders = inject('openPurchaseAfterSale', null);
function open(event, ticket, navigate) {
  if (
    openInOrders &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.altKey &&
    event.button === 0
  ) {
    event.preventDefault();
    openInOrders(ticket);
  } else navigate(event);
}
</script>
<template>
  <router-link
    v-if="ticket"
    custom
    v-slot="{ href, navigate }"
    :to="{ path: '/purchase-after-sales', query: { ticket: ticket.id } }"
  >
    <a
      :href="href"
      class="after-sale-link"
      title="查看采购售后详情"
      @click.stop="open($event, ticket, navigate)"
    >
      <el-tag :type="ticket.status === 'completed' ? 'success' : 'warning'" size="small">
        {{ ticket.status === 'completed' ? '售后完毕' : '采购售后处理中' }}
      </el-tag>
    </a>
  </router-link>
</template>
<style scoped>
.after-sale-link {
  display: inline-flex;
  flex: 0 0 auto;
  text-decoration: none;
}
</style>
