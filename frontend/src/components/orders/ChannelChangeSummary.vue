<script setup>
import { useMeta } from '../../stores/meta';
defineProps({ item: { type: Object, required: true } });
const meta = useMeta();
</script>
<template>
  <div class="change-summary">
    <div class="product">
      <el-image
        v-if="item.productImage"
        :src="meta.imageUrl(item.productImage)"
        fit="contain"
        :preview-src-list="[meta.imageUrl(item.productImage)]"
        preview-teleported
      />
      <div>
        <strong>{{ item.shopName }} · {{ item.orderNumber }}</strong>
        <p>{{ item.productName || '—' }}</p>
        <p>Walmart SKU：{{ item.walmartSku }}</p>
      </div>
    </div>
    <dl>
      <div>
        <dt>商品数量</dt>
        <dd>{{ item.quantity ?? '—' }}</dd>
      </div>
      <div>
        <dt>订单金额</dt>
        <dd>{{ item.orderAmount ?? '—' }}</dd>
      </div>
      <div>
        <dt>采购SKU</dt>
        <dd>{{ item.purchaseSku || '—' }}</dd>
      </div>
      <div>
        <dt>采购数量</dt>
        <dd>{{ item.purchaseQuantity ?? '—' }}</dd>
      </div>
      <div>
        <dt>采购金额</dt>
        <dd>{{ item.purchaseAmount ?? '—' }}</dd>
      </div>
      <div>
        <dt>发货模式</dt>
        <dd>{{ item.shippingMode || '—' }}</dd>
      </div>
      <div>
        <dt>采购平台</dt>
        <dd>{{ item.purchasePlatform || '—' }}</dd>
      </div>
      <div>
        <dt>采购状态</dt>
        <dd>{{ item.purchaseStatus || '未填写' }}</dd>
      </div>
      <div>
        <dt>当前渠道</dt>
        <dd>{{ item.purchaseChannel?.join(' / ') || '未分配' }}</dd>
      </div>
      <div>
        <dt>物流单号</dt>
        <dd>{{ item.trackingNumber || '—' }}</dd>
      </div>
      <div class="full">
        <dt>采购链接</dt>
        <dd>
          <a
            v-if="/^https?:\/\//i.test(item.purchaseUrl || '')"
            :href="item.purchaseUrl"
            target="_blank"
            rel="noopener noreferrer"
            >{{ item.purchaseUrl }}</a
          ><span v-else>{{ item.purchaseUrl || '—' }}</span>
        </dd>
      </div>
    </dl>
  </div>
</template>
<style scoped>
.product {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.product .el-image {
  width: 64px;
  height: 64px;
  flex-shrink: 0;
}
p {
  margin: 5px 0;
  color: var(--el-text-color-secondary);
  overflow-wrap: anywhere;
}
dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 20px;
  margin: 12px 0;
}
dl > div {
  display: flex;
  gap: 8px;
  min-width: 0;
}
dt {
  color: var(--el-text-color-secondary);
  flex-shrink: 0;
}
dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.full {
  grid-column: 1 / -1;
}
@media (max-width: 540px) {
  dl {
    grid-template-columns: 1fr;
  }
}
</style>
