/** Zof credential prefixes: pipeline, break-glass, deploy and console tokens. */
const TOKEN = /(zgt|zbg|zdt|zct)_[A-Za-z0-9_-]+/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f\u009b]/g;

/** Masks Zof tokens and any known secret, strips control characters, and neutralises CI workflow commands. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = String(text);
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join('[redacted]');
  out = out.replace(TOKEN, (_m, prefix: string) => `${prefix}_[redacted]`).replace(CONTROL, '');
  // The runner trims leading whitespace before it parses a command, so prefix a visible character.
  return out.split('\n').map(line => (/^\s*(::|##\[|##vso\[)/.test(line) ? '> ' + line : line)).join('\n');
}
