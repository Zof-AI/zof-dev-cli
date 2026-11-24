import {ApiClient} from './api.js';
import {UsageError, type FlagSpec, type Parsed} from './args.js';
import {loadConfig, orgId, type Env} from './config.js';
import {findSignIn, type Found} from './signin.js';
import type {SecretStore} from '../run/keychain.js';
import type {Out, Spinner} from './output.js';
import {spinner, utf8Locale} from './output.js';

/** Everything a console command touches, injected so tests run without a network, a home directory or a clock. */
export interface ConsoleDeps {
  version: string;
  env: Env;
  home: string;
  fetch: typeof fetch;
  write: (stream: 'out' | 'err', line: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  uuid: () => string;
  hostname: () => string;
  platform: string;
  isTty: boolean;
  openUrl: (url: string) => Promise<boolean>;
  writeFile: (path: string, content: string) => void;
  input: NodeJS.ReadableStream;
  /** The terminal, for the chat prompt; absent in tests. */
  output?: NodeJS.WritableStream;
  /** The OS keychain, or null where none is usable. */
  store: () => Promise<SecretStore | null>;
  /** `zof runs create --repo ...` and `zof runs cancel mrun_...`: the planned test-run flow (src/run), with this sign-in. */
  testRun: (argv: string[], signIn: () => Promise<Found | null>) => Promise<number>;
  /** Registers a Ctrl+C handler; returns its removal. */
  onInterrupt: (handler: () => void) => () => void;
  /** Terminal size and raw writes for the spinner; absent in tests. */
  columns?: () => number | undefined;
  raw?: (s: string) => void;
  every?: (fn: () => void, ms: number) => () => void;
  exit?: (code: number) => void;
  /** Asks the person at stdin; absent when stdin is not a terminal (CI, a pipe), so nothing can be asked. */
  ask?: (question: string) => Promise<string | null>;
}

export interface Ctx {
  deps: ConsoleDeps;
  o: Out;
  json: boolean;
  /** A client that sends no token (sign-in, health). */
  client: () => ApiClient;
  /** The client with the sign-in; exit 1 with the login hint when there is none or it expired. */
  authed: () => Promise<ApiClient>;
  signIn: () => Promise<Found | null>;
  consoleUrl: () => string;
  /** A live status line, or null when the terminal cannot animate. */
  spin: (text: () => string) => Spinner | null;
}

export interface Command {
  usage: string;
  summary: string;
  flags?: Record<string, FlagSpec>;
  args?: string[];
  run: (ctx: Ctx, p: Parsed) => Promise<number>;
}

export class NotSignedIn extends Error {}

export function makeCtx(deps: ConsoleDeps, json: boolean): Ctx {
  const config = () => loadConfig(deps.env, deps.home);
  const o: Out = {out: line => deps.write('out', line), err: line => deps.write('err', line), color: deps.isTty && config().color && !json, unicode: utf8Locale(deps.env), width: Math.max(60, deps.columns?.() ?? 80)};
  const make = (token: string | null) => new ApiClient({baseUrl: config().console_url, token, orgId: orgId(deps.env, deps.home), version: deps.version, fetch: deps.fetch});
  let cached: Promise<Found | null> | undefined;
  const signIn = () => (cached ??= findSignIn(deps));
  return {
    deps, o, json, signIn,
    client: () => make(null),
    consoleUrl: () => config().console_url,
    spin: text => {
      const {raw, every, exit} = deps;
      return o.color && raw && every && exit && (deps.columns?.() ?? 80) >= 40 ? spinner(o, {raw, every, exit, onInterrupt: deps.onInterrupt}, text) : null;
    },
    authed: async () => {
      const s = await signIn();
      if (!s) throw new NotSignedIn('Not authenticated. Run `zof auth login` first, or set ZOF_TOKEN.');
      if (s.expires_at <= deps.now()) throw new NotSignedIn('Your sign-in has expired. Run `zof auth login` again.');
      return make(s.token);
    },
  };
}

export const required = (p: Parsed, i: number, name: string): string => {
  const v = p.args[i];
  if (v === undefined || v === '') throw new UsageError(`Missing ${name}.`);
  return v;
};

/** Path segments from the command line are encoded so an id can never reach another route. */
export const seg = (value: string): string => encodeURIComponent(value);
