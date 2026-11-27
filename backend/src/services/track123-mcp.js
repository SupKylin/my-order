import { AppError, assert } from '../errors.js';

const endpoint = 'https://docs.track123.com/mcp';
const protocolVersion = '2025-06-18';

export async function callTrack123Mcp(name, args = {}, transport = fetch) {
  assert(
    ['list-endpoints', 'search-endpoints', 'get-endpoint'].includes(name),
    '不支持的 MCP 工具',
  );
  let response;
  try {
    response = await transport(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'MCP-Protocol-Version': protocolVersion,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new AppError(502, 'Track123 MCP 暂时无法连接');
  }
  if (!response.ok) throw new AppError(502, `Track123 MCP 请求失败（HTTP ${response.status}）`);
  const raw = await response.text();
  assert(raw.length <= 512000, 'Track123 MCP 返回内容过大', 502);
  let message;
  try {
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      const events = raw.split(/\r?\n\r?\n/);
      const data = events
        .map((event) =>
          event
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n'),
        )
        .find((value) => value && value !== '[DONE]');
      message = JSON.parse(data);
    } else message = JSON.parse(raw);
    assert(!message.error && !message.result?.isError, 'Track123 MCP 查询失败', 502);
    const content = message.result?.content?.find((part) => part.type === 'text')?.text;
    return JSON.parse(content);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'Track123 MCP 返回了无效数据');
  }
}

export async function listTrack123Endpoints(pattern = '', transport) {
  assert(typeof pattern === 'string' && pattern.length <= 80, '搜索词过长');
  const sections = await callTrack123Mcp(
    pattern.trim() ? 'search-endpoints' : 'list-endpoints',
    pattern.trim() ? { pattern: pattern.trim() } : {},
    transport,
  );
  if (!pattern.trim() && sections && !Array.isArray(sections) && typeof sections === 'object')
    return Object.entries(sections).flatMap(([path, methods]) =>
      Object.entries(methods || {}).map(([method, summary]) => ({
        method: method.toUpperCase(),
        path,
        summary: String(summary).slice(0, 200),
      })),
    );
  assert(Array.isArray(sections), 'Track123 MCP 接口列表格式无效', 502);
  return sections.flatMap((section) =>
    (section.endpoints || []).map((item) => ({
      method: String(item.method || '').slice(0, 10),
      path: String(item.path || '').slice(0, 200),
      summary: String(item.summary || '').slice(0, 200),
    })),
  );
}

export async function getTrack123Endpoint(path, method, transport) {
  assert(typeof path === 'string' && /^\/tk\/v2\.1\/[a-z0-9/-]+$/.test(path), '接口路径无效');
  assert(method === 'GET' || method === 'POST', '请求方式无效');
  const document = await callTrack123Mcp('get-endpoint', { path, method }, transport);
  const operation = document?.paths?.[path]?.[method.toLowerCase()];
  assert(operation, 'Track123 MCP 未找到该接口', 404);
  const body = operation.requestBody?.content?.['application/json'];
  return {
    path,
    method,
    summary: operation.summary || '',
    description: operation.description || '',
    parameters: (operation.parameters || []).map(
      ({ name, in: location, required, description }) => ({
        name,
        location,
        required: Boolean(required),
        description: description || '',
      }),
    ),
    requestSchema: body?.schema || null,
  };
}
