import { proxyDescription } from "./proxy.js";

const knownCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_NOT_YET_VALID"]);
function transportCode(error: unknown): string | undefined {
  const visited = new Set<unknown>();
  function find(value: unknown, depth: number): string | undefined {
    if (!value || typeof value !== "object" || visited.has(value) || depth > 5) return;
    visited.add(value); const item = value as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown[] };
    if (item.name === "TimeoutError") return "ETIMEDOUT";
    if (typeof item.code === "string" && knownCodes.has(item.code)) return item.code;
    for (const nested of [item.cause, ...(Array.isArray(item.errors) ? item.errors : [])]) { const code = find(nested, depth + 1); if (code) return code; }
  }
  return find(error, 0);
}
export class NetworkRequestError extends Error {
  constructor(readonly service: string, readonly code?: string, endpoint = "https://api.typesafe.ai/v1/models") {
    const reason = code === "ECONNREFUSED" ? "连接被拒绝，请检查代理是否开启、代理端口及服务是否可达"
      : ["ENOTFOUND", "EAI_AGAIN"].includes(code ?? "") ? "域名解析失败，请检查代理或 DNS"
      : code?.includes("TIMEOUT") || code === "ETIMEDOUT" ? "连接或响应超时，可检查代理出口后重试"
      : code && /CERT|SELF_SIGNED|VERIFY_LEAF|ISSUER/.test(code) ? "TLS 证书校验失败，请检查代理证书或系统时间"
      : ["ECONNRESET", "UND_ERR_SOCKET"].includes(code ?? "") ? "连接被中途关闭，可检查代理出口后重试"
      : "未收到 HTTP 响应，请检查网络或代理后重试";
    const target = new URL(endpoint);
    super(`${service} 网络请求失败：${reason}${code ? `（${code}）` : ""}。${proxyDescription(endpoint)}；目标 ${target.protocol}//${target.host}。此次未完成密钥校验。`);
  }
}
/** Preserve cancellation; classify only transport failures without echoing
 * arbitrary exception messages, reflected keys, credentials or response bodies. */
export async function networkFetch(endpoint: string | URL, init: RequestInit, service: string, fetcher: typeof fetch = fetch): Promise<Response> {
  try { return await fetcher(endpoint, init); }
  catch (error) {
    const reason = init.signal?.reason;
    if (init.signal?.aborted && (reason?.name === "AbortError" || (error as Error)?.name === "AbortError")) throw reason ?? error;
    throw new NetworkRequestError(service, transportCode(error) ?? transportCode(reason), String(endpoint));
  }
}
