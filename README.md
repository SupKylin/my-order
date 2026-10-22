# 订单协作台

运营与采购订单管理系统。前端 Vue 3 / Element Plus / Pinia / Vue Router / Vite / Axios；后端 Node.js / Express / Sequelize；数据库 MySQL。前后端分别位于 `frontend/`、`backend/`。

本文及业务文档描述当前源码行为，不表示本地修改已发布。线上版本以服务器 `.deployed-version` 和运行容器为准。

## 文档导航

新会话或上下文恢复可先读[项目摘要](docs/project-memory.md)，再按任务查阅下表。

| 文档                                         | 内容                                           |
| -------------------------------------------- | ---------------------------------------------- |
| [Walmart 同步](docs/walmart-sync.md)         | 接收范围、并发调度、字段映射、自动确认与防漏单 |
| [采购导入](docs/purchase-import.md)          | 表头名称匹配、工作表选择、模板复制、跳过反馈   |
| [采购字段与导出](docs/procurement-fields.md) | 筛选、采购成功时间、表头设置、风险地址和 Excel |
| [权限与日志](docs/permissions-audit.md)      | 角色菜单、运营店铺隔离、两个月日志保留         |
| [维护页面](docs/management-pages.md)         | 分页、筛选、批量删除边界                       |
| [正式环境发布](docs/docker-release.md)       | 本地打包、Docker 发布、备份、迁移及回退        |
| [宝塔测试部署](docs/baota-deployment.md)     | 独立 Node.js 测试站点部署，不用于更新正式容器  |

## 本地运行

要求 Node.js 20.19+、MySQL 8；数据库默认 `localhost:3306`、`my_order`，实际以 `backend/.env` 为准。

```sh
npm install
npm run dev
```

也可双击 `start-local.cmd` 后台启动。前端默认 `http://localhost:5173`，后端默认 `http://localhost:3000`。日志位于 `logs/`，`./stop-local.ps1` 停止启动脚本创建的项目进程。监听地址、允许来源和图片访问地址分别由 Vite 配置及后端 `HOST`、`APP_ORIGIN`、`PUBLIC_BASE_URL` 决定。

新环境复制 `backend/.env.example` 为 `backend/.env`，填写数据库、至少 32 字符的随机会话密钥和至少 8 字符的管理员密码，再执行 `npm run db:init`。普通初始化创建缺失表并执行增量迁移，不清空已有数据。首次本地账号记录见 `.local-access.txt`（如存在）；该文件和 `.env` 均不提交 Git。

已有环境升级使用 `npm run db:migrate`，正式环境由发布工具执行。日常启动不自动变更表结构。`init-db.js --reset --confirm=实际数据库名` 是显式清库命令，不用于日常运行、升级或测试。

本地后端启动后会按所连接数据库的店铺配置运行自动同步；隔离测试应使用专门测试库，避免连接业务库运行写入测试。

## 当前业务规则

- 订单只能从 Walmart 官方接口进入系统。人工新增、旧订单 Excel 导入、单条及批量删除均关闭；保留旧代码不代表接口可继续使用。
- 官方同步按 **系统店铺名＋客户订单号＋Walmart SKU** 匹配，新增或更新平台数据，保留人工采购信息。订单号使用 `customerOrderId`；PO 和商品行号仅用于平台调用和溯源。
- 商品及收件信息默认折叠，只能通过 Walmart 同步更新。商品图片保存官方图片 URL，既有图片保留，禁止继续人工上传或修改商品图片。
- 商品数量沿用 Walmart 售出数量，只读；采购数量首次随新订单初始化为商品数量，之后可编辑或映射导入，重复同步不覆盖。历史采购数量留空；列表和两类导出均提供两列，详见[采购字段](docs/procurement-fields.md)。
- WFS 订单人工只读，不能编辑、分配采购渠道或采购导入。混合采购导入跳过 WFS 行并列出原因，其他有效行正常更新。
- 单条和批量“分配”均分配采购渠道，支持多选，以本次选择覆盖原渠道。列表显示店铺所属账号姓名，不再以采购人员作为分配对象。一家店铺绑定一个账号，一个账号可管理多家店铺。
- 采购导入只更新三项唯一匹配的已有明细，不新增订单；找不到、存在重复、WFS 或运营无店铺权限的行跳过并反馈。空白、缺列和未映射字段保留原值，数字 `0` 和“否”正常更新。
- 模板只保存名称、表头行和字段映射，不绑定采购渠道或工作表。按表头名称匹配，不依赖列号；采购渠道始终不参与导入更新。完整规则见[采购导入](docs/purchase-import.md)。
- 订单列表按出单日期倒序显示；店铺下拉来自店铺管理。筛选条件作用于列表、总数、预警统计及两类导出，并与账号数据权限取交集。
- “发货模式”筛选使用 FBM、FBA，支持清空、重置。采购渠道的“未分配”筛选空渠道，“是否可分配”的“未分配”筛选该字段为空的记录。主管确认字段已停用，不再展示、编辑、筛选或导入导出；数据库旧值保留。
- 新增只读“审核状态”和“分配供应商状态”列及筛选。是否可分配为是时已审核，有渠道则已分配；为否时两个状态均为不可分配；为空时显示未审核、未分配。仅是否可分配为是时允许新增或替换渠道，允许清空是否可分配；历史订单按现值计算，详见[采购字段与导出](docs/procurement-fields.md)。
- 发货预警仅针对平台订单状态为“已确认”的明细，截止时间为 **平台发货日期后一天北京时间 15:00**。待确认、已发货、已取消、已送达不预警。黄色为剩余超过 24 至 48 小时，橙色为 24 小时内，红色为已逾期；未逾期文案使用“不足 XX 小时”。
- 顶部显示北京时间与固定美西标准时间 PST（UTC−8），不随夏令时切换。详情保留官方时间戳，日期按同步规则转换。
- 采购成功时间由状态转换自动记录，只读、不能映射导入；两个成功状态之间切换或重复导入保留原时间，离开成功状态清空。详见[采购字段与导出](docs/procurement-fields.md)。
- “表头设置”支持选择显示列和拖动排序，点击保存后按当前账号持久化到数据库，重新登录、换电脑仍可恢复。店铺名、订单号保持固定左侧；该设置控制列表，不改变 Excel 导出列结构。
- 管理员可操作全部功能和数据；采购可操作全部店铺订单，但菜单受角色限制；运营仅能查看、编辑和导入本人所属店铺订单。详见[权限与日志](docs/permissions-audit.md)。
- “操作日志”替代原独立导入记录菜单，内含导入结果。日志自动生成、只读，普通账号只看自己，保留最近两个自然月；查看请求和 Walmart 内部同步不记录。

## Excel、图片与存储

支持 `.xlsx`，旧 `.xls` 需另存为 `.xlsx`。表头行可选 1–100；当前代码上传上限 2 GB，解压内容上限 300 MB、最多 10000 数据行，图片上传上限 15 MB。大文件仍受解析限制，并不保证能导入。临时上传文件位于 `backend/storage/.tmp-uploads/`。

采购金额、价格系数为字符串（最多 255 字符）；税费、订单金额、采购商品链接金额和采购限价使用最多 20 位小数的金额字段。Excel 的订单号、SKU、电话、邮编、物流单号和高精度金额应使用文本单元格；数值已丢失的精度无法恢复。系统不执行 Excel 公式或宏，公式需预先计算并保存结果。

采购状态不在当前启用选项内时跳过该字段并提示，保留原状态。采购截图支持标准浮动图片、WPS `DISPIMG` 及 Microsoft 365 单元格图片解析；浮动图片按左上角所在行列关联，同字段多图保留首张并提示，异常按行反馈。

人工上传的采购图片统一校验、转 WebP 并生成缩略图；数据库保存相对路径，接口返回可渲染的图片及缩略图地址。文件位于 `backend/storage/images/`，原始 Excel 位于 `backend/storage/excel/`，原 Excel 不公开下载。官方商品图片与采购上传图片分开处理；订单导出嵌入商品缩略图，下载失败保留原图链接。

覆盖记录不会立即删除旧图片。原始 Excel、导入结果、未关联图片和发布备份不属于两个月操作日志清理范围，需要单独制定备份与清理计划。生产挂载整个 `backend/storage/`，保留图片与导出缓存。

## 登录与安全

- MySQL 服务端会话配合 HttpOnly / SameSite Cookie，登录固定有效 7 天；重新登录刷新期限。
- 密码使用随机盐 scrypt 摘要，停用账号或重置密码使旧会话失效。
- 写接口校验来源、CSRF token 和专用请求头；登录限速。
- Sequelize 参数化访问、字段白名单、事务及版本检查共同保护写入。
- 菜单过滤、路由守卫、后端功能权限和运营店铺范围同时生效；不能只依赖前端隐藏按钮。
- 密码、数据库连接信息及店铺凭据不写入文档、Git 或明文操作日志。账号表头设置接口仅允许读写当前账号配置。

## 检查与测试

常规构建与格式检查：

```sh
npm run build
npm run format:check
```

涉及权限、订单筛选和导出的回归测试使用独立临时数据库：

```powershell
$env:DB_NAME = 'my_order_permissions_test_' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
try {
    node --test backend/test/permissions-audit-integration.test.js
} finally {
    Remove-Item Env:DB_NAME
}
```

此测试仅在匹配指定命名格式时执行，自动创建并清理本次临时库。其他集成测试的临时库前缀见各业务文档。`npm test` 仍指向旧的 `system.test.js`，会使用配置数据库并执行写入，不能作为当前业务库上的默认验收命令。

## 模块与代码规范

```text
backend/src/
  app.js             Express 组装、静态资源和路由挂载
  routes/            按业务拆分的 HTTP 入口
  middleware/        来源、CSRF、上传和异常处理
  services/          订单、采购导入、导出、模板、日志及 Walmart 同步
  migrations/        增量迁移
  lib/               Excel、计时、订单身份和写入规则
  models.js          Sequelize 模型、关联和明细序列化
  fields.js          字段定义及默认选项
  permissions.js     功能权限及店铺数据范围
frontend/src/
  api/               HTTP 接口及 CSRF
  composables/       页面状态、查询、导入和账号表头设置
  views/             路由页面
  components/        业务表格、字段、预览和弹窗
  stores/            Pinia 会话及字段元数据
  utils/             展示、权限及格式化辅助函数
  styles/            布局、表单、订单、导入和响应式样式
```

路由及弹窗按需加载，Element Plus 组件和样式按使用情况引入。业务判断、事务和权限保留在后端服务层。采购渠道、采购平台、运营订单状态、采购状态四类字典保存在 `dictionary_options`，表单通过 `/api/meta` 获取启用选项，历史名称保留。

使用 Prettier：2 空格缩进、单引号、分号、100 字符宽度、LF 换行。规则位于 `.prettierrc.json` 和 `.editorconfig`。改动时只格式化涉及文件，关键业务约束和并发控制写必要注释。

## 主要接口

首页 `/home` 展示最近 30 天（含 PST 今天）的每日订单汇总，进入页面或点击刷新时按数据库最新数据统计；`/store-summary` 上方展示店铺概况与绩效，下方按日期倒序、同日店铺销售额倒序展示每日统计，页面支持纵向滚动。`GET /api/home` 按账号所属店铺返回实时订单统计及平台指标快照；在线 SKU、绩效和待结算金额仍每日 PST 00:00（北京时间 16:00）采集。口径、Walmart 指标与每日更新机制见 [首页统计文档](docs/home-dashboard.md)。

| 路径                                                                        | 功能                                     |
| --------------------------------------------------------------------------- | ---------------------------------------- |
| `/api/auth/login`、`/api/auth/me`、`/api/auth/logout`、`/api/auth/password` | 登录、会话及改密                         |
| `/api/auth/order-table-preferences`                                         | 当前账号表头设置                         |
| `/api/meta`、`/api/dashboard`                                               | 字段字典和统计                           |
| `/api/orders`、`/api/orders/:id`                                            | 明细查询及允许范围内编辑，禁止新增和删除 |
| `/api/orders/export`、`/api/orders/export-purchases`                        | 按筛选导出订单及采购填写模板             |
| `/api/assignments`                                                          | 单条或批量分配采购渠道                   |
| `/api/templates`、`/api/templates/:id/copy`                                 | 共享模板维护及复制                       |
| `/api/uploads/excel`、`/api/uploads/excel/:id/inspect`                      | 上传并读取工作表、表头                   |
| `/api/uploads/image`                                                        | 采购图片上传和缩略图                     |
| `/api/imports/preview`、`/api/imports/:id/commit`                           | 采购预览和事务提交                       |
| `/api/imports`、`/api/audit-logs`                                           | 只读导入结果和操作日志                   |
| `/api/users`、`/api/stores`                                                 | 账号、店铺及归属维护                     |
| `/api/dictionaries/:kind`                                                   | 四类业务字典维护                         |
| `/api/management/:resource`                                                 | 维护页分页、筛选及受限批量操作           |

## 正式部署

正式环境采用 Docker：本地 `npm run release:pack` → 上传发布包 → 服务器 `check` → `publish`。工具先构建镜像，再停服备份数据库、增量迁移、切换容器并健康检查，保留旧容器供回退。日常发布不清空业务数据，不直接修改旧镜像。

完整命令、备份路径和回退边界见[正式环境发布](docs/docker-release.md)。不要用测试站点的 Git 更新步骤替代正式发布，也不要把上传源码目录当成当前运行版本。
