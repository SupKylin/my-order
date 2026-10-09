#!/usr/bin/env python3
"""订单系统 Docker 发布入口：check / publish / rollback，绝不清空业务数据。"""

import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import tempfile

from bundle import unpack
from runtime import (
    backup_database, build_image, environment, healthy, inspect_container, run,
    save_environment, save_json, start_container, validate_models, validate_runtime,
)


def step(message):
    print("[{}] {}".format(datetime.now().strftime("%H:%M:%S"), message), flush=True)


def stop(name):
    run(["docker", "stop", "--time", "180", name], timeout=210)
    if inspect_container(name)["State"].get("ExitCode") == 137:
        raise RuntimeError("服务未在 180 秒内优雅停止，已中止本次发布")


def restore_service(name, previous, renamed, directory, env):
    """只恢复应用容器，不自动恢复数据库，避免覆盖停机后的业务写入。"""
    if renamed:
        names = run(["docker", "ps", "-a", "--format", "{{.Names}}"] ).splitlines()
        if name in names:
            run(["docker", "stop", "--time", "180", name], timeout=210)
            run(["docker", "update", "--restart=no", name])
            run(["docker", "rename", name, name + "-failed-" + directory.name])
        run(["docker", "rename", previous, name])
    run(["docker", "start", name])
    healthy(env)


def publish(args, project, root, info, env, directory, bundle, manifest):
    image = build_image(directory, bundle, manifest, info)
    # 先完成构建，再开始停服、备份和迁移，缩短停机时间。
    env_file = save_environment(directory, env)
    save_json(directory / "container-before.json", info)
    previous = args.container + "-before-" + manifest["id"]
    state = {
        "release": manifest["id"], "container": args.container, "previous": previous,
        "previousImage": info["Image"], "image": image, "status": "prepared",
        "project": str(project), "database": args.database,
    }
    save_json(directory / "state.json", state)
    renamed = False
    stopping = False
    try:
        step("停止服务，等待当前请求和同步任务结束。")
        stopping = True
        stop(args.container)
        step("备份数据库。")
        backup_database(directory, env, args.mysqldump)
        if args.backup_uploads:
            step("备份上传文件。")
            run(["tar", "-czf", str(directory / "storage-before.tar.gz"),
                 "-C", str(project / "backend"), "storage"], directory / "backup.log")
        state["status"] = "migrating"
        save_json(directory / "state.json", state)
        step("执行增量数据库迁移，不执行初始化或清空。")
        run([
            "docker", "run", "--rm", "--network", "host", "--env-file", str(env_file),
            image, "node", "backend/scripts/migrate-db.js",
        ], directory / "migration.log")
        run(["docker", "rename", args.container, previous])
        renamed = True
        # 即便原策略为 always，保留容器也不能在主机重启后占用线上端口。
        run(["docker", "update", "--restart=no", previous])
        start_container(args.container, image, env_file, project / "backend/storage", restart_policy(info))
        step("检查数据库、订单查询和所有前端资源。")
        healthy(env, manifest)
        validate_models(args.container, directory)
        state["status"] = "success"
        save_json(directory / "state.json", state)
        save_json(root / "latest.json", {"directory": str(directory)})
        (project / ".deployed-version").write_text(image + "\n", encoding="utf-8")
        step("发布成功：" + image)
        print("备份和日志：" + str(directory))
        print("回退命令：python3 deploy/release.py rollback " + manifest["id"])
    except BaseException:
        state["status"] = "failed"
        save_json(directory / "state.json", state)
        if stopping:
            step("发布失败，尝试恢复原容器；数据库不会自动回退。")
            try:
                restore_service(args.container, previous, renamed, directory, env)
                run(["docker", "update", "--restart=" + restart_policy(info), args.container])
                step("原容器已恢复，需检查迁移日志及数据库兼容性。")
            except Exception:
                step("原容器未能恢复，请检查 " + str(directory))
        raise


def rollback(args, project, root):
    import re
    if not re.fullmatch(r"[0-9]{17}-[a-f0-9]{6}", args.release):
        raise ValueError("无效发布编号")
    directory = root / args.release
    state = json.loads((directory / "state.json").read_text(encoding="utf-8"))
    if state["status"] != "success" or state["container"] != args.container or state["project"] != str(project):
        raise ValueError("只能回退本项目已成功发布的版本")
    current = inspect_container(args.container)
    env = validate_runtime(current, project, args.database)
    if current["Config"]["Image"] != state["image"]:
        raise ValueError("当前版本已变化，不能跨版本自动回退")
    previous = inspect_container(state["previous"])
    if previous["Image"] != state["previousImage"]:
        raise ValueError("保留的旧容器与发布记录不一致")
    step("只回退应用代码；不恢复数据库备份。")
    failed = args.container + "-rolled-back-" + args.release
    renamed = False
    try:
        stop(args.container)
        run(["docker", "rename", args.container, failed])
        renamed = True
        run(["docker", "update", "--restart=no", failed])
        run(["docker", "rename", state["previous"], args.container])
        before = json.loads((directory / "container-before.json").read_text(encoding="utf-8"))
        run(["docker", "update", "--restart=" + restart_policy(before), args.container])
        run(["docker", "start", args.container])
        healthy(env)
    except BaseException:
        if renamed:
            names = run(["docker", "ps", "-a", "--format", "{{.Names}}"] ).splitlines()
            if args.container in names:
                run(["docker", "stop", "--time", "180", args.container], timeout=210)
                run(["docker", "update", "--restart=no", args.container])
                run(["docker", "rename", args.container, state["previous"]])
            run(["docker", "rename", failed, args.container])
        run(["docker", "start", args.container])
        run(["docker", "update", "--restart=" + restart_policy(current), args.container])
        raise
    state["status"] = "rolled-back"
    save_json(directory / "state.json", state)
    (project / ".deployed-version").write_text(previous["Config"]["Image"] + "\n", encoding="utf-8")
    step("应用已回退，业务数据库保持不变。")


def restart_policy(info):
    policy = info["HostConfig"]["RestartPolicy"]
    name = policy["Name"] or "no"
    if name == "on-failure" and policy.get("MaximumRetryCount"):
        name += ":" + str(policy["MaximumRetryCount"])
    return name


class Transcript:
    """SSH/宝塔终端断开后继续写日志，不因 stdout 断开中止发布。"""

    def __init__(self, terminal, log):
        self.terminal = terminal
        self.log = log

    def write(self, text):
        self.log.write(text)
        self.log.flush()
        if self.terminal:
            try:
                self.terminal.write(text)
                self.terminal.flush()
            except (OSError, ValueError):
                self.terminal = None

    def flush(self):
        self.log.flush()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default="/www/wwwroot/my-order")
    parser.add_argument("--container", default="my-order")
    parser.add_argument("--database", default="my_order")
    parser.add_argument("--backups", default="/www/backup/my-order/releases")
    parser.add_argument("--mysqldump", default="/www/server/mysql/bin/mysqldump")
    sub = parser.add_subparsers(dest="action")
    for action in ("check", "publish"):
        command = sub.add_parser(action)
        command.add_argument("archive")
        command.add_argument("--sha256", required=True)
        if action == "publish":
            command.add_argument("--backup-uploads", action="store_true")
    sub.add_parser("rollback").add_argument("release")
    args = parser.parse_args()
    if not args.action:
        parser.error("请选择 check、publish 或 rollback")
    if sys.platform != "linux":
        raise ValueError("请在 Linux 服务器执行发布；本地使用 npm run release:pack")
    os.umask(0o077)
    project = Path(args.project).resolve()
    root = Path(args.backups).resolve()
    if not (project / "backend/storage").is_dir() or not Path(args.mysqldump).is_file():
        raise ValueError("项目存储目录或 mysqldump 不存在")
    if project == root or project in root.parents:
        raise ValueError("备份目录必须位于站点目录之外")
    root.mkdir(parents=True, exist_ok=True)
    # 服务器进程在终端意外关闭时继续执行，进度持久保存。
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    transcript = open(str(root / ("operation-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f") + ".log")),
                      "a", encoding="utf-8", buffering=1)
    sys.stdout = Transcript(sys.stdout, transcript)
    sys.stderr = Transcript(sys.stderr, transcript)
    # 操作系统锁会在进程退出时释放，阻止双击发布和并发回退。
    import fcntl
    with open(str(root / ".release.lock"), "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("已有发布或回退任务正在执行")
        if args.action == "rollback":
            rollback(args, project, root)
            return
        info = inspect_container(args.container)
        env = validate_runtime(info, project, args.database)
        step("校验发布包和运行配置。")
        temporary = Path(tempfile.mkdtemp(prefix=".check-", dir=str(root)))
        try:
            bundle = temporary / "bundle"
            manifest = unpack(Path(args.archive).resolve(), args.sha256, bundle)
            if args.action == "check":
                step("预检通过；未停止服务、未更改数据库。版本：" + manifest["id"])
                return
            directory = root / manifest["id"]
            directory.mkdir(mode=0o700, exist_ok=False)
            shutil.move(str(bundle), str(directory / "bundle"))
            publish(args, project, root, info, env, directory, directory / "bundle", manifest)
        finally:
            shutil.rmtree(str(temporary))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("发布未完成：" + str(error), file=sys.stderr)
        sys.exit(1)
