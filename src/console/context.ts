import {ApiClient} from './api.js';
import {UsageError, type FlagSpec, type Parsed} from './args.js';
import {consoleToken, loadConfig, orgId, type Env} from './config.js';
import type {Out} from './output.js';

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
  /** Registers a Ctrl+C handler; returns its removal. */
  onInterrupt: (handler: () => void) => () => void;
}

export interface Ctx {
  deps: ConsoleDeps;
  o: Out;
  json: boolean;
  client: () => ApiClient;
  /** The client, after checking a sign-in exists (exit 1 with the login hint if not). */
  authed: () => ApiClient;
  consoleUrl: () => string;
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
  const o: Out = {out: line => deps.write('out', line), err: line => deps.write('err', line), color: deps.isTty && config().color && !json};
  const client = () => new ApiClient({baseUrl: config().console_url, token: consoleToken(deps.env, deps.home), orgId: orgId(deps.env, deps.home), version: deps.version, fetch: deps.fetch});
  return {
    deps, o, json, client,
    consoleUrl: () => config().console_url,
    authed: () => {
      const c = client();
      if (!c.settings.token) throw new NotSignedIn();
      return c;
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
