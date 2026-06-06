const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "8000";
const DEFAULT_PROTOCOL = "http:";

type OriginPair = {
  apiOrigin: string;
  websocketOrigin: string;
};

const resolveOrigins = (): OriginPair => {
  const rawHost = (process.env.NEXT_PUBLIC_API_URL || DEFAULT_HOST).trim();
  if (!rawHost) {
    return {
      apiOrigin: `${DEFAULT_PROTOCOL}//${DEFAULT_HOST}:${DEFAULT_PORT}`,
      websocketOrigin: `ws://${DEFAULT_HOST}:${DEFAULT_PORT}`,
    };
  }

  try {
    const candidate = rawHost.match(/^https?:\/\//i) ? rawHost : `http://${rawHost}`;
    const parsed = new URL(candidate);
    const envPort = (process.env.NEXT_PUBLIC_API_PORT || "").trim();
    const fallbackPort = parsed.protocol === "https:" ? "443" : DEFAULT_PORT;
    const port = envPort || parsed.port || fallbackPort;
    const apiOrigin = `${parsed.protocol}//${parsed.hostname}${port ? `:${port}` : ""}`;
    const websocketProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
    const websocketOrigin = `${websocketProtocol}//${parsed.hostname}${port ? `:${port}` : ""}`;
    return { apiOrigin, websocketOrigin };
  } catch (error) {
    console.warn("Invalid NEXT_PUBLIC_API_URL, falling back to localhost:", error);
    return {
      apiOrigin: `${DEFAULT_PROTOCOL}//${DEFAULT_HOST}:${DEFAULT_PORT}`,
      websocketOrigin: `ws://${DEFAULT_HOST}:${DEFAULT_PORT}`,
    };
  }
};

const { apiOrigin, websocketOrigin } = resolveOrigins();

const normalizePath = (path: string) => (path.startsWith("/") ? path : `/${path}`);

export const API_ORIGIN = apiOrigin;
export const API_WEBSOCKET_ORIGIN = websocketOrigin;

export const buildApiUrl = (endpoint: string) => `${API_ORIGIN}${normalizePath(endpoint)}`;
export const buildWsUrl = (path: string) => `${API_WEBSOCKET_ORIGIN}${normalizePath(path)}`;
