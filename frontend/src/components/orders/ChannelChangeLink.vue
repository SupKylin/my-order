<script setup>
import { inject } from 'vue';
defineProps({ ticket: Object });
const openInOrders = inject('openChannelChange', null);
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
    :to="{ path: '/channel-change-tickets', query: { ticket: ticket.id } }"
  >
    <a
      :href="href"
      title="查看渠道变更工单"
      style="display: inline-flex; text-decoration: none"
      @click.stop="open($event, ticket, navigate)"
    >
      <el-tag size="small" :type="ticket.status === 'completed' ? 'info' : 'warning'">{{
        ticket.status === 'completed' ? '渠道变更已关闭' : '渠道变更处理中'
      }}</el-tag>
    </a>
  </router-link>
</template>
