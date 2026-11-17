import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {Exit, runGateCli, type CliIo, type ExitCode, type GateDeps} from '@zof-ai/gate';

export interface GateRuntime {
  env: Record<string, string | undefined>;
  io: CliIo;
  deps: GateDeps;
}

function productionRuntime(): GateRuntime {
  return {
    env: process.env,
    io: {
      stdout: line => { process.stdout.write(line + '\n'); },
      stderr: line => { process.stderr.write(line + '\n'); },
      readFile: path => {
        try { return readFileSync(path, 'utf8'); } catch { return undefined; }
      },
    },
    deps: {
      fetch: (url, init) => fetch(url, init),
      now: () => Date.now(),
      sleep: ms => delay(ms),
      random: () => Math.random(),
      timeoutSignal: ms => AbortSignal.timeout(ms),
    },
  };
}

// Only command-name prefixes change: JSON, server messages and GitHub token-mask values stay byte-for-byte.
function commandLine(line: string): string {
  return line.replace(/^Usage: zof-gate /, 'Usage: zof gate ')
    .replace(/^zof-gate: /, 'zof gate: ')
    .replace(/^Run zof-gate --help for usage\.$/, 'Run zof gate --help for usage.');
}

/** `decide` remains an alias for the command shipped in 0.1.3; all gate behavior belongs to the shared client. */
export async function runGate(argv: readonly string[], runtime: GateRuntime = productionRuntime()): Promise<ExitCode> {
  const args = argv[0] === 'decide' ? argv.slice(1) : argv;
  try {
    return await runGateCli(args, runtime.env, {
      ...runtime.io,
      stdout: line => runtime.io.stdout(commandLine(line)),
      stderr: line => runtime.io.stderr(commandLine(line)),
    }, runtime.deps);
  } catch {
    // Dependency/network exceptions must never become a successful deploy or expose request credentials.
    runtime.io.stderr('Zof unavailable: the gate client could not finish.');
    return Exit.Unavailable;
  }
}
