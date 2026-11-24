import {terminalJson} from './api.js';
import type {ConsoleDeps} from './context.js';
import type {Env} from './config.js';

/** Terminal output without dependencies: colour only on request, plain tables, one line per write. */
export interface Out {
  out(line: string): void;
  err(line: string): void;
  color: boolean;
  /** UTF-8 terminal: default true when absent. */
  unicode?: boolean;
  /** Static layout width: default 80. */
  width?: number;
}

const CODES = {bold: '1', dim: '90', red: '31', green: '32', yellow: '33', blue: '34', cyan: '36', underline: '4', redBg: '41;97'} as const;
export type Style = keyof typeof CODES;

export const paint = (o: Out, style: Style, text: string): string => (o.color ? `\x1b[${CODES[style]}m${text}\x1b[0m` : text);
// eslint-disable-next-line no-control-regex
export const visible = (s: string): number => [...s.replace(/\x1b\[[0-9;]*m/g, '')].length;

export function table(o: Out, headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(visible(h), ...rows.map(r => visible(r[i] ?? ''))));
  const line = (cells: string[]) => cells.map((c, i) => c + ' '.repeat(widths[i] - visible(c))).join('  ').trimEnd();
  return [line(headers.map(h => paint(o, 'bold', h))), widths.map(w => '-'.repeat(w)).join('  '), ...rows.map(line)].map(l => `  ${l}`).join('\n');
}

export const formatJson = (data: unknown): string => terminalJson(data, 2);

export function formatStatus(o: Out, status: string): string {
  const lower = status.toLowerCase().trim();
  if (['completed', 'passed', 'success', 'healthy', 'approved', 'active', 'ok', 'done'].includes(lower)) return paint(o, 'green', status);
  if (['running', 'in_progress', 'pending', 'processing', 'queued'].includes(lower)) return paint(o, 'yellow', status);
  if (['failed', 'error', 'unhealthy', 'rejected', 'cancelled'].includes(lower)) return paint(o, 'red', status);
  return paint(o, 'dim', status);
}

export const formatTimestamp = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : '-');

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export const banner = (o: Out, text: string): void => { o.out(''); o.out(paint(o, 'bold', `  ${text}`)); o.out(''); };
export const success = (o: Out, text: string): void => o.out(paint(o, 'green', `  ok ${text}`));
export const warn = (o: Out, text: string): void => o.out(paint(o, 'yellow', `  ! ${text}`));
export const info = (o: Out, text: string): void => o.out(paint(o, 'dim', `  ${text}`));
export const errorLine = (o: Out, text: string): void => o.err(paint(o, 'red', `  x ${text}`));

export function keyValue(o: Out, entries: Array<[string, string | undefined | null]>): void {
  const width = Math.max(...entries.map(([k]) => k.length));
  for (const [key, value] of entries) o.out(`  ${paint(o, 'bold', key.padEnd(width))}  ${value ?? '-'}`);
}

export const utf8Locale = (env: Env): boolean => /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '');

export function glyphs(o: Out) {
  const u = o.unicode ?? true;
  return u
    ? {ok: '✔', fail: '✖', warn: '!', dot: '·', rule: '─', more: '…', frames: [...'⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏']}
    : {ok: 'ok', fail: 'x', warn: '!', dot: '|', rule: '-', more: '...', frames: [...'-\\|/']};
}

/** Greedy word wrap on spaces; a word longer than `width` is split. Counts code points. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ').filter(Boolean)) {
    let chars = [...word];
    if (line && [...line].length + 1 + chars.length <= w) { line += ` ${word}`; continue; }
    if (line) lines.push(line);
    while (chars.length > w) { lines.push(chars.slice(0, w).join('')); chars = chars.slice(w); }
    line = chars.join('');
  }
  if (line) lines.push(line);
  return lines;
}

/** Plain text cut to `width` code points, ending with `more` when cut. */
export function fit(text: string, width: number, more: string): string {
  const chars = [...text];
  return chars.length <= width ? text : chars.slice(0, Math.max(0, width - [...more].length)).join('') + more;
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export type TtyDeps = Required<Pick<ConsoleDeps, 'raw' | 'every' | 'onInterrupt' | 'exit'>>;
export interface Spinner {print(line: string): void; stop(): void}

const CLEAR = '\r\x1b[2K';

/** One live status line that redraws every 100 ms; `print` writes a normal line above it. */
export function spinner(o: Out, t: TtyDeps, text: () => string): Spinner {
  const frames = glyphs(o).frames;
  let i = 0;
  let done = false;
  const draw = () => t.raw(`${CLEAR}  ${frames[i++ % frames.length]} ${text()}`);
  t.raw('\x1b[?25l');
  draw();
  const cancel = t.every(draw, 100);
  const stop = () => {
    if (done) return;
    done = true;
    cancel();
    off();
    t.raw(`${CLEAR}\x1b[?25h`);
  };
  const off = t.onInterrupt(() => { stop(); t.exit(130); });
  return {stop, print: line => { if (done) return; t.raw(`${CLEAR}${line}\n`); draw(); }};
}
