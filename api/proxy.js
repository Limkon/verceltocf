export const config = {
  runtime: 'edge',
};

// ================= 流量整形配置 =================
// 限制 1: 单次连接最大传输流量 (10MB)
// 说明: 网页浏览通常 < 3MB。视频缓冲或大文件下载会迅速触发此阈值。
const MAX_BYTES = 10 * 1024 * 1024; 

// 限制 2: 单次连接最大持续时间 (15秒)
// 说明: 网页加载很快。视频流或长连接(WebSocket)通常持续很久，会触发此超时。
const MAX_DURATION_MS = 15000; 
// ===============================================

export default async function handler(req) {
  const url = new URL(req.url);
  const targetParam = url.searchParams.get('target');

  // 如果没有提供 target 参数，返回 400 错误
  if (!targetParam) {
    return new Response('Error: Missing "target" query parameter.', { status: 400 });
  }

  try {
    const targetUrl = new URL(targetParam);
    
    // 路径透传: 将 Vercel 的路径拼接到目标 URL 后
    targetUrl.pathname = url.pathname;
    
    // 参数透传: 保留除 target 以外的所有查询参数
    url.searchParams.forEach((value, key) => {
      if (key !== 'target') {
        targetUrl.searchParams.set(key, value);
      }
    });

    // 构造请求头
    const headers = new Headers(req.headers);
    headers.set('Host', targetUrl.host);
    headers.delete('x-forwarded-host');
    headers.delete('x-vercel-id');

    // 1. 设置超时控制器 (针对连接时长)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MAX_DURATION_MS);

    console.log(`[Proxy] Forwarding to: ${targetUrl.toString()}`);

    const response = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: headers,
      body: req.body,
      redirect: 'follow',
      signal: controller.signal, // 绑定超时信号
    });

    // 请求结束，清除超时定时器
    clearTimeout(timeoutId);

    // 2. 创建流量监控流 (针对数据量)
    let downloadedBytes = 0;
    const { readable, writable } = new TransformStream({
      transform(chunk, controller) {
        downloadedBytes += chunk.length;
        
        // 检查是否超过流量阈值
        if (downloadedBytes > MAX_BYTES) {
          // 超过限制，强制报错并断开流
          const errorMsg = `Traffic Limit Exceeded: >${MAX_BYTES/1024/1024}MB`;
          // console.warn(errorMsg);
          controller.error(new Error(errorMsg));
          return;
        }
        controller.enqueue(chunk);
      }
    });

    // 将上游响应体通过监控流传输给客户端
    if (response.body) {
      // 使用 catch 捕获流中断错误，防止 Vercel 抛出未捕获异常
      response.body.pipeTo(writable).catch(() => {});
    }

    return new Response(readable, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });

  } catch (e) {
    // 区分超时错误和其他网络错误
    const msg = e.name === 'AbortError' ? 'Connection Timed Out (Policy Limit)' : e.message;
    return new Response(`Proxy Blocked: ${msg}`, { status: 502 });
  }
}
