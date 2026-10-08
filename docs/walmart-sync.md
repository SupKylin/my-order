# Walmart 正式订单同步

店铺管理 → 订单同步 → 启用自动同步。首次启用以服务器当前时间为接收起点，仅接收之后创建的正式订单；暂停后重新启用保留原起点和进度。每店约 20 分钟同步一次，可点击「立即同步 / 重试」提前执行。后端每 30 秒检查到期任务，优先处理等待最久的店铺；按启用店铺数错开启动（20 店铺约每分钟一家），自动任务串行，长任务或失败重试导致延迟时顺延，不叠加补跑。重启依据已保存的上次启动时间判断是否到期。后端服务需持续运行。

## 数据与确认

- 以系统店铺名 `shopName`、Walmart 客户订单号 `customerOrderId`、商品 SKU `item.sku` 三字段查重，重复拉取覆盖同一条记录，不存在时新增。PO 号与商品行号用于平台接口调用及溯源，不参与本地去重。同一响应中重复 SKU 取最后一行，不累加数量；历史已存在多条重复明细时优先更新已绑定相同组合的记录，否则更新最早的一条，不新增也不删除其余旧明细。
- 一个订单的全部商品行及同步回执在同一事务提交后，才调用确认接口。再次 GET 订单检查实时状态，仅所有商品行为 `Created` 的 `SellerFulfilled` 订单调用 `POST /v3/orders/{purchaseOrderId}/acknowledge`。
- 已确认、已发货、已取消、已送达以及 WFS 均不确认。混合状态不使用整单确认接口，标为待核对。
- 确认超时/失败保存原因，下次任务先 GET 远端状态。远端已确认时直接同步状态，不重复 POST。不会因为本地第一次保存后记录已存在而丢失确认重试。
- 确认失败不删除已保存的订单。导入失败不推进创建时间游标，重跑由稳定行键去重。分页和分履约类型查询全部完成后才更新进度。
- 首次范围内已接入的非终态订单会继续逐单刷新，以更新发货、送达、取消等后续状态；不能只依赖按创建时间查询。
- 平台状态保存在 `order_items.walmart`，不覆盖人工维护的内部订单状态、采购状态、采购渠道、采购金额或采购人员。新增明细采购人员绑定启用同步的账号。
- `platformOrderStatus`（平台订单状态）独立列保存中文状态；未知状态保留接口原文，多状态以逗号分隔。`productSpecification`（商品规格）独立 TEXT 列按接口 `groupingAttributes` 顺序提取属性值，以 `, ` 拼接，例如 `Brick red, Card Bag`。两字段参与编辑、Excel 映射和导出；平台状态显示在订单列表，规格保留在商品折叠详情中。商品接口成功但没有属性时清空旧规格，查询失败则保留原值。
- 变体只读取 `GET /v3/items/{sku}?productIdType=SKU` 返回的 `ItemResponse` 中匹配 SKU 的 `variantGroupInfo.groupingAttributes`，不解析标题。正式同步按店铺＋SKU 复用订单中已保存的成功规格快照，缓存 24 小时；一次任务内按 SKU 去重查询。缓存到期或缺失时重新请求，失败保留原规格和原抓取时间，不延长有效期。预览始终查询最新商品接口，不写缓存。无需 Redis 或新增数据表。
- `orderAmount` 为当前商品行的 PRODUCT 费用之和，税费单独保存，不再乘数量。运输费用等原始字段保留在回执 JSON。
- 出单日期对应接口下单时间 `orderDate`；时间戳原值保存在平台快照，现有 DATEONLY 列按固定 PST（UTC−8）转换。平台详情展示原时间戳转换结果。发货预警仅适用于平台订单状态为“已确认”的明细，行颜色、倒计时、数量统计与预警筛选使用相同范围；截止时间仍为平台发货日期次日北京时间 15:00。

## 预览和运行

预览只读取平台数据，不新增订单、回执或确认任务。选定范围最多 31 天、200 个订单。前端选择器使用浏览器时区，发送带时区的 ISO 时间给后端。

同步任务结果、失败原因和待核对订单在店铺同步弹框显示。MySQL 命名锁防止多个进程同时处理同一店铺；单进程最多同时处理两个店铺。暂停不撤回已经发出的 API 请求，当前请求完成后停止后续处理。服务重启后重新从持久进度继续。

部署前先运行 `npm run db:migrate`，仅新增 `walmartSourceKey`、`walmart` 可空字段、唯一索引及两张专用表，不重建业务表。随后重启后端。每个店铺需要分别启用；密钥不进入同步接口返回、回执或错误日志。

## 验证

```powershell
node --test backend/test/walmart.test.js
$env:DB_NAME = 'my_order_walmart_test_' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
node --test backend/test/walmart-integration.test.js
Remove-Item Env:DB_NAME
npm run build
```

集成测试仅使用临时隔离数据库及模拟 Walmart 客户端，执行结束清理自己创建的测试库；未显式指定测试库时跳过。不会请求正式 Walmart 确认接口。

官方接口依据：[订单列表](https://developer.walmart.com/us-marketplace/reference/getallorders)、[订单详情](https://developer.walmart.com/us-marketplace/reference/getanorder)、[确认订单](https://developer.walmart.com/us-marketplace/reference/acknowledgeorders)、[商品详情](https://developer.walmart.com/us-marketplace/reference/getanitem)。
