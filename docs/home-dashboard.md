# 首页每日统计与店铺汇总

首页路由 `/home`，登录后的默认入口，按日期倒序展示按美西标准时间 PST（固定 UTC−8）的最近 30 天（含今天）的全部授权店铺汇总。“每日订单汇总”只在首页展示。菜单 `/store-summary` 直接展示店铺概况与绩效，支持页面纵向滚动：上方展示店铺概况、在线 SKU、待结算金额及八项绩效，下方展示最近 30 天（含今天）的“日期＋店铺”订单统计，两个列表分别保留筛选和分页。

## 权限与展示

- 管理员、采购可查看全部已维护店铺及金额；运营只能查看当前账号所属店铺。
- 所属关系每次读取重新校验，不接受客户端传入账号扩大范围。接口不返回密钥或付款账户信息。
- 每日统计支持日期筛选，店铺每日统计另支持店铺筛选；点击查询才应用条件。概况页保留店铺关键词筛选。
- 店铺概况与每日店铺统计分别提供独立的所属账号下拉筛选，支持按姓名或登录账号搜索，点击查询后生效；清空表示不限。选项来自当前有权限查看的全部店铺并按账号 ID 去重，未绑定店铺仅在不限账号时展示。概况筛选同步影响顶部汇总卡片及待结算金额汇总；每日店铺统计的账号筛选与店铺、日期条件取交集。筛选在分页之前执行，两个列表互不影响。
- 进入页面或点击“刷新统计”时，按数据库最新订单和采购信息重新计算，不直接请求 Walmart，也不自动轮询。在线 SKU、绩效和待结算金额仍读取每日平台快照；平台快照缺失或过期不影响订单实时统计。
- 概况页顶部“待结算金额汇总（USD）”跨分页汇总当前账号有权限且符合已查询条件的全部店铺。未获取金额不按零计入，并显示未获取店铺数；沿用历史快照或接口失败后保留的金额时显示历史金额店铺数。全部未获取时显示“—”。金额按美元分精确累加，保留负余额。

## 每日统计口径

按 Walmart 原始 `orderDate` 转换为美西标准时间 PST（固定 UTC−8）日期分组，与订单管理的出单日期一致；每次读取实时生成含今天的最近 30 天统计，今天从 PST 00:00 计至本次读取时刻。状态取数据库当前值，不是历史状态变化次数；排除本次读取时刻以后的异常下单时间。无订单日期仍展示一行零值。每日店铺统计先按日期倒序，同一天按销售额数值倒序，金额相同按店铺名、店铺 ID 排序，缺失金额排在该日期末尾；先排序，再筛选与分页。

| 指标             | 口径                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| 总销售额         | 商品金额＋运费，不重复乘数量、不含税，排除已取消商品行                                                             |
| 总订单数         | 按店铺＋客户订单号去重，包含已取消订单                                                                             |
| WFS 订单数       | 履约方为 WFS / WFSFulfilled，按店铺＋客户订单号去重                                                                |
| 已审核           | 审核状态为“已审核”的商品明细数                                                                                     |
| 不可分配         | 是否可分配为“否”的商品明细数                                                                                       |
| 采购中、采购失败 | 分别精确匹配对应采购状态的商品明细数                                                                               |
| 虚拟单号发货     | 运营订单状态精确等于“已发货，虚拟单号发货”的商品明细数                                                             |
| 退款额           | 从已保存的官方订单原始记录 `WalmartReceipt.raw` 读取实际退款费用及税费，归入原订单下单日期；不从取消或退货状态推算 |

退款记录按店铺、PO 和商品行关联。缺少有效退款记录或币种不是 USD 时，该日期退款额显示“暂不可用”，不以 0 替代。数据库读取失败时返回错误，前端保留上次成功加载的数据，不以零值替代。平台指标采集失败不阻止订单统计。

## 店铺概况统计口径

统计现有数据库内 Walmart 原始下单时间不早于 `2026-10-01T00:00:00-08:00` 的订单，范围与订单接入起点一致，不主动补拉历史订单。下单时间取 `OrderItem.walmart.orderDate`，而不是按美西日期存储的 `orderDate` 列。

| 指标               | 口径                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| 总订单量           | 每家店铺按客户订单号去重，包含已取消订单                                |
| 总销售额           | 商品明细的商品金额＋运费相加，不重复乘数量，不含税；排除已取消商品行    |
| 昨日订单量、销售额 | 接口原始下单时间位于 PST 前一日 `[00:00, 次日00:00)`，其他口径同总计 |
| 未发货订单         | 存在 Created 或 Acknowledged 商品行的客户订单，去重计数                 |
| 待确认数           | 存在 Created 商品行的客户订单，去重计数                                 |
| 取消订单数         | 存在 Cancelled 商品行的客户订单，去重计数，包含部分取消订单             |
| 待采购数           | 审核状态为空的商品明细数                                                |
| 采购成功数         | 采购成功未出跟踪号、采购成功已出跟踪号的商品明细数，兼容括号与空格      |

同一客户订单可包含不同状态商品，因此未发货、取消等指标不是互斥分类。缺失接口原始下单时间的数据不猜测日期、不计入以上指标，表格提示缺失明细数。金额用 20 位定点整数累加，最终展示两位小数。

## Walmart 指标

全部使用已有店铺密钥和服务端 Walmart 客户端，只调用只读接口，不调用确认订单或修改商品接口。

| 指标                  | 接口及返回字段                                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 在线 SKU              | `GET /v3/items/count?status=PUBLISHED` → `PUBLISHED`                                                                        |
| 待结算金额（USD）     | `GET /v3/report/payment/statement` → `payload.accountSummary.closingBalance`                                                |
| 准时送达率            | `GET /v3/insights/performance/otd/summary?reportDuration=30&shippingMethod=ALL_METHODS` → `payload.sellerAccountableRate`   |
| 有效追踪率            | `GET /v3/insights/performance/vtr/summary?reportDuration=30&shippingMethod=ALL_METHODS` → `payload.cumulativeRate`          |
| 取消率                | `GET /v3/insights/performance/cancellations/summary?reportDuration=30` → `payload.cumulativeRate`                           |
| 回复率                | `GET /v3/insights/performance/srr/summary?reportDuration=30` → `payload.cumulativeRate`                                     |
| 差评率（60 天）       | `GET /v3/insights/performance/negativeFeedback/summary?reportDuration=60` → `payload.cumulativeRate`                        |
| 退货率（60 天）       | `GET /v3/insights/performance/returns/summary?reportDuration=60&conditionType=ALL` → `payload.cumulativeRate`               |
| 未收到商品率（60 天） | `GET /v3/insights/performance/itemNotReceived/summary?reportDuration=60` → `payload.cumulativeRate`                         |
| 货运延误率（30 天）   | `GET /v3/insights/performance/lateShipment/summary?reportDuration=30&shippingMethod=ALL_METHODS` → `payload.cumulativeRate` |

所有绩效主值均为卖家责任口径：优先读取 `sellerAccountableRate`；没有独立责任率且没有 `overallRate` 时，读取单一 `cumulativeRate`。返回整体率但未返回可区分的卖家责任率时，提示数据不可用，不拿整体率或 0 替代。`lateShipment` 按官方比例示例乘 100 转为百分数，其他接口保留百分数值；不按数值是否小于 1 猜单位。每列标注各自的统计周期。

首页、店铺汇总内的统计时间和接口获取时间按 PST 显示；平台只返回日期时保留原日期，不自行变换平台报表周期。绩效悬停显示平台标准、风险评估、平台报表时间和本系统获取时间；不自行改写平台给出的风险等级。待结算金额展示 `lastUpdatedDate` 和 `scheduledSettlementDate`，不是可提现余额。

平台报表有自身更新时间，因此系统零点刷新不代表平台当时已经生成新报表。接口无权限、空数据或失败不伪装成 0；同一家店铺有历史成功值时保留，并明确显示“历史值 · 更新失败”，悬停查看原因。更换密钥或系统店铺名后旧平台快照隐藏，下次任务重新采集；订单仍按当前授权店铺即时统计。

官方参考：

- [Item count by status](https://developer.walmart.com/us-marketplace/reference/getcountbystatus)
- [Seller Performance API](https://developer.walmart.com/us-marketplace/docs/seller-performance-api-overview)
- [Negative feedback summary](https://developer.walmart.com/us-marketplace/docs/retrieve-negative-feedback-performance-summary)
- [Returns summary](https://developer.walmart.com/global-marketplace/docs/retrieve-returns-performance-summary)
- [Item not received summary](https://developer.walmart.com/us-marketplace/docs/retrieve-item-not-received-performance-summary)
- [Late shipment summary](https://developer.walmart.com/global-marketplace/docs/retrieve-late-shipment-summary)
- [Payment statement](https://developer.walmart.com/us-marketplace/reference/getpartnerstatement-1)

## 调度与性能

`startHomeScheduler` 仅负责在线 SKU、绩效及待结算金额的每日采集，随后端启动，每分钟检查 PST 日期；每天 PST 00:00（北京时间 16:00）进入新一轮（最多约一分钟调度偏差），首次启动或停机后自动补做当前日期。店铺顺序处理，每轮最多并行两家，同店铺远端请求串行复用令牌。失败指标间隔至少 15 分钟重试，当天最多采集三轮，成功指标不重复请求。

平台采集使用独立 MySQL 命名锁覆盖多进程运行；同一数据库同时只有一个平台采集任务。每次 `GET /api/home` 在一次一致性读中读取授权店铺、平台快照和当前订单，按每批 500 条游标分页批量聚合所有授权店铺，不逐店发起订单查询。退款原始记录仅为最近 30 天的订单成批读取，并以店铺 ID＋PO＋商品行关联。接口禁止 HTTP 缓存；店铺汇总两个列表同时进入时合并同一账号的在途请求，完成后不缓存，下一次刷新重新计算。

`store_snapshots` 每家店铺只保留最新一条平台快照。`metrics` 列为兼容数据库结构保留，新平台快照写为空对象，旧订单快照不再用于页面展示。30 天订单统计只存在于当前接口响应中，实时聚合不会写回数据库。删除店铺时级联清理快照，不删除订单。快照更新不写操作日志。当前规模不需要 Redis、消息队列或新增 npm 依赖。此次时区调整仅限首页和店铺汇总；订单列表底部“今日采购渠道分配汇总”继续按北京时间统计。

## 升级与验证

`npm run db:migrate` 增量创建 `store_snapshots`；不清空、重建或回填订单表。现有 Docker 发布脚本已经执行此迁移入口，无需额外发布步骤。

本次升级将平台快照版本更新为 `seller-performance-realtime-pst-v5`，后台会重新采集平台指标；采集期间订单统计即时可用。若回退旧版本，其版本校验会使新版平台快照失效，并自动重建旧版所需的订单快照。不修改订单、采购、店铺配置数据，也不新增数据库列。

```powershell
node --test backend/test/home.test.js backend/test/home-daily.test.js
$env:DB_NAME = 'my_order_home_test_' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
node --test backend/test/home-integration.test.js
Remove-Item Env:DB_NAME
npm run build
```

集成测试只在明确命名的一次性库执行，结束后仅删除测试库；覆盖鉴权、跨店铺隔离、跨日统计、重复迁移、快照幂等、密钥切换、多进程锁和删除店铺后订单保留。每日统计测试另覆盖 30 天日期边界、当前日及未来时间边界、新增订单和修改采购信息后即时刷新、平台快照失效不影响订单、28 家店铺 1200 条测试明细的批量查询、跨 SKU 订单去重、WFS 去重、取消行销售额、精确状态匹配、退款缺失及跨店铺同 PO 隔离。
