import https from 'node:https';

// Windows 上内置 fetch 的连接偶发超时，用系统 Node HTTPS 栈重新解析并连接 IPv4。
// 不改变证书校验，也不把凭据传入 shell、日志或外部代理。
function nativeFetch(url, options) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: options.method,
        headers: { ...options.headers, 'Accept-Encoding': 'identity' },
        family: 4,
        signal: options.signal,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 32 * 1024 * 1024) response.destroy(new Error('Walmart response too large'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const headers = new Headers();
          for (const [key, value] of Object.entries(response.headers))
            if (value != null) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          const status = response.statusCode;
          resolve(
            new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
              status,
              headers,
            }),
          );
        });
      },
    );
    request.on('error', reject);
    request.end(options.body);
  });
}

export async function walmartFetch(
  url,
  options,
  { platform = process.platform, fetchImpl = fetch, fallback = nativeFetch } = {},
) {
  try {
    return await fetchImpl(url, options);
  } catch (error) {
    const target = new URL(url);
    const readable =
      (options.method || 'GET') === 'GET' ||
      (options.method === 'POST' && target.pathname === '/v3/token');
    const networkError = [
      'UND_ERR_CONNECT_TIMEOUT',
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'EAI_AGAIN',
      'ENETUNREACH',
    ].includes(error.cause?.code || error.code);
    if (
      platform !== 'win32' ||
      !readable ||
      !networkError ||
      options.signal?.aborted ||
      target.origin !== 'https://marketplace.walmartapis.com'
    )
      throw error;
    return fallback(url, options);
  }
}
