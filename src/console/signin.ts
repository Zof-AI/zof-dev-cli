/** The one Zof sign-in every console command and `zof runs create --repo` use: the OS keychain, else a 0600 file, else ZOF_TOKEN. */
import {chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {SecretStore} from '../run/keychain.js';
import {readSignIn, type SignIn} from '../run/common.js';
import {consoleOrigin} from './api.js';
import {loadConfig, type Env} from './config.js';

export type Where = 'keychain' | 'file' | 'env';
export interface Found extends SignIn {where: Where}

export interface SignInDeps {
  env: Env;
  home: string;
  /** The OS keychain, or null where none is usable (then the file is used, and the user is told). */
  store: () => Promise<SecretStore | null>;
}

export const credentialsFile = (home: string): string => join(home, '.zof', 'credentials.json');
export const FILE_NOTE = 'No OS keychain is available here, so the sign-in is kept in ~/.zof/credentials.json, readable only by you.';

const origin = (raw: string): string | null => { try { return consoleOrigin(raw); } catch { return null; } };

/** The older file shape (the console repo's CLI): access_token, console_url or api_url, ISO expires_at. */
function fromFile(home: string): SignIn | null {
  const path = credentialsFile(home);
  if (!existsSync(path)) return null;
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (v.v === 1) return readSignIn(JSON.stringify(v));
    const token = typeof v.access_token === 'string' ? v.access_token : '';
    const issuer = typeof v.console_url === 'string' ? v.console_url : typeof v.api_url === 'string' ? v.api_url : '';
    const expires = typeof v.expires_at === 'string' ? Date.parse(v.expires_at) : NaN;
    // A file that names no console predates the binding: it counts for whichever console is configured.
    return token ? {v: 1, token, console: issuer ? (origin(issuer) ?? '') : '', expires_at: Number.isFinite(expires) ? expires : Number.POSITIVE_INFINITY} : null;
  } catch {
    return null;
  }
}

/** ZOF_TOKEN wins; then the keychain, then the file. A saved sign-in counts only for the console that issued it. */
export async function findSignIn(deps: SignInDeps): Promise<Found | null> {
  const consoleUrl = origin(loadConfig(deps.env, deps.home).console_url) ?? '';
  const fromEnv = deps.env.ZOF_TOKEN;
  if (fromEnv) return {v: 1, token: fromEnv, console: consoleUrl, expires_at: Number.POSITIVE_INFINITY, where: 'env'};
  let found: Found | null = null;
  const store = await deps.store().catch(() => null);
  if (store) {
    const raw = await store.get().catch(() => null);
    const s = readSignIn(raw);
    if (s) found = {...s, where: 'keychain'};
  }

  if (!found) {
    const s = fromFile(deps.home);
    if (s) found = {...s, console: s.console || consoleUrl, where: 'file'};
  }

  return found && found.console === consoleUrl ? found : null;
}

/** Keeps the sign-in in the keychain (and removes any file copy), or in a 0600 file only where no keychain exists. */
export async function saveSignIn(deps: SignInDeps, signIn: SignIn): Promise<{where: Where; name: string}> {
  const store = await deps.store().catch(() => null);
  if (store) {
    // A keychain that refuses (locked) is an error, never a quiet fall back to a file.
    await store.set(JSON.stringify(signIn));
    rmSync(credentialsFile(deps.home), {force: true});
    return {where: 'keychain', name: store.name};
  }

  mkdirSync(join(deps.home, '.zof'), {recursive: true, mode: 0o700});
  writeFileSync(credentialsFile(deps.home), JSON.stringify(signIn, null, 2) + '\n', {mode: 0o600});
  chmodSync(credentialsFile(deps.home), 0o600);
  return {where: 'file', name: '~/.zof/credentials.json'};
}

/** Removes the sign-in from the keychain and the file, whatever is there. */
export async function clearSignIn(deps: SignInDeps): Promise<void> {
  const store = await deps.store().catch(() => null);
  if (store) await store.delete().catch(() => false);
  rmSync(credentialsFile(deps.home), {force: true});
}
