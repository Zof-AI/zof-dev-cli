import {chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

/** The hosted Zof console; ZOF_CONSOLE_URL or `zof config set console_url` points elsewhere (another region, a local console). */
export const DEFAULT_CONSOLE_URL = 'https://console.zof.ai';

export type Env = Record<string, string | undefined>;

export interface ConsoleConfig {
  console_url: string;
  org_id?: string;
  env_id?: string;
  output_format: 'table' | 'json';
  color: boolean;
}

export interface Credentials {
  access_token: string;
  org_id?: string;
  console_url?: string;
  created_at?: string;
  expires_at?: string;
}

/** Keys `zof config set` accepts; `api_url` is the name the pre-0.2 console CLI used and is kept as an alias. */
export const CONFIG_KEYS = ['console_url', 'org_id', 'env_id', 'output_format', 'color'] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
export const configKey = (key: string): ConfigKey | null => (key === 'api_url' ? 'console_url' : (CONFIG_KEYS as readonly string[]).includes(key) ? key as ConfigKey : null);

const dir = (home: string) => join(home, '.zof');
const configPath = (home: string) => join(dir(home), 'config.json');
const credentialsPath = (home: string) => join(dir(home), 'credentials.json');

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Environment first, then ~/.zof/config.json, then defaults. */
export function loadConfig(env: Env, home: string): ConsoleConfig {
  const stored = readJson(configPath(home));
  const format = text(env.ZOF_OUTPUT) ?? text(stored.output_format);
  return {
    console_url: text(env.ZOF_CONSOLE_URL) ?? text(stored.console_url) ?? text(stored.api_url) ?? DEFAULT_CONSOLE_URL,
    org_id: text(env.ZOF_ORG_ID) ?? text(stored.org_id),
    env_id: text(env.ZOF_ENV_ID) ?? text(stored.env_id),
    output_format: format === 'json' ? 'json' : 'table',
    color: env.ZOF_NO_COLOR !== '1' && env.NO_COLOR === undefined && stored.color !== false,
  };
}

/** Merges into the stored file only, so environment overrides are never written to disk. */
export function saveConfig(home: string, patch: Partial<Record<ConfigKey, string | boolean>>): void {
  mkdirSync(dir(home), {recursive: true, mode: 0o700});
  const {api_url: legacy, ...stored} = readJson(configPath(home));
  const merged = {...(legacy !== undefined && stored.console_url === undefined ? {console_url: legacy} : {}), ...stored, ...patch};
  writeFileSync(configPath(home), JSON.stringify(merged, null, 2) + '\n', {mode: 0o600});
}

/** ZOF_TOKEN (for CI) wins over the stored sign-in. */
export function loadCredentials(env: Env, home: string): Credentials | null {
  const fromEnv = text(env.ZOF_TOKEN);
  if (fromEnv) return {access_token: fromEnv};
  const stored = readJson(credentialsPath(home));
  const token = text(stored.access_token);
  return token ? {...stored, access_token: token} as Credentials : null;
}

export function saveCredentials(home: string, credentials: Credentials): void {
  mkdirSync(dir(home), {recursive: true, mode: 0o700});
  writeFileSync(credentialsPath(home), JSON.stringify(credentials, null, 2) + '\n', {mode: 0o600});
  chmodSync(credentialsPath(home), 0o600);
}

export function clearCredentials(home: string): void {
  rmSync(credentialsPath(home), {force: true});
}

const sameConsole = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** A saved sign-in goes only to the console that issued it, so a local token never reaches production; ZOF_TOKEN is used as given. */
export function consoleToken(env: Env, home: string): string | null {
  const creds = loadCredentials(env, home);
  if (!creds) return null;
  const issuer = creds.console_url ?? text((creds as unknown as Record<string, unknown>).api_url);
  if (issuer && !text(env.ZOF_TOKEN) && !sameConsole(issuer, loadConfig(env, home).console_url)) return null;
  return creds.access_token;
}

export const orgId =(env: Env, home: string): string | null => loadConfig(env, home).org_id ?? loadCredentials(env, home)?.org_id ?? null;
