<script setup>
import { Box } from '@element-plus/icons-vue';
import { useMeta } from '../../stores/meta';
import WalmartDetails from './WalmartDetails.vue';
import ReturnDetails from './ReturnDetails.vue';
import AfterSaleLink from './AfterSaleLink.vue';
import ChannelChangeLink from './ChannelChangeLink.vue';
import ProfitDetails from './ProfitDetails.vue';
defineProps({ row: { type: Object, required: true } });
const meta = useMeta();
</script>
<template>
  <div class="expanded-product">
    <el-image
      v-if="row.productImage"
      :src="meta.imageUrl(row.productImage, true)"
      :preview-src-list="[meta.imageUrl(row.productImage)]"
      fit="contain"
      preview-teleported
      class="product-thumb"
    />
    <el-image
      v-else-if="row.walmart?.imageUrl"
      :src="row.walmart.imageUrl"
      :preview-src-list="[row.walmart.imageUrl]"
      fit="contain"
      preview-teleported
      class="product-thumb"
    />
    <div v-else class="image-placeholder">
      <el-icon :size="25"><Box /></el-icon><span>暂无图片</span>
    </div>
    <div class="expanded-content">
      <div class="product-detail-heading">
        <h3>{{ row.productName || '未填写商品名称' }}</h3>
        <AfterSaleLink :ticket="row.purchaseAfterSale" />
        <ChannelChangeLink :ticket="row.channelChangeTicket" />
      </div>
      <div class="product-grid">
        <div>
          <label>WalmartSku</label><span>{{ row.walmartSku || '—' }}</span>
        </div>
        <div>
          <label>收件人 / 电话</label
          ><span>{{ row.recipientName || '—' }} / {{ row.phone || '—' }}</span>
        </div>
        <div class="wide">
          <label>商品规格</label><span>{{ row.productSpecification || '—' }}</span>
        </div>
        <div class="wide">
          <label>收件地址</label
          ><span>{{
            [row.address1, row.address2, row.city, row.state, row.postalCode]
              .filter(Boolean)
              .join('，') || '—'
          }}</span>
        </div>
        <div>
          <label>运营备注</label><span>{{ row.operationsNote || '—' }}</span>
        </div>
        <div>
          <label>跟单备注</label><span>{{ row.followupNote || '—' }}</span>
        </div>
      </div>
      <WalmartDetails v-if="row.walmart" :value="row.walmart" />
      <ReturnDetails v-if="row.returnInfo?.lines?.length" :value="row.returnInfo" />
      <ProfitDetails :row="row" />
    </div>
  </div>
</template>
<style scoped>
.product-detail-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  margin-bottom: 12px;
}
.product-detail-heading h3 {
  margin: 0;
}
</style>
