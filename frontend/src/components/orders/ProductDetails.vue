<script setup>
import { Box } from '@element-plus/icons-vue';
import { useMeta } from '../../stores/meta';
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
    <div v-else class="image-placeholder">
      <el-icon :size="25"><Box /></el-icon><span>暂无图片</span>
    </div>
    <div class="expanded-content">
      <h3>{{ row.productName || '未填写商品名称' }}</h3>
      <div class="product-grid">
        <div>
          <label>WalmartSku / 数量</label><span>{{ row.walmartSku || '—' }} / {{ row.quantity ?? '—' }}</span>
        </div>
        <div>
          <label>收件人 / 电话</label
          ><span>{{ row.recipientName || '—' }} / {{ row.phone || '—' }}</span>
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
    </div>
  </div>
</template>
