import {consoleOrigin} from '../api.js';
import {UsageError} from '../args.js';
import {CONFIG_KEYS, configKey, loadConfig, saveConfig} from '../config.js';
import {required, type Command} from '../context.js';
import {banner, formatJson, keyValue, success} from '../output.js';

const list: Command = {
  usage: 'zof config list [--json]',
  summary: 'Show the console CLI configuration (environment overrides included)',
  async run(ctx) {
    const c = loadConfig(ctx.deps.env, ctx.deps.home);
    if (ctx.json) { ctx.o.out(formatJson(c)); return 0; }
    banner(ctx.o, 'Zof CLI - Configuration');
    keyValue(ctx.o, [['Console URL', c.console_url], ['Organization ID', c.org_id], ['Environment ID', c.env_id], ['Output Format', c.output_format], ['Color', c.color ? 'enabled' : 'disabled']]);
    return 0;
  },
};

const get: Command = {
  usage: 'zof config get <key>',
  summary: `Print one value (${CONFIG_KEYS.join(', ')})`,
  args: ['key'],
  async run(ctx, p) {
    const key = configKey(required(p, 0, 'key'));
    if (!key) throw new UsageError(`Unknown config key. Use one of: ${CONFIG_KEYS.join(', ')}.`);
    const value = loadConfig(ctx.deps.env, ctx.deps.home)[key];
    ctx.o.out(value === undefined ? '' : String(value));
    return 0;
  },
};

const set: Command = {
  usage: 'zof config set <key> <value>',
  summary: `Store one value in ~/.zof/config.json (${CONFIG_KEYS.join(', ')})`,
  args: ['key', 'value'],
  async run(ctx, p) {
    const key = configKey(required(p, 0, 'key'));
    const raw = required(p, 1, 'value');
    if (!key) throw new UsageError(`Unknown config key. Use one of: ${CONFIG_KEYS.join(', ')}.`);
    let value: string | boolean = raw;
    if (key === 'color') value = raw === 'true';
    if (key === 'output_format' && !['table', 'json'].includes(raw)) throw new UsageError('output_format must be table or json.');
    if (key === 'console_url') {
      try { value = consoleOrigin(raw); } catch (error) { throw new UsageError((error as Error).message); }
    }

    saveConfig(ctx.deps.home, {[key]: value});
    success(ctx.o, `Set ${key} = ${String(value)}`);
    return 0;
  },
};

const useOrg: Command = {
  usage: 'zof config use-org <org-id>',
  summary: 'Set the active organization',
  args: ['org-id'],
  async run(ctx, p) {
    const id = required(p, 0, 'org-id');
    saveConfig(ctx.deps.home, {org_id: id});
    success(ctx.o, `Active organization set to ${id}`);
    return 0;
  },
};

const useEnv: Command = {
  usage: 'zof config use-env <env-id>',
  summary: 'Set the active environment',
  args: ['env-id'],
  async run(ctx, p) {
    const id = required(p, 0, 'env-id');
    saveConfig(ctx.deps.home, {env_id: id});
    success(ctx.o, `Active environment set to ${id}`);
    return 0;
  },
};

export const CONFIG: Record<string, Command> = {list, get, set, 'use-org': useOrg, 'use-env': useEnv};
