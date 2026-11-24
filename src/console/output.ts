import {terminalJson} from './api.js';

/** Terminal output without dependencies: colour only on request, plain tables, one line per write. */
export interface Out {
  out(line: string): void;
  err(line: string): void;
  color: boolean;
}

const CODES = {bold: '1', dim: '90', red: '31', green: '32', yellow: '33', blue: '34', cyan: '36', underline: '4'} as const;
export type Style = keyof typeof CODES;

export const paint = (o: Out, style: Style, text: string): string => (o.color ? `\x1b[${CODES[style]}m${text}\x1b[0m` : text);
// eslint-disable-next-line no-control-regex
const visible = (s: string): number => [...s.replace(/\x1b\[[0-9;]*m/g, '')].length;

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
