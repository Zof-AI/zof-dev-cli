import {ApiError, consoleOrigin} from '../api.js';
import {UsageError} from '../args.js';
import {saveConfig} from '../config.js';
import {isToken} from '../../run/common.js';
import {clearSignIn, FILE_NOTE, saveSignIn} from '../signin.js';
import type {Command, Ctx} from '../context.js';
import {banner, errorLine, formatJson, formatTimestamp, info, keyValue, paint, success, table} from '../output.js';

// Must be in the console's device-flow allow-list (dash src/lib/auth/device-flow/clientIds.ts).
export const DEVICE_CLIENT_ID = 'zof-cli-app';
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

interface DeviceAuth {device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number}
interface TokenAnswer {access_token: string; token_type: string; expires_in: number; scope: string}
interface TokenRefusal {error: string; error_description?: string}
interface Session {user: {id: string; email: string; name: string}; tenant: {id: string; name: string; slug: string} | null; scopes: string[]}

export const authorizeBody = (version: string, host: string, platform: string) => ({
  client_id: DEVICE_CLIENT_ID,
  scope: 'cli',
  cli_metadata: {hostname: host, machine_label: `${host}-cli`, platform, cli_version: version},
});

export const tokenBody = (deviceCode: string) => ({client_id: DEVICE_CLIENT_ID, device_code: deviceCode, grant_type: DEVICE_GRANT});

/** RFC 8628 polling: pending and slow_down keep waiting, anything else ends the login. */
async function pollForToken(ctx: Ctx, deviceCode: string, intervalS: number): Promise<TokenAnswer | null> {
  const client = ctx.client();
  let interval = Math.max(1, Number.isFinite(intervalS) ? intervalS : 5);
  for (let attempt = 0; attempt < 120; attempt++) {
    await ctx.deps.sleep(interval * 1000);
    let result: TokenAnswer | TokenRefusal;
    try {
      result = await client.post<TokenAnswer | TokenRefusal>('/api/auth/device/token', tokenBody(deviceCode), {requireAuth: false});
    } catch (error) {
      // A 4xx with an RFC 8628 body is the normal "not yet"; network blips are retried.
      if (!(error instanceof ApiError)) throw error;
      if (error.errorCode === 'NETWORK_ERROR') continue;
      const what = `${error.errorCode} ${error.message}`;
      if (/slow_down/.test(what)) { interval += 1; continue; }
      if (/expired_token/.test(what)) { errorLine(ctx.o, 'Device code expired. Please try again.'); return null; }
      if (/access_denied/.test(what)) { errorLine(ctx.o, 'Authorization denied by user.'); return null; }
      if (/authorization_pending/.test(what) || (error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 401)) continue;
      throw error;
    }

    if ('access_token' in result && typeof result.access_token === 'string') return result;
    const refusal = result as TokenRefusal;
    if (refusal.error === 'authorization_pending') continue;
    if (refusal.error === 'slow_down') { interval += 1; continue; }
    if (refusal.error === 'expired_token') { errorLine(ctx.o, 'Device code expired. Please try again.'); return null; }
    if (refusal.error === 'access_denied') { errorLine(ctx.o, 'Authorization denied by user.'); return null; }
    errorLine(ctx.o, `Authorization error: ${refusal.error_description || refusal.error}`);
    return null;
  }

  return null;
}

const login: Command = {
  usage: 'zof auth login [--console-url URL] [--no-browser]   (alias: zof login)',
  summary: 'Sign in with the device code flow. The sign-in goes in the OS keychain; only where none exists, in ~/.zof/credentials.json (0600)',
  flags: {'no-browser': {kind: 'bool'}, 'console-url': {kind: 'string'}},
  async run(ctx, p) {
    const {o, deps} = ctx;
    if (typeof p.flags['console-url'] === 'string') {
      let wanted: string;
      try { wanted = consoleOrigin(p.flags['console-url']); } catch (error) { throw new UsageError((error as Error).message); }
      if (deps.env.ZOF_CONSOLE_URL && deps.env.ZOF_CONSOLE_URL.replace(/\/+$/, '') !== wanted) throw new UsageError('--console-url differs from ZOF_CONSOLE_URL; unset one of them.');
      // Saved, so later commands use the console this sign-in belongs to.
      saveConfig(deps.home, {console_url: wanted});
    }

    const client = ctx.client();
    const origin = consoleOrigin(client.baseUrl);
    banner(o, 'Zof CLI - Login');
    info(o, 'Initiating device authorization...');
    const device = await client.post<DeviceAuth>('/api/auth/device/authorize', authorizeBody(deps.version, deps.hostname(), deps.platform), {requireAuth: false});
    o.out('');
    o.out(`  Your verification code: ${paint(o, 'yellow', device.user_code)}`);
    o.out('');
    o.out('  Open this URL to authenticate:');
    o.out(`  ${paint(o, 'underline', device.verification_uri_complete)}`);
    o.out('');
    // Only a page on the console itself is opened; anything else the user can still open by hand.
    let sameOrigin = false;
    try { sameOrigin = new URL(device.verification_uri_complete).origin === origin; } catch { /* not a URL */ }
    if (!p.flags['no-browser'] && sameOrigin && await deps.openUrl(device.verification_uri_complete)) info(o, 'Browser opened. Waiting for approval...');
    else info(o, 'Open the URL above in your browser and enter the code.');
    info(o, 'Waiting for authorization...');
    const token = await pollForToken(ctx, device.device_code, device.interval);
    if (!token) {
      errorLine(o, 'Authorization failed or timed out.');
      return 1;
    }

    if (!isToken(token.access_token)) {
      errorLine(o, "Zof's sign-in answer could not be used; nothing was saved.");
      return 1;
    }

    const session = await client.get<Session>('/api/cli/session', {requireAuth: false, headers: {Authorization: `Bearer ${token.access_token}`}});
    const seconds = Number(token.expires_in);
    let saved: {where: string; name: string};
    try {
      saved = await saveSignIn(deps, {v: 1, console: origin, token: token.access_token, expires_at: deps.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 12 * 3600) * 1000});
    } catch {
      errorLine(o, 'The OS keychain refused to keep the sign-in (is it locked?), so it was not saved anywhere. Unlock it and run zof auth login again.');
      return 1;
    }

    if (session.tenant?.id) saveConfig(deps.home, {org_id: session.tenant.id});
    o.out('');
    success(o, `Authenticated as ${session.user.email}`);
    if (session.tenant) info(o, `Organization: ${session.tenant.name} (${session.tenant.slug})`);
    info(o, saved.where === 'keychain' ? `Saved in ${saved.name}.` : FILE_NOTE);
    return 0;
  },
};

const logout: Command = {
  usage: 'zof auth logout   (alias: zof logout)',
  summary: 'Revoke the sign-in in Zof and remove it from this computer (keychain and file)',
  async run(ctx) {
    const {o, deps} = ctx;
    const found = await ctx.signIn();
    if (deps.env.ZOF_TOKEN) {
      info(o, 'ZOF_TOKEN is set in this shell: it is not revoked or removed. Unset it, and revoke the token in the console if it should stop working.');
      await clearSignIn(deps);
      return 0;
    }

    let revoked = false;
    let why = '';
    if (found) {
      try {
        const r = await ctx.client().post<{ok?: boolean}>('/api/auth/device/revoke', {}, {requireAuth: false, headers: {Authorization: `Bearer ${found.token}`}});
        revoked = r?.ok === true;
      } catch (error) {
        why = error instanceof ApiError ? error.errorCode : 'unavailable';
      }
    }

    // Removed from this computer whatever Zof answered: a local copy is never kept once logout is asked.
    await clearSignIn(deps);
    if (!found) { success(o, 'You are not signed in on this computer.'); return 0; }
    if (revoked) { success(o, 'Signed out: Zof revoked the sign-in and it was removed from this computer.'); return 0; }
    errorLine(o, `Removed from this computer, but Zof could not revoke the sign-in (${why || 'no confirmation'}). Revoke it in the console under your CLI tokens to end it now.`);
    return 1;
  },
};

const whoami: Command = {
  usage: 'zof auth whoami [--json]',
  summary: 'Show the signed-in identity and organization',
  async run(ctx) {
    const session = await (await ctx.authed()).get<Session>('/api/cli/session');
    const found = await ctx.signIn();
    const expires = found && Number.isFinite(found.expires_at) ? new Date(found.expires_at).toISOString() : undefined;
    if (ctx.json) { ctx.o.out(formatJson({user: session.user, tenant: session.tenant, scopes: session.scopes, expires_at: expires})); return 0; }
    banner(ctx.o, 'Zof CLI - Identity');
    keyValue(ctx.o, [
      ['User', session.user.name || session.user.email],
      ['Email', session.user.email],
      ['User ID', session.user.id],
      ['Organization', session.tenant ? `${session.tenant.name} (${session.tenant.slug})` : null],
      ['Org ID', session.tenant?.id],
      ['Scopes', (session.scopes ?? []).join(', ')],
      ['Token Expires', expires ? new Date(expires).toLocaleString() : undefined],
      ['Kept in', found?.where === 'keychain' ? 'OS keychain' : found?.where === 'file' ? '~/.zof/credentials.json' : found?.where === 'env' ? 'ZOF_TOKEN' : undefined],
    ]);
    ctx.o.out('');
    return 0;
  },
};

interface TokenInfo {id: string; tokenPrefix: string; scopesJson: string; expiresAt: string; createdAt: string; label: string | null; createdByAuthMethod: string}

const tokens: Command = {
  usage: 'zof auth tokens [--json]',
  summary: 'List your active CLI tokens (prefixes only)',
  async run(ctx) {
    const list = await (await ctx.authed()).get<TokenInfo[]>('/api/auth/device/tokens');
    if (ctx.json) { ctx.o.out(formatJson(list)); return 0; }
    banner(ctx.o, 'Zof CLI - Active Tokens');
    if (!list?.length) { ctx.o.out('  No active CLI tokens.'); return 0; }
    const rows = list.map(t => {
      let scopes = 'cli';
      try { scopes = (JSON.parse(t.scopesJson) as string[]).join(', '); } catch { /* keep the default */ }
      return [`${t.tokenPrefix}...`, t.label || '-', scopes, formatTimestamp(t.createdAt), formatTimestamp(t.expiresAt), t.createdByAuthMethod];
    });
    ctx.o.out(table(ctx.o, ['Token', 'Label', 'Scopes', 'Created', 'Expires', 'Auth Method'], rows));
    return 0;
  },
};

export const AUTH: Record<string, Command> = {login, logout, whoami, tokens};
