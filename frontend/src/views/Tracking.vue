<script setup>
import { computed, onMounted, ref } from 'vue';
import { Search, Refresh, View, Document } from '@element-plus/icons-vue';
import { orderApi } from '../api/orders';
import { track123DocsApi } from '../api/track123-docs';
import { useAuth } from '../stores/auth';
import TrackingDialog from '../components/orders/TrackingDialog.vue';

const auth = useAuth();
const isAdmin = computed(() => auth.user?.role === 'admin');
const tab = ref('shipments');
const draft = ref('');
const query = ref('');
const rows = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(20);
const loading = ref(false);
const selected = ref(null);
let listVersion = 0;

async function loadShipments() {
  const version = ++listVersion;
  loading.value = true;
  try {
    const result = await orderApi.trackingItems({
      q: query.value,
      page: page.value,
      pageSize: pageSize.value,
    });
    if (version !== listVersion) return;
    rows.value = result.rows;
    total.value = result.total;
  } finally {
    if (version === listVersion) loading.value = false;
  }
}

function searchShipments() {
  query.value = draft.value.trim();
  page.value = 1;
  loadShipments();
}

function resetShipments() {
  draft.value = '';
  query.value = '';
  page.value = 1;
  loadShipments();
}

const docsDraft = ref('');
const docsQuery = ref('');
const endpoints = ref([]);
const docsLoading = ref(false);
const detailLoading = ref(false);
const detail = ref(null);
const docsLoaded = ref(false);

async function loadEndpoints() {
  docsLoading.value = true;
  detail.value = null;
  try {
    endpoints.value = await track123DocsApi.endpoints(docsQuery.value);
    docsLoaded.value = true;
  } finally {
    docsLoading.value = false;
  }
}

function searchEndpoints() {
  docsQuery.value = docsDraft.value.trim();
  loadEndpoints();
}

async function openEndpoint(row) {
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await track123DocsApi.endpoint(row.path, row.method);
  } finally {
    detailLoading.value = false;
  }
}

function changeTab(value) {
  if (value === 'docs' && !docsLoaded.value) loadEndpoints();
}

onMounted(loadShipments);
</script>

<template>
  <div class="tracking-page">
    <div class="tracking-page-head">
      <div>
        <h1>物流追踪</h1>
        <p>内部物流单号</p>
      </div>
      <span class="tracking-source">Track123</span>
    </div>

    <el-tabs v-model="tab" @tab-change="changeTab">
      <el-tab-pane label="运单查询" name="shipments">
        <div class="tracking-toolbar">
          <el-input
            v-model="draft"
            clearable
            placeholder="搜索物流单号、订单号、店铺或 Walmart SKU"
            :prefix-icon="Search"
            class="tracking-search"
            @keyup.enter="searchShipments"
            @clear="resetShipments"
          />
          <el-button type="primary" :icon="Search" :loading="loading" @click="searchShipments"
            >查询</el-button
          >
          <el-button :icon="Refresh" :loading="loading" @click="loadShipments">刷新</el-button>
        </div>
        <el-table :data="rows" v-loading="loading" row-key="id" class="tracking-table">
          <el-table-column label="内部物流单号" prop="trackingNumber" min-width="210">
            <template #default="{ row }">
              <span class="tracking-number">{{ row.trackingNumber }}</span>
            </template>
          </el-table-column>
          <el-table-column label="订单号" prop="orderNumber" min-width="170" />
          <el-table-column label="店铺" prop="shopName" min-width="130" />
          <el-table-column label="商品" prop="productName" min-width="210" show-overflow-tooltip />
          <el-table-column label="Walmart SKU" prop="walmartSku" min-width="150" />
          <el-table-column label="操作" width="105" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" :icon="View" @click="selected = row"
                >查看轨迹</el-button
              >
            </template>
          </el-table-column>
          <template #empty>
            <el-empty description="没有找到已填写内部物流单号的订单" />
          </template>
        </el-table>
        <div class="tracking-pagination">
          <span>共 {{ total }} 条</span>
          <el-pagination
            v-model:current-page="page"
            v-model:page-size="pageSize"
            :total="total"
            :page-sizes="[20, 50]"
            layout="sizes, prev, pager, next"
            @current-change="loadShipments"
            @size-change="
              page = 1;
              loadShipments();
            "
          />
        </div>
      </el-tab-pane>

      <el-tab-pane v-if="isAdmin" label="接口文档" name="docs">
        <div class="tracking-toolbar">
          <el-input
            v-model="docsDraft"
            clearable
            placeholder="搜索 Track123 接口"
            :prefix-icon="Search"
            class="tracking-search"
            @keyup.enter="searchEndpoints"
          />
          <el-button type="primary" :icon="Search" :loading="docsLoading" @click="searchEndpoints"
            >搜索</el-button
          >
          <el-button :icon="Refresh" :loading="docsLoading" @click="loadEndpoints">刷新</el-button>
        </div>
        <el-table :data="endpoints" v-loading="docsLoading" class="tracking-table">
          <el-table-column label="方法" prop="method" width="90" />
          <el-table-column label="接口路径" prop="path" min-width="270" />
          <el-table-column label="说明" prop="summary" min-width="190" />
          <el-table-column label="操作" width="100" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" :icon="Document" @click="openEndpoint(row)"
                >查看文档</el-button
              >
            </template>
          </el-table-column>
          <template #empty><el-empty description="没有匹配的接口" /></template>
        </el-table>
        <el-drawer
          :model-value="Boolean(detail) || detailLoading"
          title="接口文档"
          size="min(620px, 96vw)"
          @close="
            detail = null;
            detailLoading = false;
          "
        >
          <div v-loading="detailLoading" class="tracking-doc-detail">
            <template v-if="detail">
              <h2>{{ detail.summary }}</h2>
              <div class="tracking-doc-path">{{ detail.method }} {{ detail.path }}</div>
              <p v-if="detail.description">{{ detail.description }}</p>
              <h3>请求头</h3>
              <el-table :data="detail.parameters" size="small">
                <el-table-column label="名称" prop="name" min-width="170" />
                <el-table-column label="位置" prop="location" width="85" />
                <el-table-column label="必填" width="65">
                  <template #default="{ row }">{{ row.required ? '是' : '否' }}</template>
                </el-table-column>
                <el-table-column label="说明" prop="description" min-width="180" />
              </el-table>
              <template v-if="detail.requestSchema">
                <h3>请求体结构</h3>
                <pre class="tracking-schema">{{
                  JSON.stringify(detail.requestSchema, null, 2)
                }}</pre>
              </template>
            </template>
          </div>
        </el-drawer>
      </el-tab-pane>
    </el-tabs>
    <TrackingDialog v-if="selected" :item="selected" @close="selected = null" />
  </div>
</template>

<style scoped>
.tracking-page {
  padding: 22px 28px 32px;
}
.tracking-page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.tracking-page-head h1 {
  margin: 0;
  font-size: 23px;
}
.tracking-page-head p {
  margin: 5px 0 0;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.tracking-source {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.tracking-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 14px 0;
}
.tracking-search {
  width: min(480px, 100%);
}
.tracking-table {
  width: 100%;
}
.tracking-number,
.tracking-doc-path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-wrap: anywhere;
}
.tracking-pagination {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 18px;
  margin-top: 16px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.tracking-doc-detail {
  min-height: 120px;
}
.tracking-doc-detail h2 {
  margin: 0 0 12px;
  font-size: 18px;
}
.tracking-doc-detail h3 {
  margin: 24px 0 10px;
  font-size: 15px;
}
.tracking-doc-detail p {
  line-height: 1.6;
}
.tracking-doc-path {
  padding: 10px 12px;
  background: var(--el-fill-color-light);
  font-size: 13px;
}
.tracking-schema {
  max-height: 50vh;
  overflow: auto;
  padding: 12px;
  background: var(--el-fill-color-light);
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
@media (max-width: 640px) {
  .tracking-page {
    padding: 16px;
  }
  .tracking-toolbar {
    flex-wrap: wrap;
  }
  .tracking-search {
    flex-basis: 100%;
  }
  .tracking-pagination {
    justify-content: space-between;
    gap: 4px;
  }
}
</style>
