/** The only network seam. Tests inject a fake; nothing else in the gate opens a connection. */
export interface HttpRequest {method: 'GET' | 'POST'; url: string; headers: Record<string, string>; body?: string; timeoutMs: number}
export interface HttpResponse {status: number; headers: Record<string, string>; text: string}
export type HttpClient = (request: HttpRequest) => Promise<HttpResponse>;

const MAX_BODY = 256 * 1024;

/** fetch-based client: no redirects (the bearer never follows one), bounded body, per-request timeout. */
export const fetchHttpClient: HttpClient = async request => {
  const response = await fetch(request.url, {method: request.method, headers: request.headers, body: request.body, redirect: 'manual', signal: AbortSignal.timeout(request.timeoutMs)});
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new Error('answer too large'); }
      chunks.push(value);
    }
  }
  return {status: response.status, headers, text: Buffer.concat(chunks).toString('utf8')};
};
