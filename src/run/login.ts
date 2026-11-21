/** `zof login` and `zof logout`: the console's device flow with the `runs` scope, kept only in the OS keychain. */
import {EXIT, type ExitCode} from '../gate/exit.js';
import {CLIENT_ID, RUNS_SCOPE, Stop, callConsole, clean, codeOf, consoleBase, finish, isToken, printer, readSignIn, usage, type RunDeps, type SignIn} from './common.js';

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

export const LOGIN_HELP = `zof login [--console-url URL]: sign in for test runs (zof run) with your browser.
The sign-in lasts 12 hours and is kept only in your OS keychain. Env: ZOF_CONSOLE_URL (the console address, not a secret).
zof logout: revoke the sign-in in Zof and remove it from this computer.`;

function loginArgs(argv: string[]): {consoleUrl?: string} {
  const out: {consoleUrl?: string} = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].includes('=') ? [argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1)] : [argv[i], undefined];
    if (flag !== '--console-url') throw usage(`Unknown option ${clean(flag, 40)}. Run zof login --help.`);
    const value = inline ?? argv[++i];
    if (!value) throw usage('--console-url needs a value.');
    out.consoleUrl = value;
  }
  return out;
}

export async function loginCommand(argv: string[], deps: RunDeps): Promise<ExitCode> {
  const say = printer(deps, [], false);
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) { deps.write('out', LOGIN_HELP); return EXIT.pass; }
  let token = '';
  try {
    const base = consoleBase(loginArgs(argv).consoleUrl ?? deps.env.ZOF_CONSOLE_URL);
    // The keychain first: with nowhere safe to keep it, no sign-in is ever made.
    const store = await deps.store();
    if (!store) throw usage('No OS keychain is available, so zof login stops here: it never keeps a sign-in in a file or an environment variable. Use the macOS Keychain, the Windows Credential Manager, or a Secret Service keyring on Linux.');
    const started = await callConsole(deps, base, {method: 'POST', path: '/api/auth/device/authorize', body: {client_id: CLIENT_ID, scope: RUNS_SCOPE, cli_metadata: {client: 'zof', version: deps.version}}});
    if (started.status !== 200) throw new Stop(EXIT.config, `Zof refused to start a sign-in (code: ${codeOf(started)}).`, codeOf(started));
    const b = started.body;
    const verify = typeof b.verification_uri_complete === 'string' ? b.verification_uri_complete : '';
    // The approval page must be this console's own: a link elsewhere is never shown.
    if (typeof b.device_code !== 'string' || typeof b.user_code !== 'string' || !sameOrigin(verify, base)) throw new Stop(EXIT.unavailable, "Zof's sign-in answer could not be used.");
    say(`Open ${clean(verify, 500)} and confirm the code ${clean(b.user_code, 32)}.`);
    say('Waiting for you to approve in the browser…');
    let interval = Math.min(60, Math.max(1, Number(b.interval) || 5)) * 1000;
    const deadline = deps.now() + Math.min(900, Math.max(60, Number(b.expires_in) || 600)) * 1000;
    for (;;) {
      if (deps.now() >= deadline) throw new Stop(EXIT.token, 'The sign-in code expired before it was approved. Run zof login again.', 'expired_token');
      await deps.sleep(interval);
      const polled = await callConsole(deps, base, {method: 'POST', path: '/api/auth/device/token', body: {grant_type: DEVICE_GRANT, client_id: CLIENT_ID, device_code: b.device_code}});
      if (polled.status === 200) {
        token = isToken(polled.body.access_token) ? polled.body.access_token : '';
        const scopes = typeof polled.body.scope === 'string' ? polled.body.scope.split(/\s+/) : [];
        if (!token || !scopes.includes(RUNS_SCOPE)) throw new Stop(EXIT.unavailable, "Zof's sign-in answer could not be used; nothing was saved.");
        const seconds = Number(polled.body.expires_in);
        const signIn: SignIn = {v: 1, console: base, token, expires_at: deps.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 12 * 3600) : 12 * 3600) * 1000};
        try {
          await store.set(JSON.stringify(signIn));
        } catch {
          throw new Stop(EXIT.config, `${store.name} refused to keep the sign-in, so it was not saved anywhere. Run zof login again once it is unlocked.`);
        }
        say(`Signed in for test runs until ${new Date(signIn.expires_at).toISOString().slice(0, 16).replace('T', ' ')} UTC. Saved in ${store.name}.`);
        return EXIT.pass;
      }
      const code = codeOf(polled);
      if (code === 'authorization_pending') continue;
      if (code === 'slow_down') { interval += 5000; continue; }
      if (code === 'access_denied') throw new Stop(EXIT.token, 'The sign-in was denied in the browser.', code);
      if (code === 'expired_token') throw new Stop(EXIT.token, 'The sign-in code expired before it was approved. Run zof login again.', code);
      throw new Stop(EXIT.config, `Zof refused the sign-in (code: ${code}).`, code);
    }
  } catch (error) {
    return finish(printer(deps, token ? [token] : [], false), error);
  }
}

export async function logoutCommand(argv: string[], deps: RunDeps): Promise<ExitCode> {
  const say = printer(deps, [], false);
  if (argv.length) { say(argv.length === 1 && ['--help', '-h'].includes(argv[0]) ? LOGIN_HELP : 'zof logout takes no options.'); return argv.length === 1 && ['--help', '-h'].includes(argv[0]) ? EXIT.pass : EXIT.config; }
  try {
    const store = await deps.store();
    if (!store) throw usage('No OS keychain is available, so there is no sign-in on this computer.');
    let raw: string | null;
    try { raw = await store.get(); } catch { throw new Stop(EXIT.config, `${store.name} could not be read. Unlock it and run zof logout again.`); }
    const signIn = readSignIn(raw);
    if (!raw) { say('You are not signed in on this computer.'); return EXIT.pass; }
    let revoked = false;
    let why = 'unreadable sign-in';
    if (signIn) {
      try {
        const r = await callConsole(deps, signIn.console, {method: 'POST', path: '/api/auth/device/revoke', body: {}, token: signIn.token});
        revoked = r.status === 200 && r.body.ok === true;
        why = codeOf(r);
      } catch (error) {
        why = error instanceof Stop ? (error.code ?? 'unavailable') : 'unavailable';
      }
    }
    // Removed from this computer whatever Zof answered: a local copy is never kept once logout is asked.
    await store.delete().catch(() => false);
    if (revoked) { say('Signed out: Zof revoked the sign-in and it was removed from this computer.'); return EXIT.pass; }
    const until = signIn ? ` It stops working by ${new Date(signIn.expires_at).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : '';
    say(`Removed from this computer, but Zof could not revoke the sign-in (code: ${clean(why, 64)}).${until} To end it now, revoke it in the Zof console under your CLI sign-ins.`);
    return EXIT.unavailable;
  } catch (error) {
    return finish(say, error);
  }
}

function sameOrigin(url: string, base: string): boolean {
  try { return new URL(url).origin === base; } catch { return false; }
}
