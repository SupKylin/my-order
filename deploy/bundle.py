"""发布包只读校验与安全解包；兼容服务器 Python 3.6+，不需要安装依赖。"""

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import tarfile

DEPENDENCIES = (
    "package.json", "package-lock.json", "backend/package.json", "frontend/package.json"
)
TOOLS = ("deploy/release.py", "deploy/bundle.py", "deploy/runtime.py")
REQUIRED = DEPENDENCIES + TOOLS + (
    "backend/src/server.js", "backend/scripts/migrate-db.js", "frontend/dist/index.html"
)
MAX_BYTES = 512 * 1024 * 1024


def digest(path):
    value = hashlib.sha256()
    with open(str(path), "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def allowed(name):
    return name in DEPENDENCIES + TOOLS or name.startswith((
        "backend/src/", "backend/scripts/", "frontend/dist/"
    ))


def safe_name(name):
    if "\\" in name or name.startswith("/") or ".." in name.split("/"):
        raise ValueError("发布包含非法路径：" + name)
    name = str(PurePosixPath(name))
    if ":" in name or any(part.startswith(".") for part in name.split("/") if part != "."):
        raise ValueError("发布包含隐藏或非法文件：" + name)
    return name


def unpack(archive, expected, destination):
    """先校验整体哈希，再手工提取常规文件；不允许链接、设备或越界文件。"""
    if not re.fullmatch(r"[a-fA-F0-9]{64}", expected) or digest(archive) != expected.lower():
        raise ValueError("发布包 SHA256 不一致，未执行发布")
    destination = Path(destination)
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    actual = set()
    total = 0
    with tarfile.open(str(archive), "r:gz") as source:
        for member in source:
            name = safe_name(member.name)
            if member.isdir():
                continue
            if not member.isfile() or (name != "release.json" and not allowed(name)):
                raise ValueError("发布包含非允许文件：" + name)
            total += member.size
            if name in actual or total > MAX_BYTES or len(actual) >= 20000:
                raise ValueError("发布包重复文件或容量超限")
            actual.add(name)
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with source.extractfile(member) as entry, open(str(target), "wb") as output:
                while True:
                    chunk = entry.read(1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
            os.chmod(str(target), 0o600)
    with open(str(destination / "release.json"), encoding="utf-8") as source:
        manifest = json.load(source)
    if manifest.get("schema") != 1 or not re.fullmatch(r"[0-9]{17}-[a-f0-9]{6}", manifest.get("id", "")):
        raise ValueError("不支持的发布包格式")
    files = manifest.get("files", {})
    if not isinstance(files, dict) or set(files) != actual - {"release.json"}:
        raise ValueError("发布清单与文件不一致")
    if not set(REQUIRED).issubset(files):
        raise ValueError("发布包缺少入口、迁移或前端文件")
    for name, expected_file in files.items():
        if digest(destination / name) != expected_file:
            raise ValueError("文件校验失败：" + name)
    return manifest
