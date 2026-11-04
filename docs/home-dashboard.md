# 首页每日统计与店铺汇总

首页路由 `/home`，登录后的默认入口，按日期倒序展示按美西标准时间 PST（固定 UTC−8）的最近 30 天（含今天）的全部授权店铺汇总。“每日订单汇总”只在首页展示。菜单 `/store-summary` 直接展示店铺概况与绩效，支持页面纵向滚动：上方展示店铺概况、在线 SKU、待结算金额、上期平台已支付金额、当月退款额及八项绩效，下方展示最近 30 天（含今天）的“日期＋店铺”订单统计，两个列表分别保留筛选和分页。

## 权限与展示

- 管理员、采购可查看全部已维护店铺及金额；运营只能查看当前账号所属店铺。
- 所属关系每次读取重新校验，不接受客户端传入账号扩大范围。接口不返回密钥或付款账户信息。
- 每日统计支持日期筛选，店铺概况和店铺每日统计分别提供独立的店铺多选下拉筛选；点击查询才应用条件。选中任一店铺的数据均会展示，清空表示全部店铺，并与所属账号条件取交集。概况页直接从已授权的店铺选项选择，不使用关键词输入；修改尚未查询的选项不影响当前结果，刷新仍沿用已查询条件。
- 店铺概况与每日店铺统计分别提供独立的所属账号下拉筛选，支持按姓名或登录账号搜索，点击查询后生效；清空表示不限。选项来自当前有权限查看的全部店铺并按账号 ID 去重，未绑定店铺仅在不限账号时展示。概况筛选同步影响顶部汇总卡片及待结算金额汇总；每日店铺统计的账号筛选与店铺、日期条件取交集。筛选在分页之前执行，两个列表互不影响。
- 进入页面或点击“刷新统计”时，按数据库最新订单和采购信息重新计算，不直接请求 Walmart，也不自动轮询。在线 SKU、绩效及财务数据仍读取每日平台快照；平台快照缺失或过期不影响订单实时统计。
- 概况页顶部“待结算金额汇总（USD）”跨分页汇总当前账号有权限且符合已查询条件的全部店铺。未获取金额不按零计入，并显示未获取店铺数；沿用历史快照或接口失败后保留的金额时显示历史金额店铺数。全部未获取时显示“—”。金额按美元分精确累加，保留负余额。
- “上期平台已支付金额（USD）”取最近已结束报表的 PaymentSummary / `Total Payable`，不再验证 `Transaction Description`，也不要求 `Deposited in account`。展示账期起止及报表日期，不代表银行到账。金额缺失或非USD仍明确提示；更晚报表获取失败时不拿更早账期冒充上期。相同支付汇总记录去重。

## 每日统计口径

按 Walmart 原始 `orderDate` 转换为美西标准时间 PST（固定 UTC−8）日期分组，与订单管理的出单日期一致；每次读取实时生成含今天的最近 30 天统计，今天从 PST 00:00 计至本次读取时刻。状态取数据库当前值，不是历史状态变化次数；排除本次读取时刻以后的异常下单时间。无订单日期仍展示一行零值。每日店铺统计先按日期倒序，同一天按销售额数值倒序，金额相同按店铺名、店铺 ID 排序，缺失金额排在该日期末尾；先排序，再筛选与分页。

| 指标             | 口径                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| 总销售额         | 商品金额＋运费，不重复乘数量、不含税，排除已取消商品行                                                         |
| 总订单数         | 按店铺＋客户订单号去重，包含已取消订单                                                                         |
| WFS 订单数       | 履约方为 WFS / WFSFulfilled，按店铺＋客户订单号去重                                                            |
| 已审核           | 审核状态为“已审核”的商品明细数                                                                                 |
| 不可分配         | 是否可分配为“否”的商品明细数                                                                                   |
| 采购中、采购失败 | 分别精确匹配对应采购状态的商品明细数                                                                           |
| 虚拟单号发货     | 运营订单状态精确等于“已发货，虚拟单号发货”的商品明细数                                                         |

## 当月退款额与上期已支付（2026-11-03）

- 每日订单汇总、每日店铺订单统计移除退款列。店铺概况新增“当月退款额（USD）”列和顶部汇总，按已查询且有权限的店铺跨分页汇总。
- 当月退款改从 `GET /v3/returns` 取得，按固定 PST 本月1日至采集时刻的 `REFUND_COMPLETED` 事件时间归集，不用退货创建日期、订单下单日期或财务入账日期。包含旧订单、旧退货在本月完成的退款，不要求订单已在本系统。
- 本月修改时间分7天窗口查询，同时传起止时间，每页50条；按官方 nextCursor 取完，校验总条数，单店单轮最多100页。跨页/窗口按退货单号去重，同订单多个退货单分别处理；相同记录采集期间变化则本轮失败，避免混合金额。
- 当前状态为 `REFUND_COMPLETED` 且完成时间在本月的明细，直接累计接口含税 `lineTotal`，不重复乘数量，不再验证退款数量与商品数量或整单 `totalRefundAmount` 是否一致。同月多个完成事件只累计一次行金额；跨月分次完成而缺少本月独立金额时跳过并提示。
- `NOT_REFUNDED`、`REFUND_INITIATED`、`REFUND_PENDING`、`CANCELLED`及退款取消状态不计入，即使有旧完成事件、`refundedQty`大于0或退货状态为`COMPLETED`。缺少有效金额、完成时间或状态未知的行单独跳过，并提示数量及原因；同退货单的其他有效行照常显示。全部候选行均无有效金额时不伪装为0；完整获取且没有已完成退款时显示0。
- 此口径是接口确认的完成退款金额，含税，不再是报表含冲正的财务净额。不能据当前单店样本保证所有无退货退款场景均被接口覆盖。完整取回且无当月完成退款时为0；请求失败仅保留同月上次成功金额并标记历史值，跨月不带入上月金额。
- 页面展示来源、统计范围及采集截至时间；退款仍每日 PST 00:00 采集，刷新页面读取快照，不直接请求平台。当前没有财务报表覆盖当月时，也可展示退货退款接口确认的金额。
- “上期平台已支付金额（USD）”取最近已结束报表的 PaymentSummary / `Total Payable`，不再验证 `Transaction Description`，也不要求 `Deposited in account`。展示账期起止及报表日期，不代表银行到账。金额缺失或非USD仍明确提示；更晚报表获取失败时不拿更早账期冒充上期。相同支付汇总记录去重。
- 所有金额保留USD验证和精确小数累计；未知费用和分页异常继续报错，不伪造0。统计只返回聚合结果，不返回报表原文和客户身份信息。

## 店铺概况统计口径

统计现有数据库内 Walmart 原始下单时间不早于 `2026-10-01T00:00:00-08:00` 的订单，范围与订单接入起点一致，不主动补拉历史订单。下单时间取 `OrderItem.walmart.orderDate`，而不是按美西日期存储的 `orderDate` 列。

| 指标               | 口径                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| 总订单量           | 每家店铺按客户订单号去重，包含已取消订单                             |
| 总销售额           | 商品明细的商品金额＋运费相加，不重复乘数量，不含税；排除已取消商品行 |
| 昨日订单量、销售额 | 接口原始下单时间位于 PST 前一日 `[00:00, 次日00:00)`，其他口径同总计 |
| 未发货订单         | 存在 Created 或 Acknowledged 商品行的客户订单，去重计数              |
| 待确认数           | 存在 Created 商品行的客户订单，去重计数                              |
| 取消订单数         | 存在 Cancelled 商品行的客户订单，去重计数，包含部分取消订单          |
| 待采购数           | 审核状态为空的商品明细数                                             |
| 采购成功数         | 采购成功未出跟踪号、采购成功已出跟踪号的商品明细数，兼容括号与空格   |

同一客户订单可包含不同状态商品，因此未发货、取消等指标不是互斥分类。缺失接口原始下单时间的数据不猜测日期、不计入以上指标，表格提示缺失明细数。金额用 20 位定点整数累加，最终展示两位小数。

## Walmart 指标

全部使用已有店铺密钥和服务端 Walmart 客户端，只调用只读接口，不调用确认订单或修改商品接口。

| 指标                      | 接口及返回字段                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 在线 SKU                  | `GET /v3/items/count?status=PUBLISHED` → `PUBLISHED`                                                                                                            |
| 待结算金额（USD）         | `GET /v3/report/payment/statement` → `payload.accountSummary.closingBalance`                                                                                    |
| 上期平台已支付金额（USD） | 最近已结束对账报表 PaymentSummary → `Total Payable`，校验实际支付描述，不使用当前 `paidToYou`                                                                                       |
| 退款报表目录              | `GET /v3/report/reconreport/availableReconFiles?reportVersion=v1` → `availableApReportDates`                                                                    |
| 退款报表明细              | `GET /v3/report/reconreport/reconFileJson?reportDate=MMDDYYYY&offset=0&noOfRecords=1000` → `reportData`；分页使用返回的字节偏移 `nextOffset`，`-1` 表示完整结束 |
| 准时送达率                | `GET /v3/insights/performance/otd/summary?reportDuration=30&shippingMethod=ALL_METHODS` → `payload.sellerAccountableRate`                                       |
| 有效追踪率                | `GET /v3/insights/performance/vtr/summary?reportDuration=30&shippingMethod=ALL_METHODS` → `payload.cumulativeRate`                                              |
| 取消率                    | `GET /v3/insights/performance/cancellations/summary?reportDuration=30` → `payload.cumulativeRate`                                                               |
| 回复率                    | `GET /v3/insights/performance/srr/summary?reportDuration=30` → `payload.cumulativeRate`                                                                         |
| 差评率（60 天）           | `GET /v3/insights/performance/negativeFeedback/summary?reportDuration=60` → `payload.cumulativeRate`                                                            |
| 退货率（60 天）           | `GET /v3/insights/performance/returns/summary?reportDuration=60&conditionType=ALL` → `payload.cumulativeRate`                                                   |
| 未收到商品率（60 天）     | `GET /v3/insights/performance/itemNotReceived/summary?reportDuration=60` → `payload.cumulativeRate`                                                             |
| 货运延误率（30 天）       | `GET /v3/insights/performance/lateShipment/summary?reportDuration=30&shippingMethod=ALL_METHODS` → `payload.cumulativeRate`                                     |

所有绩效主值均为卖家责任口径：优先读取 `sellerAccountableRate`；没有独立责任率且没有 `overallRate` 时，读取单一 `cumulativeRate`。返回整体率但未返回可区分的卖家责任率时，提示数据不可用，不拿整体率或 0 替代。`lateShipment` 按官方比例示例乘 100 转为百分数，其他接口保留百分数值；不按数值是否小于 1 猜单位。每列标注各自的统计周期。

首页、店铺汇总内的统计时间和接口获取时间按 PST 显示；平台只返回日期时保留原日期，不自行变换平台报表周期。绩效悬停显示平台标准、风险评估、平台报表时间和本系统获取时间；不自行改写平台给出的风险等级。待结算金额展示 `lastUpdatedDate` 和 `scheduledSettlementDate`；上期支付展示实际账期起止和报表日期，非银行到账确认。

平台报表有自身更新时间，因此系统零点刷新不代表平台当时已经生成新报表。接口无权限、空数据或失败不伪装成 0；同一家店铺有历史成功值时保留，绩效明确显示“历史值 · 更新失败”，付款指标显示“最近可用报表 · 历史金额”，保留实际平台报表日期及原获取时间，悬停查看原因。付款 statement 官方接口只支持当前周期，未提供历史日期参数，因此缺失时回退本系统最近成功缓存；没有缓存时保持不可用。官方有效零值仍展示 0，不用上一期非零值替换。更换密钥或系统店铺名后旧平台快照隐藏，下次任务重新采集；订单仍按当前授权店铺即时统计。

官方参考：

- [Item count by status](https://developer.walmart.com/us-marketplace/reference/getcountbystatus)
- [Seller Performance API](https://developer.walmart.com/us-marketplace/docs/seller-performance-api-overview)
- [Negative feedback summary](https://developer.walmart.com/us-marketplace/docs/retrieve-negative-feedback-performance-summary)
- [Returns summary](https://developer.walmart.com/global-marketplace/docs/retrieve-returns-performance-summary)
- [Item not received summary](https://developer.walmart.com/us-marketplace/docs/retrieve-item-not-received-performance-summary)
- [Late shipment summary](https://developer.walmart.com/global-marketplace/docs/retrieve-late-shipment-summary)
- [Payment statement](https://developer.walmart.com/us-marketplace/reference/getpartnerstatement-1)
- [Available reconciliation report dates](https://developer.walmart.com/us-marketplace/docs/available-recon-report-dates)
- [Reconciliation report JSON](https://developer.walmart.com/us-marketplace/docs/recon-report-json)
- [Get available v1 reconciliation report as JSON](https://developer.walmart.com/us-marketplace/reference/getavailablev1reconreportasjson-1)
- [Returns API：修改时间筛选、WFS与分页](https://developer.walmart.com/us-marketplace/reference/getreturns)
- [Return orders：退款完成状态、时间及金额结构](https://developer.walmart.com/us-marketplace/docs/retrieve-return-orders)

## 调度与性能

`startHomeScheduler` 负责在线 SKU、绩效及财务数据的每日采集，随后端启动，每分钟检查 PST 日期；每天 PST 00:00（北京时间 16:00）进入新一轮（最多约一分钟调度偏差），首次启动或停机后自动补做当前日期。每轮最多并行两家，同店铺远端请求串行复用令牌。待结算金额继续取付款报表，上期付款取财务对账报表；当月退款独立取退货退款列表，不新增逐订单请求。失败或待核实指标间隔至少15分钟重试，当天最多采集三轮，成功指标不重复请求。

平台采集使用独立 MySQL 命名锁覆盖多进程运行；同一数据库同时只有一个平台采集任务。每次 `GET /api/home` 在一次一致性读中读取授权店铺、平台快照和当前订单，按每批500条游标分页批量聚合所有授权店铺，不逐店发起订单查询。当月退款读取 `remote.monthlyReturns` 的汇总快照，不缓存退货单原文或客户信息。接口禁止 HTTP 缓存；店铺汇总两个列表同时进入时合并同一账号的在途请求，完成后不缓存，下一次刷新重新计算。

财务对账首次获取接入起点之后的报表，完整账期缓存到 `store_snapshots.remote.reconciliation`；仅保留账期、按客户订单归集的兼容退款缓存、按交易日期聚合的净退款及已支付汇总，不保存姓名、地址或报表原文。每日查询目录，仅下载新增或失败账期，完整历史账期复用缓存；限制目录最多 100 个账期、每报表最多 1000 页。校验不完整的报表不入缓存；可回退已验证的历史报表小计，但不声称为完整结果。退款缓存仅服务端使用，响应只返回指标白名单和退款统计，客户订单号缓存不下发浏览器。

`store_snapshots` 每家店铺只保留最新一条平台快照。`metrics` 列为兼容数据库结构保留，新平台快照写为空对象，旧订单快照不再用于页面展示。30 天订单统计只存在于当前接口响应中，实时聚合不会写回数据库。删除店铺时级联清理快照，不删除订单。快照更新不写操作日志。当前规模不需要 Redis、消息队列或新增 npm 依赖。此次时区调整仅限首页和店铺汇总；订单列表底部“今日采购渠道分配汇总”继续按北京时间统计。

## 升级与验证

`npm run db:migrate` 增量创建 `store_snapshots`；不清空、重建或回填订单表。现有 Docker 发布脚本已经执行此迁移入口，无需额外发布步骤。

平台来源版本保持 `seller-performance-finance-pst-v6`，新增 `financeFormat: 2` 识别需补取交易日期和支付信息的旧报表缓存；旧完整报表会重新下载一次，后续复用缓存。采集期间订单统计即时可用。若回退旧版本，其版本校验会使新版平台快照失效，并自动重建旧版所需的订单快照。不修改订单、采购、店铺配置数据，也不新增数据库列。

退货退款 `returnsVersion: 2` 与财务对账 `RECON_VERSION: 2` 标识本次口径变更。旧快照补采一次、重置该轮重试计数；失败也写入版本标识，避免每分钟无限重试。缺失或过月退款快照等待同步，不回退到财务报表退款。旧支付缓存重新获取后按 Total Payable 展示，后续复用缓存。复用JSON列，无表结构、依赖或新增组件。

```powershell
node --test backend/test/home.test.js backend/test/home-daily.test.js backend/test/home-reconciliation.test.js backend/test/home-finance-summary.test.js
node --test backend/test/home-returns.test.js backend/test/home-monthly-finance.test.js
$env:DB_NAME = 'my_order_home_test_' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
node --test backend/test/home-integration.test.js
Remove-Item Env:DB_NAME
npm run build
```

集成测试只在明确命名的一次性库执行，结束后仅删除测试库；覆盖鉴权、跨店铺隔离、跨日统计、重复迁移、快照幂等、密钥切换、多进程锁和删除店铺后订单保留。每日统计测试另覆盖 30 天日期边界、当前日及未来时间边界、新增订单和修改采购信息后即时刷新、平台快照失效不影响订单、28 家店铺 1200 条测试明细的批量查询、跨 SKU 订单去重、WFS 去重、取消行销售额及精确状态匹配。财务测试覆盖退款跨商品行去重、跨店铺隔离、精确累计及冲正、未知费用与币种、目录缺失与账期断档、字节偏移分页、部分失败重试、历史缓存、零退款、付款请求去重，以及两个金额汇总的零值、负数、缺失和跨分页筛选。


财务提示区分：尚未同步显示“等待同步”；无已结束账期显示“待出已结束账期报表”；缺少有效 Total Payable 显示“报表金额暂不可用”，不再要求确认支付描述。当月退款有效行直接展示，异常行显示“已跳过 N 条退款记录”及原因；实际请求失败显示“接口请求失败”，同月历史值保留并标注。

本次已随20261103090235494-fd78cf于2026-11-03 17:28:32（北京时间）发布。2026-11-03 本地验证：57项相关单元测试、10项隔离库集成测试通过。使用正式只读接口补采本地两家快照，再通过 readHome 读取并以 Playwright 渲染真实快照（测试登录），金额、汇总和提示检查通过，无页面错误。MYZ-L-104 上期2440.51、当月退款105.94；MYZ-L-6 上期781.54、当月退款27.81 USD。上期账期2026-10-03至10-17、报表日期10-20；退款截至2026-11-03T08:44:08Z。合计上期3222.05、当月退款133.75 USD。服务器未更改。

## 退货退款接口验证（2026-11-03，本地已接入，未发布）

- 用户授权先选择一家店铺只读核验。使用本地配置的 MYZ-L-104 凭据请求正式 `GET /v3/returns`；未更新业务库、未发布，也未进行退款操作。Node fetch 连接超时；临时验证通过 Windows curl 完成，未改应用网络配置。
- 按退货创建日期 2026-10-01 至 2026-11-03、每页50条查询取得22个不重复退货单，19条明细含 `REFUND_COMPLETED` 状态时间。报表日期2026-10-20缓存中的8笔退款，在该批记录内均有对应已完成退款，金额逐笔一致。对照源为官方报表缓存，尚未人工核对 Seller Center。
- 示例：客户订单200015554633230，退货单176003248433271550，退款122.30 USD（商品85.39＋运费29.99＋税6.92），完成时间2026-10-16T04:33:18Z。订单200015445268668退款107.50 USD，同样与报表一致。
- 查到订单200015570354907于2026-11-02T15:42:27Z完成退款69.86 USD（固定PST为11月2日07:42:27），超出现有报表缓存覆盖期。此为样本金额，不代表已完整核实的当月总额；退货创建时间不能替代退款完成时间。
- 样本包含 `returnExpectedFlag=false` 的已完成记录，但没有多商品、多数量、同订单多退货单样本，不能据此保证全部退款场景。修改时间增量查询曾返回HTTP400，补充结束时间复测时令牌连接超时；普通订单详情亦连接超时。接入前仍需验证增量查询、退款完成事件去重及部分退款金额；不能直接把整单 `totalRefundAmount` 分配给每条完成事件，也不能把未完成申请计入退款。

后续接入验证：新采集函数同时传入本月修改起止时间成功，MYZ-L-104截至2026-11-03T08:07:12.658Z返回2条已完成退款，金额105.94 USD；前次按创建日期只查到69.86 USD，证明需按修改时间取得旧退货本月变化。仅在内存计算、未写业务库，未在Seller Center人工逐笔比对。54项单元测试、10项隔离数据库集成测试、前端构建、Playwright桌面/小屏检查通过；覆盖多明细、多数量一次退款、跨页去重、部分/多次退款拒绝猜算、跨月、权限和密钥失效。生产代码仍使用原Walmart客户端，Windows curl仅用于本机只读验证。

本地页面补采修复（同日后续）：原本MYZ-L-104网络超时、MYZ-L-6的2条未退款/1条取消/1条发起退款被错误判异常。现已修正并通过实际应用客户端采集，持MySQL任务锁，仅更新本地两家快照的`monthlyReturns`：截至08:28:38Z，MYZ-L-104为105.94 USD，MYZ-L-6为27.81 USD，合计133.75 USD。readHome实际读取与前端渲染真实快照均通过；浏览器测试仅模拟登录和接口传输，不模拟退款金额。用户在本地店铺汇总点击刷新即可读取；服务器未发布。

连接处理：GET获取令牌同样纳入最多3次有限重试；Windows内置fetch连接错误可用Node HTTPS IPv4栈备用连接，仅限读取和令牌请求，共用原请求超时且保留证书校验，不使用shell/curl、代理或固定IP。证书错误、HTTP错误及业务写请求不走备用重发，Linux连接栈不变。网络持续故障仍会提示并保留同月历史金额，不能保证网络永久可用。

## 最新上线验证（2026-11-03）

版本20261103090235494-fd78cf完成标准备份、增量迁移及健康/资源校验；未清空订单采购数据。上线后30家店铺已完成新版当月退款采集（均ok），检查时合计2599.05 USD；25家上期回款可展示。MYZ-L-19、20、21、22、23尚无已取得的已结束账期报表，显示待出报表，不是支付描述校验拦截。详情见本地releases发布结果文档。
