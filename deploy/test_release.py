"""只使用临时目录和模拟 Docker；不会连接业务数据库或停止实际服务。"""

import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import bundle
import release
import runtime


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def archive(self, extra=None, mutate=False):
        files = {name: b"{}" for name in bundle.REQUIRED}
        files["frontend/dist/assets/app.js"] = b"console.log('ok')"
        manifest = {
            "schema": 1, "id": "20261008080000000-abcdef",
            "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
        }
        if mutate:
            files["backend/src/server.js"] = b"tampered"
        files["release.json"] = json.dumps(manifest).encode()
        archive = self.root / "release.tar.gz"
        with tarfile.open(str(archive), "w:gz") as target:
            for name, data in files.items():
                entry = tarfile.TarInfo("./" + name)
                entry.size = len(data)
                target.addfile(entry, io.BytesIO(data))
            if extra:
                target.addfile(extra, io.BytesIO(b"x"))
        return archive

    def test_normal_archive_and_hash(self):
        archive = self.archive()
        result = bundle.unpack(archive, bundle.digest(archive), self.root / "out")
        self.assertEqual(result["id"], "20261008080000000-abcdef")
        self.assertTrue((self.root / "out/frontend/dist/assets/app.js").is_file())

    def test_wrong_archive_hash_rejected_before_extract(self):
        archive = self.archive()
        with self.assertRaisesRegex(ValueError, "SHA256"):
            bundle.unpack(archive, "0" * 64, self.root / "out")
        self.assertFalse((self.root / "out").exists())

    def test_bad_paths_links_secrets_and_duplicates(self):
        for index, name in enumerate(("../escape", "/absolute", "assets\\file.js", "backend/.env", "./package.json")):
            with self.subTest(name=name):
                entry = tarfile.TarInfo(name)
                entry.size = 1
                archive = self.archive(entry)
                with self.assertRaises(ValueError):
                    bundle.unpack(archive, bundle.digest(archive), self.root / ("out" + str(index)))
        link = tarfile.TarInfo("backend/src/link")
        link.type = tarfile.SYMTYPE
        link.linkname = "/etc/passwd"
        archive = self.archive(link)
        with self.assertRaises(ValueError):
            bundle.unpack(archive, bundle.digest(archive), self.root / "link")

    def test_tampered_file_rejected(self):
        archive = self.archive(mutate=True)
        with self.assertRaisesRegex(ValueError, "文件校验失败"):
            bundle.unpack(archive, bundle.digest(archive), self.root / "out")


class DeploymentTests(unittest.TestCase):
    def test_workspace_dependencies_preserved_and_broken_base_repaired(self):
        for broken in (False, True):
            with self.subTest(broken=broken), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                package = directory / 'bundle'
                package.mkdir()
                dependencies = {name: {} for name in bundle.DEPENDENCIES}
                for name in dependencies:
                    target = package / name
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text('{}')
                checks = []

                def command(args, log=None, **unused):
                    if args[:3] == ['docker', 'image', 'inspect']:
                        return json.dumps([{'RootFS': {'Layers': ['base']}}])
                    if log and log.name.startswith('dependency-'):
                        checks.append(log.name)
                        if broken and log.name == 'dependency-before.log':
                            raise RuntimeError('sharp missing')
                    return json.dumps(dependencies)

                with patch.object(runtime, 'run', command):
                    runtime.build_image(directory, package, {'id': 'test'}, {'Image': 'sha256:old'})
                dockerfile = (directory / 'Dockerfile').read_text()
                self.assertIn('! -name node_modules', dockerfile)
                self.assertNotIn('RUN rm -rf /app/backend /app/frontend', dockerfile)
                self.assertEqual('RUN npm ci --omit=dev' in dockerfile, broken)
                self.assertEqual(checks, ['dependency-before.log', 'dependency-after.log'])

    def test_built_image_dependency_failure_blocks_publish_before_stop(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            package = directory / 'bundle'
            package.mkdir()
            dependencies = {name: {} for name in bundle.DEPENDENCIES}
            for name in dependencies:
                target = package / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('{}')

            def command(args, log=None, **unused):
                if args[:3] == ['docker', 'image', 'inspect']:
                    return json.dumps([{'RootFS': {'Layers': ['base']}}])
                if log and log.name == 'dependency-after.log':
                    raise RuntimeError('image conversion failed')
                return json.dumps(dependencies)

            with patch.object(runtime, 'run', command):
                with self.assertRaisesRegex(RuntimeError, 'image conversion'):
                    runtime.build_image(directory, package, {'id': 'test'}, {'Image': 'sha256:old'})

    def test_dependency_changes_ignore_scripts_but_not_packages(self):
        old = {name: {"name": "app", "dependencies": {"express": "5"}} for name in bundle.DEPENDENCIES}
        new = json.loads(json.dumps(old))
        new["package.json"]["scripts"] = {"release:pack": "node pack.mjs"}
        self.assertFalse(runtime.dependency_changed(old, new))
        new["backend/package.json"]["dependencies"]["express"] = "6"
        self.assertTrue(runtime.dependency_changed(old, new))

    def test_layer_limit_flattens_only_high_depth_preserving_runtime_config(self):
        image = {'RootFS': {'Layers': ['layer'] * 124}, 'Config': {
            'Env': ['PATH=/usr/local/bin:/usr/bin:/bin', 'NODE_ENV=production', 'LITERAL=$VALUE'],
            'Entrypoint': ['docker-entrypoint.sh'], 'Cmd': ['node'],
            'User': 'root', 'StopSignal': 'SIGTERM', 'ExposedPorts': {'3000/tcp': {}},
            'Labels': {'release': 'previous'},
        }}
        lines = runtime.runtime_base_lines('runtime:old', image)
        self.assertEqual(lines[:3], ['FROM runtime:old AS previous_runtime', 'FROM scratch',
                                    'COPY --from=previous_runtime / /'])
        self.assertIn('ENV NODE_ENV="production"', lines)
        self.assertIn('ENV LITERAL="\\$VALUE"', lines)
        self.assertIn('ENTRYPOINT ["docker-entrypoint.sh"]', lines)
        self.assertIn('EXPOSE 3000/tcp', lines)
        self.assertIn('USER root', lines)
        image['RootFS']['Layers'] = ['layer'] * 99
        self.assertEqual(runtime.runtime_base_lines('runtime:old', image), ['FROM runtime:old'])
        image['RootFS']['Layers'] *= 2
        image['Config']['Volumes'] = {'/data': {}}
        with self.assertRaises(ValueError):
            runtime.runtime_base_lines('runtime:old', image)

    def simulate_publish(self, failure=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            project = root / "project"
            project.mkdir()
            directory = root / "release"
            directory.mkdir()
            events = []
            args = SimpleNamespace(container="my-order", database="my_order", mysqldump="dump", backup_uploads=False)
            info = {"Image": "sha256:old", "HostConfig": {"RestartPolicy": {"Name": "unless-stopped"}}}

            def action(name, result=None):
                def invoke(*args, **kwargs):
                    events.append(name)
                    if name == failure:
                        raise RuntimeError("simulated failure")
                    return result
                return invoke

            def command(args, *unused):
                events.append("migration" if "backend/scripts/migrate-db.js" in args else args[1])
                if failure == "migration" and events[-1] == "migration":
                    raise RuntimeError("simulated migration failure")

            with patch.multiple(
                release, build_image=action("build", "new-image"),
                save_environment=action("environment", directory / "runtime.env"),
                stop=action("stop"), backup_database=action("backup"), run=command,
                start_container=action("start"), healthy=action("health"),
                validate_models=action("models"), restore_service=action("restore"),
            ):
                call = lambda: release.publish(args, project, root, info, {}, directory, root, {"id": "version"})
                if failure:
                    with self.assertRaises(RuntimeError):
                        call()
                else:
                    call()
            return events, json.loads((directory / "state.json").read_text()) if (directory / "state.json").exists() else {}

    def test_success_builds_before_stop_and_never_resets_data(self):
        events, state = self.simulate_publish()
        self.assertLess(events.index("build"), events.index("stop"))
        self.assertLess(events.index("backup"), events.index("migration"))
        self.assertLess(events.index("health"), events.index("models"))
        self.assertEqual(state["status"], "success")
        self.assertNotIn("restore", events)

    def test_build_failure_does_not_stop_live_service(self):
        events, _ = self.simulate_publish("build")
        self.assertEqual(events, ["build"])

    def test_backup_migration_and_health_failures_restore_service(self):
        for failure in ("backup", "migration", "health", "models"):
            with self.subTest(failure=failure):
                events, state = self.simulate_publish(failure)
                self.assertIn("restore", events)
                self.assertEqual(state["status"], "failed")
                if failure == "backup":
                    self.assertNotIn("migration", events)

    def test_wrong_database_or_mount_is_rejected(self):
        project = Path("/www/wwwroot/my-order")
        info = {
            "Config": {"Env": ["DB_NAME=other", "DB_USER=user", "DB_PASSWORD=secret"], "User": ""},
            "HostConfig": {"NetworkMode": "host"}, "Mounts": [], "State": {"Running": True},
        }
        with self.assertRaisesRegex(ValueError, "数据库"):
            runtime.validate_runtime(info, project, "my_order")
        info["Config"]["Env"][0] = "DB_NAME=my_order"
        with self.assertRaisesRegex(ValueError, "挂载"):
            runtime.validate_runtime(info, project, "my_order")

    def test_rollback_preserves_database_and_rejects_wrong_current_version(self):
        for wrong_version in (False, True):
            with self.subTest(wrong_version=wrong_version), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                project = root / "project"
                project.mkdir()
                version = "20261008080000000-abcdef"
                directory = root / version
                directory.mkdir()
                state = {"status": "success", "container": "my-order", "project": str(project),
                         "image": "new-image", "previousImage": "sha256:old", "previous": "previous"}
                (directory / "state.json").write_text(json.dumps(state))
                old = {"Image": "sha256:old", "Config": {"Image": "old-image"},
                       "HostConfig": {"RestartPolicy": {"Name": "always"}}}
                (directory / "container-before.json").write_text(json.dumps(old))
                current = {"Config": {"Image": "other" if wrong_version else "new-image"}}
                args = SimpleNamespace(release=version, container="my-order", database="my_order")
                calls = []
                with patch.multiple(release, inspect_container=lambda name: old if name == "previous" else current,
                                    validate_runtime=lambda *a: {}, stop=lambda *a: calls.append(["stop"]),
                                    run=lambda command: calls.append(command), healthy=lambda *a: None):
                    if wrong_version:
                        with self.assertRaises(ValueError):
                            release.rollback(args, project, root)
                        self.assertEqual(calls, [])
                    else:
                        release.rollback(args, project, root)
                        self.assertIn(["docker", "update", "--restart=always", "my-order"], calls)
                        self.assertEqual(json.loads((directory / "state.json").read_text())["status"], "rolled-back")
                        self.assertFalse(any("mysql" in part for call in calls for part in call))


if __name__ == "__main__":
    unittest.main()
