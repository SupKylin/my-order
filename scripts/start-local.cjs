const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const logs = path.join(root, 'logs');
async function isOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}
async function main() {
  fs.mkdirSync(logs, { recursive: true });
  let previous = [];
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(logs, 'runtime.json'), 'utf8'));
    if (saved.root === root) previous = saved.processes || [];
  } catch {}
  const runtime = { root, startedAt: new Date().toISOString(), processes: [] };
  for (const service of [
    {
      name: 'backend',
      port: 3000,
      cwd: path.join(root, 'backend'),
      args: [path.join(root, 'backend/src/server.js')],
    },
    {
      name: 'frontend',
      port: 5173,
      cwd: path.join(root, 'frontend'),
      args: [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', '5173', '--strictPort'],
    },
  ]) {
    if (await isOpen(service.port)) {
      const known = previous.find((p) => p.port === service.port);
      if (known) runtime.processes.push(known);
      console.log(`${service.port} 已被监听，跳过 ${service.name} 启动。`);
      continue;
    }
    const out = fs.openSync(path.join(logs, `${service.name}.log`), 'a');
    const err = fs.openSync(path.join(logs, `${service.name}.error.log`), 'a');
    const child = spawn(process.execPath, service.args, {
      cwd: service.cwd,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, err],
    });
    child.unref();
    fs.closeSync(out);
    fs.closeSync(err);
    runtime.processes.push({ name: service.name, pid: child.pid, port: service.port });
    console.log(`${service.name} 已启动，PID ${child.pid}。`);
  }
  if (runtime.processes.length)
    fs.writeFileSync(path.join(logs, 'runtime.json'), JSON.stringify(runtime, null, 2));
  console.log(
    '前端：http://localhost:5173\n后端：http://localhost:3000\n初始账号见 .local-access.txt；运行日志位于 logs 目录。',
  );
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
