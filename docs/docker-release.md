# 正式环境发布

当前正式服务：`/www/wwwroot/my-order`，容器 `my-order`，数据库 `my_order`，内部端口 `3100`。本流程不修改测试系统，不清空订单或店铺，不修改账号密码。

## 本地打包

在项目目录执行：

```powershell
npm run release:pack
```

命令先构建前端，再生成 `releases/my-order-版本号.tar.gz` 和 SHA256 校验文件，并输出完整服务器发布命令。发布包只包含运行代码、生产前端、依赖清单和发布工具；不包含 `.env`、本地依赖、数据库、图片或 Excel。版本编号使用 UTC 时间加随机后缀，避免重复。

上传压缩包到服务器，例如 `/www/backup/my-order/packages/`，不要解压到正在运行的源码目录。将本地输出的 SHA256 用于校验；不要使用旧包的校验值。

## 首次安装发布工具

将项目中的 `deploy/release.py`、`deploy/runtime.py`、`deploy/bundle.py` 上传到 `/www/wwwroot/my-order/deploy/`。服务器使用现有 Python 3.6+、Docker 和宝塔 MySQL 客户端，无需安装 Python 包或宿主机 Node.js。

发布工具不随业务版本自动覆盖。以后若工具有更新，先更新这三个文件，再执行发布。

## 预检和一键发布

以下 `发布包`、`SHA256` 替换成本地打包命令输出的值：

```sh
cd /www/wwwroot/my-order
python3 deploy/release.py check /www/backup/my-order/packages/发布包.tar.gz --sha256 SHA256
python3 deploy/release.py publish /www/backup/my-order/packages/发布包.tar.gz --sha256 SHA256
```

`check` 只检查压缩包、配置和目标数据库，不停服、不连接 Walmart、不修改数据库。

`publish` 自动执行：

1. 校验发布包完整性，拒绝越界路径、链接和额外文件。
2. 使用当前镜像的 Node 环境构建新镜像。依赖清单和锁文件未变化时复用依赖；变化时运行 `npm ci --omit=dev`。不主动下载新的 Node 基础镜像。
   复用同时保留根目录及 backend/frontend 的 workspace 依赖。旧镜像缺失生产依赖时自动重新安装；新镜像必须在停服前通过实际 PNG 缩略图生成检查。
   运行镜像达到 100 层时，自动合并现有镜像文件系统为单层，再复制新版代码，避免连续发版触发 Docker 的层数上限；保留镜像运行配置，原容器及旧镜像不变。
3. 构建成功后停止服务，最多等待 180 秒；若服务被强制终止，中止发布并尝试恢复原服务。
4. 备份当前数据库，备份失败则不执行迁移。默认保留原上传目录，不重复压缩大量历史图片；需要文件备份时添加 `--backup-uploads`。
5. 执行 `backend/scripts/migrate-db.js` 增量迁移，不执行 `db:init`、`--reset` 或清空脚本。
6. 保留旧容器，使用原运行环境变量、上传目录和重启策略启动新容器。
7. 检查健康接口、真实订单关联查询、店铺和同步表，以及全部前端文件内容哈希。

订单导出缩略图保存在挂载目录 `backend/storage/cache/product-thumbnails-v1/`，不会因切换镜像丢失。缓存按官方图片 URL 隔离，有效期 7 天；下载失败在当前进程内保留 5 分钟失败记录。所有导出及预热共用最多 6 个下载任务，同一 URL 的并发请求合并。启动及每 20 分钟后台扫描补齐历史缓存，新订单同步完成后异步预生成。商品图片数据库字段仍保留 Walmart 官方 URL。

导出页面轮询当前登录用户自己的短期进度，显示图片准备和 Excel 生成阶段；进度保存在单个服务进程内，不作为持久化导出任务，刷新页面或重启服务后应重新导出。

发布会短暂停服，不属于零停机部署。构建在停服前完成；只有备份、迁移和切换占用停服时间。新容器启动后会按现有店铺配置恢复自动同步。

运行镜像复用只是日常发布优化，不能代替 Node 安全更新。需要升级 Node 时单独用根目录 Dockerfile 构建并验证新运行环境，再用于后续发布。

## 日志、备份与回退

每次发布保存在 `/www/backup/my-order/releases/版本号/`：

- `database-before.sql`、`backup.json`：数据库备份和校验值。
- `container-before.json`、`runtime.env`：原运行配置，含密钥，权限为 600，不要公开或提交 Git。
- `build.log`、`migration.log`、`verify.log`、`state.json`：构建、迁移、验收日志和发布状态。
- `bundle/`：该版本校验后的文件；以运行镜像和 `.deployed-version` 为线上版本依据，上传目录不再代表当前线上代码。

发布总进度同时写入 `releases/operation-时间.log`；宝塔终端意外断开后进程会继续执行。重新连接后查看该日志和版本目录中的 `state.json`，不要直接重复发版。并发锁会阻止同时执行两次发布。

发布失败会尝试重新启动旧容器。数据库不会自动恢复；MySQL DDL 可能已经部分执行，因此日常迁移必须保持与旧版兼容。涉及删列、重命名列或修改业务语义的迁移，需要单独安排，不应直接依赖自动回退。

成功发布后如需撤回当前版本，执行输出中的回退命令：

```sh
python3 deploy/release.py rollback 版本号
```

此操作切回该次发布之前保留的容器，不恢复数据库、不丢弃发布后的订单。只允许撤回当前运行版本，阻止误回退其他版本。回退前应确认数据库结构仍兼容旧代码。

脚本不会自动删除历史备份和镜像。定期检查 `/www/backup/my-order/releases` 和 Docker 磁盘占用，确认可恢复后再清理不需要的版本。

## 本地验证工具

```powershell
python -m unittest discover -s deploy -p "test_*.py"
```

测试使用临时目录和模拟 Docker，不操作业务数据库或线上容器。
