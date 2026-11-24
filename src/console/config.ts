import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
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

/** Keys `zof config set` accepts; `api_url` is the name the pre-0.2 console CLI used and is kept as an alias. */
export const CONFIG_KEYS = ['console_url', 'org_id', 'env_id', 'output_format', 'color'] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];
export const configKey = (key: string): ConfigKey | null => (key === 'api_url' ? 'console_url' : (CONFIG_KEYS as readonly string[]).includes(key) ? key as ConfigKey : null);

const dir = (home: string) => join(home, '.zof');
const configPath = (home: string) => join(dir(home), 'config.json');

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

export const orgId = (env: Env, home: string): string | null => loadConfig(env, home).org_id ?? null;
