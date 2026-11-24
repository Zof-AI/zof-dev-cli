/** Thrown for a command line the user must fix: exit 2, like the rest of zof. */
export class UsageError extends Error {}

export type FlagKind = 'bool' | 'string' | 'int';
export interface FlagSpec {kind: FlagKind; char?: string; options?: readonly string[]; min?: number; max?: number}
export interface Parsed {args: string[]; flags: Record<string, string | boolean | number | undefined>}

/** `--flag value`, `--flag=value`, `-c value` and booleans; anything unknown is a usage error, never ignored. */
export function parseArgs(argv: string[], flags: Record<string, FlagSpec>, maxArgs: number): Parsed {
  const out: Parsed = {args: [], flags: {}};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '--') { out.args.push(...argv.slice(i + 1)); break; }
    if (!raw.startsWith('-') || raw === '-') { out.args.push(raw); continue; }
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const token = eq === -1 ? raw : raw.slice(0, eq);
    const name = token.startsWith('--') ? token.slice(2) : Object.keys(flags).find(k => flags[k].char === token.slice(1));
    const spec = name === undefined ? undefined : flags[name];
    if (!name || !spec) throw new UsageError(`Unknown option ${token.slice(0, 40)}.`);
    if (spec.kind === 'bool') {
      if (eq !== -1) throw new UsageError(`--${name} takes no value.`);
      out.flags[name] = true;
      continue;
    }

    const value = eq === -1 ? argv[++i] : raw.slice(eq + 1);
    if (value === undefined || value === '') throw new UsageError(`--${name} needs a value.`);
    if (spec.options && !spec.options.includes(value)) throw new UsageError(`--${name} must be one of: ${spec.options.join(', ')}.`);
    if (spec.kind === 'int') {
      if (!/^\d{1,9}$/.test(value)) throw new UsageError(`--${name} must be a whole number.`);
      const n = Number(value);
      if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max)) throw new UsageError(`--${name} must be between ${spec.min ?? 0} and ${spec.max}.`);
      out.flags[name] = n;
    } else {
      out.flags[name] = value;
    }
  }

  if (out.args.length > maxArgs) throw new UsageError(`Unexpected argument ${out.args[maxArgs].slice(0, 40)}.`);
  return out;
}
