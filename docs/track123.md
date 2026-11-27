# Track123 内部物流追踪

订单管理中的采购字段 `trackingNumber` 是本接入唯一使用的单号来源；Walmart 同步的 `platformTrackingNumber` 不参与。订单列表的“物流单号”列可打开追踪弹窗。打开时按当前单号查询 Track123；尚未注册时可手动提交注册，再刷新查看状态与轨迹。保存订单和采购导入不自动注册，避免批量消耗追踪额度。单号变化后按新单号查询；旧单号的 Track123 注册不会自动删除。

侧边栏的“物流追踪”页列出已填写内部物流单号的商品明细，支持按单号、订单号、店铺和 Walmart SKU 检索并分页。点击“查看轨迹”复用订单列表弹窗；页面加载只读取本地订单，不批量调用 Track123。运营账号只看到归属店铺的单号，其他角色沿用订单访问权限。

后端通过 `TRACK123_API_SECRET` 读取密钥，浏览器仅访问现有会话保护的 `/api/orders/:id/tracking`（GET）与 `/api/orders/:id/tracking/register`（POST）。服务端每次重新读取当前订单及店铺权限，只发送 `trackNo`，不发送收件地址、电话或邮箱。Track123 响应仅转发状态、承运商和轨迹；不回写订单、采购状态或平台物流字段，也不在本地持久化快照。请求超时为 15 秒。

部署前在 `backend/.env` 或容器运行环境设置 API Key，再按现有发布流程部署。配置缺失时弹窗提示管理员配置，不能实际注册或查询。测试用模拟 Track123 响应验证请求格式和数据边界；真实接口需要配置密钥与一条可追踪单号后验收。参考 [注册](https://docs.track123.com/reference/register-package-trackings)和[查询](https://docs.track123.com/reference/get-package-trackings)接口，均为 v2.1。

“物流追踪”页的“接口文档”标签仅管理员可见。后端通过 Track123 文档站的 [MCP 服务](https://docs.track123.com/.well-known/mcp/server-card.json) 实时读取接口目录、搜索结果和单个接口的请求结构；仅允许 `list-endpoints`、`search-endpoints`、`get-endpoint` 三个只读工具。文档查询不传 Track123 API Key、运单号或订单数据，也不开放 MCP 的 `execute-request` 工具。MCP 用于接口文档，实际物流注册和查询仍走 Track123 REST API。
