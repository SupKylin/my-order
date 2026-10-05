<script setup>
import { defineAsyncComponent } from 'vue';
import { Search, Plus, Upload, Refresh, User, Delete } from '@element-plus/icons-vue';
import { useOrders } from '../composables/useOrders';
import OrderTable from '../components/orders/OrderTable.vue';
import { PLATFORM_TIME_LABEL } from '../utils/businessTime';
// 弹窗只在打开时挂载，因此不会提前下载编辑表单和图片上传逻辑。
const OrderEditor = defineAsyncComponent(() => import('../components/OrderEditor.vue'));
const AssignmentDialog = defineAsyncComponent(
  () => import('../components/orders/AssignmentDialog.vue'),
);
const {
  router,
  meta,
  auth,
  loading,
  rows,
  total,
  selected,
  users,
  editing,
  editor,
  assignDialog,
  assignmentItems,
  assignee,
  assignBusy,
  deleteBusy,
  stats,
  shippingCounts,
  warningNow,
  filters,
  dates,
  shipDates,
  table,
  load,
  refresh,
  search,
  reset,
  edit,
  openAssign,
  assign,
  remove,
} = useOrders();
</script>
<template>
  <div class="orders-page">
    <div class="shipping-legend">
      <strong>发货预警：</strong>
      <span class="shipping-badge shipping-yellow"
        >黄色=剩2天（{{ shippingCounts.yellow }} 条）</span
      >
      <span>·</span>
      <span class="shipping-badge shipping-orange"
        >橙色≤24小时（{{ shippingCounts.orange }} 条）</span
      >
      <span>·</span>
      <span class="shipping-badge shipping-red">红色=已逾期（{{ shippingCounts.red }} 条）</span>
      <span class="muted">当前筛选全部明细</span>
      <span class="muted">以平台发货日期当天 23:59:59（{{ PLATFORM_TIME_LABEL }}）为截止时间</span>
    </div>
    <section class="panel orders-panel">
      <div class="panel-heading">
        <div>
          <h2>
            订单商品明细<span class="count-label">{{ total }} 条</span>
          </h2>
          <p>每行对应一条商品明细，可展开查看商品和收件信息，或勾选后批量分配采购人员。</p>
        </div>
        <div class="button-row">
          <el-button :icon="Refresh" @click="refresh">刷新</el-button
          ><el-button :icon="Plus" @click="edit(null)">新增明细</el-button
          ><el-button :icon="User" :disabled="!selected.length" @click="openAssign()"
            >分配采购</el-button
          ><el-button
            type="danger"
            plain
            :icon="Delete"
            :disabled="!selected.length || loading"
            :loading="deleteBusy"
            @click="remove()"
            >批量删除</el-button
          ><el-button type="primary" :icon="Upload" @click="router.push('/imports/new')"
            >导入订单</el-button
          >
        </div>
      </div>
      <div class="filter-bar">
        <el-input
          v-model="filters.q"
          :prefix-icon="Search"
          clearable
          placeholder="搜索订单号、SKU、商品或物流单号"
          class="search-input"
          @keyup.enter="search"
        /><el-select v-model="filters.shopName" placeholder="全部店铺" clearable filterable
          ><el-option
            v-for="shop in stats.shops"
            :key="shop"
            :label="shop"
            :value="shop" /></el-select
        ><el-select v-model="filters.purchaseStatus" placeholder="采购状态" clearable
          ><el-option
            v-for="status in meta.fieldMap.purchaseStatus?.options"
            :key="status"
            :label="status"
            :value="status" /></el-select
        ><el-select v-model="filters.assignedTo" placeholder="全部采购人员" clearable
          ><el-option label="待分配" value="unassigned" /><el-option
            v-for="user in users.filter((u) => u.active)"
            :key="user.id"
            :label="`${user.username} · ${user.displayName}`"
            :value="user.id" /></el-select
        ><el-button type="primary" plain :icon="Search" @click="search">查询</el-button
        ><el-button text @click="reset">重置</el-button>
      </div>
      <div class="filter-bar filter-secondary">
        <el-select v-model="filters.purchaseChannel" placeholder="采购渠道" clearable filterable>
          <el-option
            v-for="channel in meta.fieldMap.purchaseChannel?.options"
            :key="channel"
            :label="channel"
            :value="channel"
          />
        </el-select>
        <el-select v-model="filters.orderStatus" placeholder="订单状态" clearable
          ><el-option
            v-for="status in meta.fieldMap.orderStatus?.options"
            :key="status"
            :label="status"
            :value="status" /></el-select
        ><el-select v-model="filters.allocatable" placeholder="是否可分配" clearable
          ><el-option label="是" value="是" /><el-option label="否" value="否" /></el-select
        ><el-select v-model="filters.settlement" placeholder="结算情况" clearable
          ><el-option label="已结算" value="已结算" /><el-option
            label="未结算"
            value="未结算" /></el-select
        ><el-date-picker
          v-model="dates"
          type="daterange"
          value-format="YYYY-MM-DD"
          start-placeholder="出单开始日期"
          end-placeholder="出单结束日期"
          range-separator="至"
        /><el-date-picker
          v-model="shipDates"
          type="daterange"
          value-format="YYYY-MM-DD"
          start-placeholder="平台发货开始日期"
          end-placeholder="平台发货结束日期"
          range-separator="至"
        /><el-button
          text
          type="primary"
          @click="
            filters.assignedTo = auth.user.id;
            search();
          "
          >只看分配给我的</el-button
        >
      </div>
      <div v-if="selected.length" class="selection-bar">
        <span
          >已选中 <strong>{{ selected.length }}</strong> 条商品明细</span
        ><el-button type="primary" size="small" :icon="User" @click="openAssign()"
          >批量分配采购</el-button
        ><el-button text size="small" @click="table.clearSelection()">取消选择</el-button>
      </div>
      <div class="order-table-region">
        <OrderTable
          ref="table"
          :rows="rows"
          :loading="loading"
          :deleting="deleteBusy"
          :warning-now="warningNow"
          @selection-change="selected = $event"
          @edit="edit"
          @assign="openAssign"
          @delete="remove"
          @import="router.push('/imports/new')"
        />
      </div>
      <div class="table-footer">
        <span class="muted"
          >导入优先匹配同订单同渠道，无渠道旧明细按订单号补匹配；重复行按顺序更新</span
        ><el-pagination
          v-model:current-page="filters.page"
          v-model:page-size="filters.pageSize"
          :total="total"
          :page-sizes="[20, 50, 100]"
          layout="total, sizes, prev, pager, next"
          @current-change="load"
          @size-change="search"
        />
      </div>
    </section>
  </div>
  <OrderEditor v-if="editor" v-model="editor" :item="editing" @saved="refresh" />
  <AssignmentDialog
    v-if="assignDialog"
    v-model="assignDialog"
    v-model:assignee="assignee"
    :count="assignmentItems.length"
    :users="users"
    :assign-busy="assignBusy"
    @submit="assign"
  />
</template>
