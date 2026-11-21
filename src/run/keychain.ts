/**
 * Where `zof login` keeps its sign-in: the OS keychain only (spec 2026-11-21 §2). Never a file, never an env var, and
 * never in any process's argv, where `ps` and shell history could read it.
 */

/** The one way this module starts a process; tests spy on it to prove no argv ever carries the token. */
export type Spawn = (command: string, args: readonly string[], options?: {stdin?: string}) => Promise<{code: number | null; stdout: string}>;

export interface SecretStore {
  /** A short name for messages, e.g. "the macOS Keychain". */
  readonly name: string;
  get(): Promise<string | null>;
  set(secret: string): Promise<void>;
  /** True when an entry was removed. */
  delete(): Promise<boolean>;
}

const SERVICE = 'zof-cli';
const ACCOUNT = 'runs';

interface NativeEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}
type NativeModule = {Entry: new (service: string, account: string) => NativeEntry};

const KEYCHAIN_NAMES: Record<string, string> = {darwin: 'the macOS Keychain', win32: 'the Windows Credential Manager', linux: 'the Secret Service keyring'};

/** The pinned native binding (@napi-rs/keyring): the secret crosses into the OS store in-process, never through argv. */
export function nativeStore(native: NativeModule, platform: string): SecretStore {
  const entry = new native.Entry(SERVICE, ACCOUNT);
  return {
    name: KEYCHAIN_NAMES[platform] ?? 'the OS keychain',
    get: async () => entry.getPassword() ?? null,
    set: async secret => { entry.setPassword(secret); },
    delete: async () => entry.deletePassword(),
  };
}

/** Linux without the binding: `secret-tool` reads the secret from stdin, so it never appears in argv. */
export function secretToolStore(spawn: Spawn): SecretStore {
  const attrs = ['service', SERVICE, 'account', ACCOUNT];
  return {
    name: 'the Secret Service keyring (secret-tool)',
    get: async () => {
      const r = await spawn('secret-tool', ['lookup', ...attrs]);
      return r.code === 0 && r.stdout ? r.stdout.replace(/\n$/, '') : null;
    },
    set: async secret => {
      const r = await spawn('secret-tool', ['store', '--label=Zof CLI (test runs)', ...attrs], {stdin: secret});
      if (r.code !== 0) throw new Error('secret-tool store failed');
    },
    delete: async () => (await spawn('secret-tool', ['clear', ...attrs])).code === 0,
  };
}

/** The native binding, else (Linux only) secret-tool, else null: the caller then refuses to sign in. */
export async function loadStore(opts: {platform: string; spawn: Spawn; native: () => Promise<NativeModule>}): Promise<SecretStore | null> {
  try {
    return nativeStore(await opts.native(), opts.platform);
  } catch {
    // No prebuilt binding for this platform: fall through to a stdin-fed tool, never to a file.
  }
  if (opts.platform !== 'linux') return null;
  try {
    // A probe with no secret: only whether the tool runs at all.
    const probe = await opts.spawn('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]);
    return probe.code === 0 || probe.code === 1 ? secretToolStore(opts.spawn) : null;
  } catch {
    return null;
  }
}
