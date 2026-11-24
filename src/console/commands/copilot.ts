import * as readline from 'node:readline';
import {ApiError} from '../api.js';
import {UsageError} from '../args.js';
import type {Command} from '../context.js';
import {askTurn, cleanText, consoleApi, conversationTitle, errorHint, eventLine, jsonEvents, startConversation, turnOutcome, type CopilotEvent, type StopReason} from '../copilot-turn.js';
import {banner, errorLine, paint} from '../output.js';
import {reviewJson} from '../review-render.js';

const ask: Command = {
  usage: 'zof copilot ask "<question>" [--json]',
  summary: 'Ask Copilot one question (read-only from the CLI: it can answer and look things up, not change anything)',
  args: ['question'],
  async run(ctx, p) {
    const question = (p.args[0] ?? '').trim();
    if (!question) throw new UsageError('Ask a question: zof copilot ask "<question>"');
    const api = consoleApi(await ctx.authed());
    const {o, json} = ctx;
    let conversationId: string;
    let turn: {events: CopilotEvent[]; stopped: StopReason};
    try {
      conversationId = await startConversation(api, conversationTitle(question));
      const id = conversationId;
      turn = await askTurn(api, id, question, e => {
        const line = json ? null : eventLine(e, id);
        if (line) o.out(paint(o, 'dim', `  ${line}`));
      });
    } catch (error) {
      if (error instanceof ApiError) throw new ApiError(error.statusCode, error.errorCode, errorHint(error), error.requestId);
      throw error;
    }

    const outcome = turnOutcome(turn.events, turn.stopped, conversationId);
    if (json) {
      o.out(reviewJson({conversation_id: conversationId, events: jsonEvents(turn.events)}));
    } else {
      if (outcome.answer) { o.out(''); for (const line of outcome.answer.split('\n')) o.out(`  ${line}`); o.out(''); }
      if (outcome.error) errorLine(o, outcome.error);
    }

    return outcome.exit;
  },
};

const chat: Command = {
  usage: 'zof copilot chat',
  summary: 'Chat with Copilot (read-only from the CLI: it can answer and look things up, not change anything)',
  async run(ctx) {
    const api = consoleApi(await ctx.authed());
    const {o} = ctx;
    banner(o, 'Zof Copilot');
    o.out(paint(o, 'dim', "  Read-only from the CLI: Copilot can answer and look things up, but can't start, approve or change anything."));
    o.out(paint(o, 'dim', '  Type your message and press Enter. Type "exit" to quit.'));
    o.out('');
    const tty = ctx.deps.isTty && ctx.deps.output !== undefined;
    const rl = readline.createInterface({input: ctx.deps.input, output: tty ? ctx.deps.output : undefined, terminal: tty});
    rl.setPrompt(paint(o, 'green', '  you > '));
    const prompt = () => { if (tty) rl.prompt(); };
    prompt();
    // Started with the first message, so the console history shows it by that question.
    let conversationId: string | null = null;
    let code = 0;
    for await (const input of rl) {
      const trimmed = input.trim();
      if (!trimmed) { prompt(); continue; }
      if (trimmed.toLowerCase() === 'exit') break;
      // Every error is shown and the chat goes on; only a lost sign-in ends it.
      try {
        conversationId ??= await startConversation(api, conversationTitle(trimmed));
        const id = conversationId;
        const {events, stopped} = await askTurn(api, id, trimmed, e => {
          const line = eventLine(e, id);
          if (line) o.out(paint(o, 'dim', `  ${line}`));
        });
        const outcome = turnOutcome(events, stopped, id);
        if (outcome.answer) o.out(paint(o, 'blue', '  zof > ') + outcome.answer.split('\n').join('\n        '));
        if (outcome.error) errorLine(o, outcome.error);
        o.out('');
      } catch (error) {
        errorLine(o, error instanceof ApiError ? errorHint(error, true) : cleanText(error instanceof Error ? error.message : String(error)));
        if (error instanceof ApiError && error.errorCode === 'conversation_not_found') conversationId = null;
        if (error instanceof ApiError && error.statusCode === 401) { code = 1; break; }
      }

      prompt();
    }

    rl.close();
    o.out(paint(o, 'dim', '  Chat ended.'));
    return code;
  },
};

export const COPILOT: Record<string, Command> = {ask, chat};
