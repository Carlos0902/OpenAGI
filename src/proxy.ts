import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
let configured: { httpProxy?: string; httpsProxy?: string } = {};
export function proxyDescription(endpoint: string): string {
  const proxy = new URL(endpoint).protocol === "https:" ? configured.httpsProxy : configured.httpProxy;
  if (!proxy) return "未配置 HTTP(S) 代理";
  try { const url = new URL(proxy); return `已配置代理 ${url.protocol}//${url.host}`; }
  catch { return "代理地址格式无效"; }
}
/** Explicitly enable proxy variables for app HTTP calls, including Electron's Node runtime. */
export function configureOutboundProxy(environment: NodeJS.ProcessEnv = process.env): void {
  const httpProxy = environment.HTTP_PROXY ?? environment.http_proxy;
  const httpsProxy = environment.HTTPS_PROXY ?? environment.https_proxy ?? httpProxy;
  if (!httpProxy && !httpsProxy) { configured = {}; setGlobalDispatcher(new Agent()); return; }
  configured = { httpProxy, httpsProxy };
  setGlobalDispatcher(new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy: environment.NO_PROXY ?? environment.no_proxy ?? "localhost,127.0.0.1,::1" }));
}
