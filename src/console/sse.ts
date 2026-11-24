import {ApiError, consoleOrigin, sanitize, type ApiClient} from './api.js';

export interface SseEvent {id: string; type: string; entityType: string; entityId: string | null; payload: unknown; createdAt: string}

export interface SseOptions {
  topics?: string[];
  onEvent: (event: SseEvent) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
}

/** A frame longer than this without its blank-line end stops the read instead of buffering without bound. */
const MAX_BUFFER_CHARS = 1024 * 1024;

/** Parses `id:`/`data:` frames from a byte stream; `: ping` comments, junk data and `connected` events are skipped. */
export async function readSse(body: ReadableStream<Uint8Array>, onEvent: (event: SseEvent) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let id = '';
  let data: string[] = [];
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) return;
      buffer = (buffer + decoder.decode(value, {stream: true})).replace(/\r\n/g, '\n');
      if (buffer.length > MAX_BUFFER_CHARS) return;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('id:')) id = line.slice(3).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        else if (line === '' && data.length) {
          try {
            const parsed = sanitize(JSON.parse(data.join('\n'))) as SseEvent;
            if (parsed && typeof parsed.type === 'string' && parsed.type !== 'connected') onEvent({...parsed, id: parsed.id || id});
          } catch {
            // An unparseable frame is skipped.
          }

          id = '';
          data = [];
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Streams the console's event feed until it ends or the signal aborts. */
export async function connectSse(client: ApiClient, path: string, options: SseOptions, signal: AbortSignal): Promise<void> {
  const {token, orgId, fetch: doFetch} = client.settings;
  if (!token) throw new ApiError(401, 'UNAUTHENTICATED', 'Not authenticated. Run `zof auth login` first.');
  const qs = options.topics?.length ? `?${new URLSearchParams({topics: options.topics.join(',')})}` : '';
  const headers: Record<string, string> = {Accept: 'text/event-stream', 'Cache-Control': 'no-cache', Authorization: `Bearer ${token}`};
  if (orgId) headers['x-zof-tenant-id'] = orgId;
  const response = await doFetch(`${consoleOrigin(client.baseUrl)}${path}${qs}`, {headers, signal, redirect: 'manual'});
  if (!response.ok) throw new ApiError(response.status, response.status === 401 ? 'UNAUTHENTICATED' : 'API_ERROR', `Event stream refused: HTTP ${response.status}`);
  if (!response.body) throw new ApiError(0, 'API_ERROR', 'The event stream has no body.');
  options.onConnect?.();
  try {
    await readSse(response.body, options.onEvent);
  } catch (error) {
    if (signal.aborted) return;
    options.onError?.(error instanceof Error ? error : new Error(String(error)));
  } finally {
    options.onDisconnect?.();
  }
}
