#!/usr/bin/env node
/**
 * OpenCode Go → Qoder Desktop 本机代理
 *
 * 作用：Qoder Desktop 的自定义模型（BYOK）无法配置自定义 HTTP Header，
 * 而 OpenCode Go 要求每个请求携带稳定的 x-opencode-session 头。
 * 本代理监听本机端口，注入所需请求头后转发给 OpenCode Go API。
 * 与 IDE 用的 qoder-byok-proxy（proxy.js，MITM 私有协议）互补：
 *   IDE   → 8788 (MITM Qoder 私有协议，改写后转发上游)
 *   Desktop → 8787 (本代理，标准 OpenAI 协议直通，仅注入会话头)
 *
 * API Key：默认复用同目录 config.json 的 upstream.apiKey（上游须为 opencode.ai），
 *          也可用环境变量 OPENCODE_API_KEY 覆盖。
 * 用法：   node opencode-go-proxy.mjs   （由 start.sh 统一启停）
 *          可选：PORT=8787 OPENCODE_SESSION_ID=ses_自定义稳定ID
 *
 * Qoder Desktop 配置（设置 → 模型 → 添加模型 → 自定义 → OpenAI Compatible）：
 *   Base URL: http://127.0.0.1:8787/v1
 *   API Key: 随便填（如 local，代理会用真实 Key 覆盖）
 *   Model ID: 纯 ID，如 kimi-k3（不带 opencode-go/ 前缀）
 */

import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import pathmod from "node:path";
import { fileURLToPath } from "node:url";

// ESM 没有 __dirname，自己算（项目内其他 JS 是 CJS，直接有）
const __dirname = pathmod.dirname(fileURLToPath(import.meta.url));

const UPSTREAM_HOST = "opencode.ai";
const PORT = Number(process.env.PORT || 8787);
const HOST = "127.0.0.1";

// API Key 来源（每次请求时读取，改 config.json 即时生效）：
//   1. 环境变量 OPENCODE_API_KEY
//   2. config.json 的 upstream.apiKey（activeProfile 正指向 opencode.ai 时）
//   3. config.json 的 profiles 里任意 baseUrl 为 opencode.ai 的 profile
//      （IDE 切到别的上游时，Desktop 仍能拿到 OpenCode 的 Key，互不影响）
function loadApiKey() {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(pathmod.join(__dirname, "config.json"), "utf8"));
  } catch { return null; }
  const isOC = (u) => {
    try {
      const h = new URL(u.baseUrl).hostname;
      return Boolean(u.apiKey) && (h === "opencode.ai" || h.endsWith(".opencode.ai"));
    } catch { return false; }
  };
  if (isOC(cfg.upstream || {})) return cfg.upstream.apiKey;
  for (const p of Object.values(cfg.profiles || {})) {
    if (isOC(p)) return p.apiKey;
  }
  return null;
}

// 稳定会话 ID：优先环境变量，其次客户端带来的头，最后进程内生成（重启会变）
const FALLBACK_SESSION =
  process.env.OPENCODE_SESSION_ID || `ses_qoder_desktop_${randomUUID()}`;

// 不转发的 hop-by-hop 及由传输层重新生成的头
const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  "content-length", "content-encoding", "host",
]);

// ---- 出站通道：自动探测本地 Clash 系端口（跨设备通用，零配置）----
// 开着 Clash 就走 Clash，没开直连；Clash 中途被关在请求失败时立即降级直连（60s 后重新探测）。
// 用 node:https + 手写 CONNECT 隧道实现，不依赖 fetch/环境代理变量。
const CLASH_PROBE_PORTS = [7897, 7890, 7891, 1080];
let outboundProxy = null;
let proxyCooldownUntil = 0;
function probeLocalProxy(cb) {
  let i = 0;
  const next = () => {
    if (i >= CLASH_PROBE_PORTS.length) return cb(null);
    const port = CLASH_PROBE_PORTS[i++];
    const s = net.connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      s.destroy();
      if (ok) cb({ host: "127.0.0.1", port }); else next();
    };
    s.once("connect", () => finish(true));
    s.once("error", () => finish(false));
    const t = setTimeout(() => finish(false), 600);
    if (t.unref) t.unref();
  };
  next();
}
function refreshOutboundProxy() {
  if (Date.now() < proxyCooldownUntil) return;
  probeLocalProxy((found) => {
    const prev = outboundProxy ? `${outboundProxy.host}:${outboundProxy.port}` : "direct";
    const now = found ? `${found.host}:${found.port}` : "direct";
    outboundProxy = found;
    if (prev !== now) console.log(`出站通道: ${prev} -> ${now}`);
  });
}
refreshOutboundProxy();
setInterval(refreshOutboundProxy, 30000).unref();
function dropOutboundProxy(reason) {
  if (!outboundProxy) return;
  console.log(`本地代理 ${outboundProxy.host}:${outboundProxy.port} 失联(${reason})，降级直连，60s 后重新探测`);
  proxyCooldownUntil = Date.now() + 60000;
  outboundProxy = null;
}

// 直连用的 keep-alive agent；代理路径每请求新建 CONNECT 隧道（频率低，简单可靠）
const directAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 15000, maxSockets: 16 });

// 发上游请求：outboundProxy 存在则先 CONNECT 隧道再 TLS，否则直连。
// 返回 IncomingMessage 响应流，由调用方透传；node:https 默认不跟随重定向。
function requestUpstream(pathAndSearch, method, headers, body) {
  return new Promise((resolve, reject) => {
    const doReq = (socket) => {
      const opts = {
        host: UPSTREAM_HOST, port: 443, path: pathAndSearch, method, headers,
        ...(socket ? { createConnection: () => socket } : { agent: directAgent }),
      };
      const r = https.request(opts, resolve);
      r.on("error", reject);
      r.end(body);
    };
    if (!outboundProxy) return doReq(null);
    const target = `${UPSTREAM_HOST}:443`;
    const connectReq = http.request({
      host: outboundProxy.host, port: outboundProxy.port, method: "CONNECT", path: target,
      headers: { Host: target },
    });
    connectReq.on("connect", (cres, socket) => {
      if (cres.statusCode !== 200) {
        socket.destroy();
        reject(Object.assign(new Error(`upstream CONNECT ${cres.statusCode}`), { code: "ECONNREFUSED" }));
        return;
      }
      const tlsSock = tls.connect({ socket, servername: UPSTREAM_HOST, rejectUnauthorized: false });
      tlsSock.once("secureConnect", () => doReq(tlsSock));
      tlsSock.once("error", reject);
    });
    connectReq.on("error", reject);
    connectReq.end();
  });
}

const server = http.createServer(async (req, res) => {
  // 健康检查，不调用上游
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, session: FALLBACK_SESSION }));
    return;
  }

  try {
    // 读取请求体
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    // 路径映射：
    //   /v1/models            → /inference/go/v1/models
    //   /v1/chat/completions  → /inference/go/openai/v1/chat/completions
    //   /v1/responses         → /inference/go/openai/v1/responses
    const incoming = new URL(req.url, `http://${HOST}:${PORT}`);
    let upPath = incoming.pathname;
    if (upPath === "/v1/models") {
      upPath = "/inference/go/v1/models";
    } else if (upPath.startsWith("/v1/")) {
      upPath = "/inference/go/openai" + upPath;
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `unexpected path: ${req.url}` }));
      return;
    }

    // 每请求读一次 Key：config.json 里的 Key 换了立即生效，不用重启
    const apiKey = loadApiKey();
    if (!apiKey) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: "没有可用的 OpenCode API Key：请在 config.json 的 upstream.apiKey 里配置（上游须为 opencode.ai），或设 OPENCODE_API_KEY 环境变量",
      }));
      return;
    }

    // 会话 ID：客户端自带则沿用，否则用稳定的回退值
    const session =
      req.headers["x-opencode-session"] ||
      req.headers["x-qoder-session-id"] ||
      req.headers["x-session-id"] ||
      FALLBACK_SESSION;

    const headers = {
      "authorization": `Bearer ${apiKey}`,
      "x-opencode-session": String(session),
      "user-agent": "qoder-opencode-go-proxy/1.0",
      "accept": req.headers["accept"] || "application/json",
    };
    if (body) {
      headers["content-type"] = req.headers["content-type"] || "application/json";
      headers["content-length"] = body.length;
    }

    // 网络层偶发抖动（直连或经代理皆可能）自动重试，最多 3 次、递增间隔，
    // 拿到响应头即视为成功。HTTP 4xx/5xx 不属于网络错误，不重试。
    let upstream;
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; ; attempt++) {
      try {
        upstream = await requestUpstream(upPath + incoming.search, req.method, headers, body);
        break;
      } catch (err) {
        const code = err?.code || err?.message || String(err);
        // 走着本地代理时连不上代理（Clash 被关）→ 立即降级直连，下次重试走直连路径
        if (outboundProxy && /ECONNREFUSED/.test(String(code))) dropOutboundProxy(String(code));
        console.error(
          `[attempt ${attempt}/${MAX_ATTEMPTS}] ${new Date().toISOString()} 代理请求失败: ${code}`
        );
        const transient = /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|timeout/i.test(code);
        if (!transient || attempt >= MAX_ATTEMPTS) throw err;
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }

    // 透传状态码与安全响应头（node:https 的 headers 是普通对象）
    const resHeaders = {};
    for (const [k, v] of Object.entries(upstream.headers)) {
      if (!HOP_HEADERS.has(k.toLowerCase())) resHeaders[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    res.writeHead(upstream.statusCode || 502, resHeaders);

    // 流式转发（兼容 SSE 流式输出；客户端断开时 pipe 自动清理）
    upstream.pipe(res);
  } catch (err) {
    const code = err?.code || err?.message || String(err);
    console.error(`${new Date().toISOString()} 代理请求失败: ${code}`);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`OpenCode Go 代理已启动: http://${HOST}:${PORT}`);
  console.log(`会话 ID: ${FALLBACK_SESSION}`);
  console.log("Qoder Base URL 请填: http://127.0.0.1:" + PORT + "/v1");
});

server.on("error", (err) => {
  console.error("代理启动失败:", err?.message || err);
  process.exit(1);
});
