<script setup>
import { useMeta } from '../../stores/meta';
const assignDialog = defineModel({ type: Boolean });
const assignee = defineModel('assignee', { type: [String, Number] });
defineProps({ count: Number, users: { type: Array, required: true }, assignBusy: Boolean });
const emit = defineEmits(['submit']);
const meta = useMeta();
</script>
<template>
  <el-dialog v-model="assignDialog" title="分配采购人员" width="460px"
    ><p class="dialog-description">为选中的 {{ count }} 条商品明细指定采购人员。</p>
    <el-form label-position="top"
      ><el-form-item label="采购人员"
        ><el-select v-model="assignee" placeholder="选择采购人员" filterable
          ><el-option value="unassign" label="取消分配（恢复待分配）" /><el-option
            v-for="user in users.filter((u) => u.active)"
            :key="user.id"
            :value="user.id"
            :label="`${user.username} · ${user.displayName} · ${meta.roles[user.role]}`" /></el-select></el-form-item></el-form
    ><el-alert
      title="标记为“不可分配”的商品不能分配，请先调整状态。"
      type="info"
      :closable="false"
    /><template #footer
      ><el-button @click="assignDialog = false">取消</el-button
      ><el-button type="primary" :loading="assignBusy" @click="emit('submit')"
        >确认分配</el-button
      ></template
    ></el-dialog
  >
</template>
