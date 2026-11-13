/** Release gate client core. Self-contained: imports nothing from the rest of the CLI, so it can move to its own package unchanged. */
import {readFile} from 'node:fs/promises';
import {fetchHttpClient} from './http.js';
import {gateCommand} from './run.js';
import type {ExitCode} from './exit.js';

export {gateCommand, GATE_HELP, DEFAULT_MAX_WAIT_MINUTES, type GateDeps} from './run.js';
export {EXIT, type ExitCode} from './exit.js';
export {redact} from './redact.js';
export {detectCi, type CiFacts} from './ci.js';
export {parseAnswer} from './answer.js';
export {fetchHttpClient, type HttpClient, type HttpRequest, type HttpResponse} from './http.js';
export type {GateAnswer, GateRequest, Provider} from './types.js';

/** Runs the gate with the real process, clock and network. */
export function runGate(argv: string[], version: string): Promise<ExitCode> {
  return gateCommand(argv, {
    version, env: process.env, http: fetchHttpClient, now: Date.now, random: Math.random,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    readFile: path => readFile(path, 'utf8'),
    write: (stream, line) => (stream === 'out' ? process.stdout : process.stderr).write(line + '\n'),
  });
}
