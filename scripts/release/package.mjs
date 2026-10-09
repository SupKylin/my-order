import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dependencyFiles = [
  'package.json',
  'package-lock.json',
  'backend/package.json',
  'frontend/package.json',
];
const tooling = ['release.py', 'bundle.py', 'runtime.py'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 执行失败，退出码 ${result.status}`);
}

/** 白名单收集发布文件，不复制 .env、上传文件、Git 或本地依赖。 */
async function collect(relative, output) {
  const location = path.join(root, relative);
  const stat = await fs.lstat(location);
  if (stat.isSymbolicLink()) throw new Error(`发布包不允许符号链接：${relative}`);
  if (stat.isDirectory()) {
    for (const name of (await fs.readdir(location)).sort()) {
      await collect(`${relative}/${name}`, output);
    }
  } else if (stat.isFile()) {
    output.push(relative);
  }
}

async function main() {
  // 通过 npm 调用时直接运行其 JS 入口，避免 Windows 的 .cmd 引号问题。
  if (!process.env.npm_execpath) throw new Error('请使用 npm run release:pack');
  run(process.execPath, [process.env.npm_execpath, 'run', 'build']);
  const files = [...dependencyFiles];
  for (const directory of ['backend/src', 'backend/scripts', 'frontend/dist']) {
    await collect(directory, files);
  }
  files.push(...tooling.map((name) => `deploy/${name}`));
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'my-order-release-'));
  const output = path.join(root, 'releases');
  const id = `${new Date().toISOString().replace(/[-:TZ.]/g, '')}-${randomBytes(3).toString('hex')}`;
  const manifest = { schema: 1, id, createdAt: new Date().toISOString(), files: {} };
  try {
    for (const relative of files.sort()) {
      let bytes = await fs.readFile(path.join(root, relative));
      // 发布工具统一 LF；业务代码原样复制，哈希对应实际打包内容。
      if (relative.startsWith('deploy/')) {
        bytes = Buffer.from(
          bytes
            .toString('utf8')
            .replace(/^\uFEFF/, '')
            .replace(/\r\n/g, '\n'),
        );
      }
      const target = path.join(temporary, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
      manifest.files[relative] = sha256(bytes);
    }
    await fs.writeFile(path.join(temporary, 'release.json'), JSON.stringify(manifest, null, 2));
    await fs.mkdir(output, { recursive: true });
    const archive = path.join(output, `my-order-${id}.tar.gz`);
    // tar 使用 POSIX 路径，避免 Windows ZIP 反斜杠导致 Linux 静态资源丢失。
    run('tar', ['-czf', archive, '-C', temporary, '.']);
    const digest = sha256(await fs.readFile(archive));
    await fs.writeFile(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
    console.log(`\n发布包：${archive}\nSHA256：${digest}`);
    console.log(
      `服务器命令：python3 /www/wwwroot/my-order/deploy/release.py publish /上传目录/${path.basename(archive)} --sha256 ${digest}`,
    );
  } finally {
    // 仅清理由本次 mkdtemp 创建的独立临时目录。
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
