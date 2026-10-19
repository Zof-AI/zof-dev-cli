#!/usr/bin/env node
/** Explicit, bounded preparation of SHA256-pinned GitHub release dependencies. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat, mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { dirname, basename, delimiter, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ARTIFACT = 32 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const REDIRECT_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const fail = () => new Error('Release dependency preparation failed. Check the reviewed release manifest and network availability.');

export function validateManifest(value) {
  if (!value || value.schemaVersion !== 1 || value.release !== 'v0.1.0' || !Array.isArray(value.dependencies) || value.dependencies.length > 32) throw fail();
  const names = new Set(); let total = 0;
  for (const entry of value.dependencies) {
    if (!entry || !/^@zof-ai\/[a-z][a-z0-9-]*$/.test(entry.packageName) || entry.version !== '0.1.0' || !/^zof-[a-z][a-z0-9-]*$/.test(entry.repository) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 1 || entry.sizeBytes > MAX_ARTIFACT || names.has(entry.packageName)) throw fail();
    const artifact = `zof-ai-${entry.packageName.slice('@zof-ai/'.length)}-0.1.0.tgz`;
    if (entry.artifact !== artifact || entry.url !== `https://github.com/Zof-AI/${entry.repository}/releases/download/v0.1.0/${artifact}`) throw fail();
    names.add(entry.packageName); total += entry.sizeBytes;
  }
  if (total > MAX_TOTAL) throw fail();
  return value;
}

export async function readManifest(path = join(ROOT, 'scripts/release-dependencies.json')) {
  try {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 64 * 1024) throw fail();
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 64 * 1024) throw fail();
    return validateManifest(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
  } finally { await handle.close(); }
  } catch { throw fail(); }
}

export async function downloadArtifact(entry, fetchImpl = globalThis.fetch) {
  validateManifest({ schemaVersion: 1, release: 'v0.1.0', dependencies: [entry] });
  let url = entry.url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || (parsed.port && parsed.port !== '443') || !REDIRECT_HOSTS.has(parsed.hostname)) throw fail();
      const response = await fetchImpl(url, { redirect: 'manual', signal: controller.signal, headers: { Accept: 'application/octet-stream' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 3) throw fail();
        url = new URL(location, url).href;
        continue;
      }
      if (response.status !== 200 || !response.body || ![null, 'identity'].includes(response.headers.get('content-encoding'))) {
        await response.body?.cancel(); throw fail();
      }
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) !== entry.sizeBytes)) { await response.body.cancel(); throw fail(); }
      const chunks = []; const hash = createHash('sha256'); let size = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > entry.sizeBytes || size > MAX_ARTIFACT) { await reader.cancel(); throw fail(); }
          hash.update(value); chunks.push(Buffer.from(value));
        }
      } finally { reader.releaseLock(); }
      if (size !== entry.sizeBytes || hash.digest('hex') !== entry.sha256) throw fail();
      return Buffer.concat(chunks, size);
    }
    throw fail();
  } catch { throw fail(); } finally { clearTimeout(timer); }
}

async function findNpm() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    candidates.push(join(directory, 'npm'), join(directory, 'node_modules/npm/bin/npm-cli.js'), join(directory, '../lib/node_modules/npm/bin/npm-cli.js'));
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { const path = await realpath(candidate); if (basename(path) === 'npm-cli.js' && (await stat(path)).isFile()) return path; } catch { /* Try the next installed npm location. */ }
  }
  throw fail();
}

export async function prepareDependencies(manifest, { cache = process.env.npm_config_cache || join(homedir(), '.npm'), fetchImpl = globalThis.fetch } = {}) {
  validateManifest(manifest);
  if (manifest.dependencies.length === 0) return 0;
  const npm = await findNpm();
  const temporary = await mkdtemp(join(tmpdir(), 'zof-release-deps-'));
  await chmod(temporary, 0o700);
  try {
    const config = join(temporary, 'user.npmrc'); const globalConfig = join(temporary, 'global.npmrc');
    await writeFile(config, '', { mode: 0o600, flag: 'wx' });
    await writeFile(globalConfig, '', { mode: 0o600, flag: 'wx' });
    for (const entry of manifest.dependencies) {
      const buffer = await downloadArtifact(entry, fetchImpl);
      const artifact = join(temporary, entry.artifact);
      await writeFile(artifact, buffer, { mode: 0o600, flag: 'wx' });
      const env = {};
      for (const name of ['PATH', 'SystemRoot', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[name]) env[name] = process.env[name];
      await new Promise((resolvePromise, reject) => {
        const child = spawn(process.execPath, [npm, 'cache', 'add', artifact, '--ignore-scripts', '--no-audit', '--no-fund', '--cache', resolve(cache), '--userconfig', config, '--globalconfig', globalConfig], { cwd: temporary, env, stdio: 'ignore', shell: false, timeout: 60_000 });
        child.on('error', () => reject(fail()));
        child.on('close', code => code === 0 ? resolvePromise() : reject(fail()));
      });
      await rm(artifact);
    }
    return manifest.dependencies.length;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || argv[0] !== '--allow-network') {
    process.stderr.write('Usage: node scripts/bootstrap.mjs --allow-network\nThis explicitly downloads the pinned public GitHub release dependencies into the npm cache.\n');
    return 2;
  }
  try {
    const count = await prepareDependencies(await readManifest());
    process.stdout.write(`Prepared ${count} verified release dependencies. Run npm ci --ignore-scripts --prefer-offline with the same npm cache.\n`);
    return 0;
  } catch {
    // Never echo remote URLs, signed redirect queries, credentials, or raw npm logs.
    process.stderr.write('Release dependency preparation failed. Check the reviewed release manifest, npm cache permissions, and network availability.\n');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
