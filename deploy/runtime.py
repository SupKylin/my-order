"""服务器命令、备份和验证。密钥只写入权限为 600 的发布目录文件。"""

import json
import os
from pathlib import Path
import subprocess
import time
from urllib.request import urlopen

from bundle import DEPENDENCIES, digest


def run(args, log=None, timeout=1800):
    if log:
        with open(str(log), "ab") as output:
            result = subprocess.run(args, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
        if result.returncode:
            raise RuntimeError("命令失败，详情见 " + str(log))
        return ""
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        # 不把命令参数或原始 stderr（可能含凭据）输出到终端。
        raise RuntimeError("{} 执行失败（退出码 {}）".format(args[0], result.returncode))
    return result.stdout.decode("utf-8").strip()


def save_json(path, data):
    with open(str(path), "w", encoding="utf-8", newline="\n") as target:
        json.dump(data, target, ensure_ascii=False, indent=2)
    os.chmod(str(path), 0o600)


def inspect_container(name):
    return json.loads(run(["docker", "inspect", name]))[0]


def environment(info):
    return dict(entry.split("=", 1) for entry in info["Config"]["Env"])


def validate_runtime(info, project, database):
    env = environment(info)
    if env.get("DB_NAME") != database or not env.get("DB_USER") or not env.get("DB_PASSWORD"):
        raise ValueError("运行容器的数据库配置与发布目标不一致")
    if info["HostConfig"]["NetworkMode"] != "host":
        raise ValueError("本脚本只适用于当前 host 网络部署方式")
    mounts = info.get("Mounts", [])
    storage = str((project / "backend/storage").resolve())
    if len(mounts) != 1 or not (
        mounts[0]["Type"] == "bind" and mounts[0]["Source"] == storage
        and mounts[0]["Destination"] == "/app/backend/storage" and mounts[0]["RW"]
    ):
        raise ValueError("容器挂载与当前订单系统不一致，停止自动发布")
    if info["Config"].get("User") not in ("", "root", "0"):
        raise ValueError("容器运行用户已改变，需要先调整发布配置")
    host = env.get("HOST", "127.0.0.1")
    if host not in ("127.0.0.1", "0.0.0.0") or not env.get("PORT", "").isdigit():
        raise ValueError("不支持的服务监听配置")
    if not info["State"]["Running"]:
        raise ValueError("当前服务未运行，请先处理已有故障")
    return env


def save_environment(directory, env):
    target = directory / "runtime.env"
    with open(str(target), "w", encoding="utf-8", newline="\n") as output:
        for key, value in sorted(env.items()):
            if any(c in value for c in "\r\n\0"):
                raise ValueError("运行环境包含不能写入 env-file 的值")
            output.write(key + "=" + value + "\n")
    os.chmod(str(target), 0o600)
    return target


DEPENDENCY_CHECK = (
    "const {createRequire}=require('module');"
    "const r=createRequire('/app/backend/package.json');"
    "for(const p of Object.keys(r('./package.json').dependencies||{}))r.resolve(p);"
    "r('sharp')({create:{width:2,height:2,channels:3,background:'#ffffff'}})"
    ".resize(1,1).png().toBuffer().then(()=>console.log('生产依赖及图片处理正常'))"
    ".catch(e=>{console.error(e.message);process.exit(1)});"
)


def runtime_base_lines(base, image):
    """高层数镜像只读取合并后的文件系统，避免每次发版累积到 overlay 层数上限。"""
    if len(image.get("RootFS", {}).get("Layers", [])) < 100:
        return ["FROM " + base]
    config = image.get("Config") or {}
    if config.get("Healthcheck") or config.get("OnBuild") or config.get("Volumes"):
        raise ValueError("高层数运行镜像包含特殊构建配置，不能自动合并")
    print("运行镜像层数较高，合并文件系统后继续复用依赖。", flush=True)
    lines = ["FROM " + base + " AS previous_runtime", "FROM scratch",
             "COPY --from=previous_runtime / /"]

    def quoted(value):
        # Dockerfile ENV/LABEL 会展开变量，必须转义原配置中的字面量美元符号。
        if any(char in value for char in "\r\n\0"):
            raise ValueError("镜像配置包含不支持的换行字符")
        return json.dumps(value, ensure_ascii=False).replace("$", "\\$")

    for entry in config.get("Env") or []:
        key, value = entry.split("=", 1)
        lines.append("ENV " + key + "=" + quoted(value))
    for key, value in (config.get("Labels") or {}).items():
        lines.append("LABEL " + quoted(key) + "=" + quoted(value))
    for key in ("Entrypoint", "Cmd", "Shell"):
        if config.get(key):
            lines.append(key.upper() + " " + json.dumps(config[key]))
    for key in ("User", "StopSignal"):
        if config.get(key):
            lines.append(key.upper() + " " + config[key])
    for port in config.get("ExposedPorts") or {}:
        lines.append("EXPOSE " + port)
    # 应用运行路径在 build_image 中统一设为 /app。
    return lines


def build_image(directory, bundle, manifest, current):
    """只比较依赖文件；当前镜像作为本地基底，不重新拉取 Node 基础镜像。"""
    script = (
        "const f=require('fs');const files=" + json.dumps(DEPENDENCIES) + ";"
        "console.log(JSON.stringify(Object.fromEntries(files.map(p=>"
        "[p,JSON.parse(f.readFileSync('/app/'+p,'utf8'))]))));"
    )
    old_dependencies = json.loads(run([
        "docker", "run", "--rm", "--network", "none", "--entrypoint", "node",
        current["Image"], "-e", script,
    ]))
    new_dependencies = {
        name: json.loads((bundle / name).read_text(encoding="utf-8")) for name in DEPENDENCIES
    }
    changed = dependency_changed(old_dependencies, new_dependencies)
    if not changed:
        try:
            run(["docker", "run", "--rm", "--network", "none", "--entrypoint", "node",
                 current["Image"], "-e", DEPENDENCY_CHECK], directory / "dependency-before.log")
        except RuntimeError:
            print("现有镜像依赖缺失或图片处理异常，将重新安装生产依赖。", flush=True)
            changed = True
    base = "my-order-runtime:" + current["Image"].split(":")[-1][:20]
    run(["docker", "tag", current["Image"], base])
    image_info = json.loads(run(["docker", "image", "inspect", current["Image"]]))[0]
    # npm workspace 可将依赖安装在子目录，复用时必须一并保留。
    lines = runtime_base_lines(base, image_info) + ["WORKDIR /app",
             "RUN find /app/backend /app/frontend -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +"]
    if changed:
        lines.append("RUN rm -rf /app/node_modules /app/backend/node_modules /app/frontend/node_modules")
    lines.extend([
        "COPY package.json package-lock.json ./",
        "COPY backend/package.json backend/package.json",
        "COPY frontend/package.json frontend/package.json",
    ])
    if changed:
        lines.append("RUN npm ci --omit=dev")
    lines.extend([
        "COPY backend backend", "COPY frontend/dist frontend/dist",
        "RUN mkdir -p /app/backend/storage",
        'LABEL com.my-order.release="' + manifest["id"] + '"',
        'CMD ["node", "backend/src/server.js"]',
    ])
    dockerfile = directory / "Dockerfile"
    dockerfile.write_text("\n".join(lines) + "\n", encoding="utf-8")
    image = "my-order:release-" + manifest["id"]
    print("依赖有变化，安装生产依赖。" if changed else "依赖未变化，复用当前运行环境。", flush=True)
    run([
        "docker", "build", "--pull=false", "-f", str(dockerfile), "-t", image, str(bundle)
    ], directory / "build.log")
    # 在停服前真实生成图片，不能只检查 package.json 或健康接口。
    run(["docker", "run", "--rm", "--network", "none", "--entrypoint", "node",
         image, "-e", DEPENDENCY_CHECK], directory / "dependency-after.log")
    return image


def dependency_changed(old, new):
    # npm scripts、描述等变化不要求重装；锁文件和依赖声明必须一致。
    keys = ("name", "version", "dependencies", "optionalDependencies", "peerDependencies",
            "devDependencies", "overrides", "workspaces", "engines", "os", "cpu")
    for name in DEPENDENCIES:
        if name == "package-lock.json":
            if old.get(name) != new.get(name):
                return True
        elif any(old.get(name, {}).get(key) != new[name].get(key) for key in keys):
            return True
    return False


def backup_database(directory, env, mysqldump):
    def quote(value):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'

    credentials = directory / "mysql.cnf"
    with open(str(credentials), "w", encoding="utf-8", newline="\n") as output:
        output.write("[client]\n")
        for key, value in (
            ("host", env.get("DB_HOST", "127.0.0.1")), ("port", env.get("DB_PORT", "3306")),
            ("user", env["DB_USER"]), ("password", env["DB_PASSWORD"]),
        ):
            output.write(key + "=" + quote(value) + "\n")
    os.chmod(str(credentials), 0o600)
    target = directory / "database-before.sql"
    try:
        with open(str(target), "wb") as output, open(str(directory / "backup.log"), "ab") as error:
            result = subprocess.run([
                mysqldump, "--defaults-extra-file=" + str(credentials),
                "--single-transaction", "--quick", "--hex-blob", "--no-tablespaces", env["DB_NAME"],
            ], stdout=output, stderr=error, timeout=1800)
        if result.returncode or target.stat().st_size == 0:
            raise RuntimeError("数据库备份失败，未执行迁移；详情见 backup.log")
        save_json(directory / "backup.json", {"database": env["DB_NAME"], "sha256": digest(target)})
    finally:
        credentials.unlink()


def start_container(name, image, env_file, storage, restart="unless-stopped"):
    run([
        "docker", "run", "-d", "--name", name, "--restart", restart, "--network", "host",
        "--env-file", str(env_file), "--mount",
        "type=bind,src=" + str(storage) + ",dst=/app/backend/storage", image,
    ])


def healthy(env, manifest=None, timeout=60):
    """验证数据库健康和实际静态文件哈希，避免 SPA 回退掩盖丢失的资源。"""
    base = "http://127.0.0.1:" + env["PORT"]
    deadline = time.monotonic() + timeout
    while True:
        try:
            with urlopen(base + "/api/health", timeout=5) as response:
                if json.loads(response.read()).get("ok") is not True:
                    raise ValueError("健康接口异常")
            break
        except Exception:
            if time.monotonic() >= deadline:
                raise RuntimeError("新版服务健康检查失败")
            time.sleep(2)
    if manifest:
        import hashlib
        for name, expected in manifest["files"].items():
            if not name.startswith("frontend/dist/"):
                continue
            route = name[len("frontend/dist/"):]
            with urlopen(base + "/" + route, timeout=10) as response:
                actual = hashlib.sha256(response.read()).hexdigest()
            if actual != expected:
                raise RuntimeError("前端资源校验失败：" + route)


def validate_models(name, directory):
    # 只读完整关联查询可发现尚未迁移的字段；不创建账号或订单。
    script = (
        "import {db,OrderItem,Store,itemInclude} from './backend/src/models.js';"
        "import {WalmartSync,WalmartReceipt} from './backend/src/services/walmart/models.js';"
        "try {await OrderItem.findAll({include:itemInclude,limit:1});"
        "await Store.findAll({limit:1});await WalmartSync.count();await WalmartReceipt.count();"
        "console.log('订单、店铺及同步表查询通过');}finally{await db.close();}"
    )
    run(["docker", "exec", name, "node", "--input-type=module", "-e", script], directory / "verify.log")
