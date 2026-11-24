import {randomUUID} from 'node:crypto';

// Server text reaches the terminal; drop ANSI escapes and control characters so it cannot rewrite the screen.
export function stripControl(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b\[[0-?]*[ -/]*[@-~]|\u001b./g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Every string in a parsed answer, once, at the edge: newline and tab stay; other C0, DEL and C1 (a one-byte CSI) go. */
export function sanitize<T>(value: T): T {
  if (typeof value === 'string') return value.replace(CONTROLS, '') as T;
  if (Array.isArray(value)) return value.map(sanitize) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k.replace(CONTROLS, '')] = sanitize(v);
    return out as T;
  }

  return value;
}

/** JSON for the terminal: JSON.stringify escapes C0; this also escapes U+007F-U+009F, and it still parses to the same data. */
export const terminalJson = (data: unknown, indent?: number): string =>
  JSON.stringify(data, null, indent).replace(/[\u007f-\u009f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public errorCode: string,
    message: string,
    public requestId?: string,
    /** The answer's Retry-After in seconds, when it gave a number. */
    public retryAfterS?: number,
  ) {
    super(stripControl(message));
    this.name = 'ApiError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  requireAuth?: boolean;
  timeout?: number;
}

export interface ClientSettings {
  baseUrl: string;
  token: string | null;
  orgId: string | null;
  version: string;
  fetch: typeof fetch;
}

/** The console's origin: https, or http only on this machine; never credentials, a query or a fragment (the bearer goes there). */
export function consoleOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ApiError(0, 'INVALID_CONSOLE_URL', 'The Zof console URL is not a valid URL. Check ZOF_CONSOLE_URL or `zof config set console_url <url>`.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw new ApiError(0, 'INVALID_CONSOLE_URL', 'The Zof console URL must use https.');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new ApiError(0, 'INVALID_CONSOLE_URL', 'The Zof console URL must be just its origin, like https://console.zof.ai.');
  return url.origin;
}

/** The console's HTTP API: bearer token, no Origin, no cookie. */
export class ApiClient {
  constructor(readonly settings: ClientSettings) {}

  get baseUrl(): string { return this.settings.baseUrl; }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(path, options);
    try {
      return sanitize(await response.json()) as T;
    } catch (error) {
      throw new ApiError(0, 'UNKNOWN_ERROR', error instanceof Error ? error.message : String(error));
    }
  }

  get<T = unknown>(path: string, options?: Omit<RequestOptions, 'method'>): Promise<T> { return this.request<T>(path, {...options, method: 'GET'}); }
  post<T = unknown>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> { return this.request<T>(path, {...options, method: 'POST', body}); }
  put<T = unknown>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> { return this.request<T>(path, {...options, method: 'PUT', body}); }

  /** POST that returns the ok response unread, for a streamed answer. The timeout covers only the wait for headers. */
  postStream(path: string, body: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<Response> {
    return this.send(path, {...options, method: 'POST', body, headers: {Accept: 'text/event-stream, application/json', ...options?.headers}});
  }

  /** The request with its headers and error mapping; the ok response is returned unread. */
  async send(path: string, options: RequestOptions): Promise<Response> {
    const {method = 'GET', body, headers: extraHeaders = {}, requireAuth = true, timeout = 30_000} = options;
    const baseUrl = consoleOrigin(this.settings.baseUrl);
    const correlationId = randomUUID();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-zof-correlation-id': correlationId,
      'x-zof-cli-version': this.settings.version,
      ...extraHeaders,
    };
    if (requireAuth) {
      if (!this.settings.token) throw new ApiError(401, 'UNAUTHENTICATED', 'Not authenticated. Run `zof auth login` first.');
      headers.Authorization = `Bearer ${this.settings.token}`;
    }

    if (this.settings.orgId) headers['x-zof-tenant-id'] = this.settings.orgId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      // No redirects: the bearer never follows one to another host.
      const response = await this.settings.fetch(`${baseUrl}${path}`, {method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, redirect: 'manual'});
      clearTimeout(timer);
      const requestId = response.headers.get('x-request-id') || correlationId;
      if (!response.ok) {
        let errorBody: {error?: string; message?: string; code?: string; error_description?: string} = {};
        try {
          errorBody = await response.json() as typeof errorBody;
        } catch {
          // The body may not be JSON.
        }

        const msg = errorBody.message || errorBody.error || errorBody.code || `HTTP ${response.status}`;
        if (response.status === 401 && path.startsWith('/api/auth/device/')) {
          // Mid-login 401s are server rejections (e.g. unknown client_id), not an expired session.
          throw new ApiError(401, errorBody.error || 'UNAUTHENTICATED', errorBody.error_description || msg, requestId);
        }

        if (response.status === 401) throw new ApiError(401, 'UNAUTHENTICATED', 'Session expired. Run `zof auth login` to re-authenticate.', requestId);
        if (response.status === 402) throw new ApiError(402, 'CREDITS_EXCEEDED', 'Credits exceeded. Upgrade your plan to continue.', requestId);
        if (response.status === 403) throw new ApiError(403, 'FORBIDDEN', `Permission denied${errorBody.code ? ` (${errorBody.code})` : ''}. Check your role and org access.`, requestId);
        const retryAfter = /^\d{1,6}$/.test(response.headers.get('retry-after') ?? '') ? Number(response.headers.get('retry-after')) : undefined;
        throw new ApiError(response.status, errorBody.code || 'API_ERROR', msg, requestId, retryAfter);
      }

      return response;
    } catch (error) {
      clearTimeout(timer);
      if (error instanceof ApiError) throw error;
      if (error instanceof Error && error.name === 'AbortError') throw new ApiError(408, 'TIMEOUT', `Request timed out after ${timeout}ms`);
      if (error instanceof TypeError && error.message.includes('fetch')) {
        throw new ApiError(0, 'NETWORK_ERROR', `Cannot reach the Zof console at ${baseUrl}. Check your connection and ZOF_CONSOLE_URL.`);
      }

      throw new ApiError(0, 'UNKNOWN_ERROR', error instanceof Error ? error.message : String(error));
    }
  }
}
