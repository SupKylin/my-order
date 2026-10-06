# 宝塔测试部署与 Git 更新

项目目录：`/www/wwwroot/my-order-test`。宝塔数据库名、数据库用户名均为 `my-order-test`。数据库密码只在服务器 `backend/.env` 填写，不能写入 Git。以下为主机 Node.js 部署方式。

## 1. 安装环境并配置

在宝塔安装 Node.js 22、MySQL 8 和 Nginx。确保宝塔终端的 `node -v` 也是 22（最低 20.19），Node 项目也选择同一版本。

将完整源码放在项目目录，确认目录内直接有 `package.json`、`backend` 和 `frontend`，不能额外套一层文件夹。使用包含本次修复的代码；旧版初始化脚本只支持 `my_order`。

```sh
cd /www/wwwroot/my-order-test
node -v
npm ci --include=dev
```

首次配置时，复制 `backend/.env.baota.example` 为 `backend/.env`；已有 `.env` 时只编辑，不覆盖。填写：

- `DB_PASSWORD`：宝塔中该数据库的密码。
- `SESSION_SECRET`：在终端运行 `openssl rand -hex 32`，将输出填入；以后更新代码时保留此值。
- `ADMIN_PASSWORD`：自行设置至少 8 字符的系统登录密码。它与数据库密码用途不同。已有管理员时，重复初始化不会覆盖原登录密码。
- `PUBLIC_BASE_URL` 和 `APP_ORIGIN`：浏览器实际访问的完整站点地址，例如 `http://test.example.com`；若使用非默认端口也要包含端口。
- `COOKIE_SECURE`：HTTP 为 `false`，HTTPS 为 `true`。

保持 `DB_NAME=my-order-test`、`DB_USER=my-order-test`、`DB_HOST=127.0.0.1`，数据库端口按宝塔实际配置填写。后端默认仅监听 `127.0.0.1:3000`，通过宝塔反向代理对外访问。如果 3000 被占用，同时修改 `PORT`、宝塔项目端口及反向代理目标。

## 2. 初始化、构建、启动

如库里已有业务数据，先在宝塔备份数据库及项目的 `backend/storage/`。

```sh
cd /www/wwwroot/my-order-test
npm run db:init
npm run build
```

普通初始化使用配置中的数据库，创建缺失表并执行增量迁移，不清空现有订单。不要添加 `--reset`。

在宝塔“网站 → Node 项目”添加项目（菜单名称可能因版本不同）：

| 设置      | 值                                                             |
| --------- | -------------------------------------------------------------- |
| 项目名称  | `my-order-test`                                                |
| 项目目录  | `/www/wwwroot/my-order-test`                                   |
| Node 版本 | 22                                                             |
| 启动方式  | npm，选择 `start`；如需命令则填 `npm start`                    |
| 端口      | 3000，与 `.env` 的 `PORT` 一致                                 |
| 运行用户  | 通常 `www`，须能读取源码及 `.env`，并能写入 `backend/storage/` |

若管理器要求入口文件，使用 `backend/src/server.js`。Node 后端同时提供 API 和构建后的前端；无需单独启动 Vite。

为测试域名或测试站点添加反向代理至 `http://127.0.0.1:3000`。在宝塔站点对应的 Nginx 配置中设置下列内容；已有反向代理时编辑其 `location /`，不要重复添加：

```nginx
client_max_body_size 65m;
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 180s;
    proxy_send_timeout 180s;
}
```

由 Node 提供页面，不要把整个源码目录直接公开为静态网站。站点入口端口需要在宝塔防火墙和云服务器安全组放行；通过反代访问时不必开放 3000 或数据库端口。

启动后在宝塔终端检查：

```sh
curl --fail http://127.0.0.1:3000/api/health
```

返回 `{"ok":true}` 后，通过配置的站点地址访问，使用 `admin` 和自己设置的 `ADMIN_PASSWORD` 登录。确认订单号旁标记及价格系数筛选正常。

## 3. 以后从 fix1 更新

本地代码先提交到 `fix1`，再推送到 `origin/fix1`。单纯推送 GitHub 不会自动更新宝塔站点，除非另行配置部署任务。

服务器目录必须是 Git 克隆目录。先检查：

```sh
cd /www/wwwroot/my-order-test
git status --short --branch
git remote -v
```

若提示不是 Git 仓库，说明是上传的源码，不能直接 `git pull`。先保留现有目录，在新目录克隆正确仓库的 `fix1`，迁移本地 `.env` 和 `backend/storage/` 后再调整宝塔项目路径；不要在原目录上强行覆盖或清理文件。

如果工作区有改动，先核对并保留服务器修改；不要使用 `reset --hard` 或 `clean`。确认工作区干净、远程仓库正确后，备份数据库和上传文件，在宝塔停止该 Node 项目，再执行：

```sh
cd /www/wwwroot/my-order-test
git fetch origin
git switch fix1
git pull --ff-only origin fix1
npm ci --include=dev
npm run build
npm run db:migrate
```

任一步报错就停止后续步骤，解决后再继续。在宝塔重新启动项目，检查健康接口及页面。`.env`、`backend/storage/` 均已被 Git 忽略，日常更新应保留这些本地文件。

仓库当前 `.workflow/` 文件是旧的 Gitee 流水线模板，使用 Node 14、错误的构建产物目录，部署脚本也未接入宝塔；不能据此认为推送后已经自动部署。
