import {ApiError, type ApiClient} from './api.js'

/** One event of the console's turn stream (dash src/copilot/stream/events.ts); only the fields the CLI reads are typed. */
export type CopilotEvent = {type: string; [key: string]: unknown}

export interface CopilotApi {
  post<T>(path: string, body: unknown): Promise<T>
  stream(path: string, body: unknown): Promise<Response>
}

/** A turn has no client deadline on the server side of the stream; stop waiting after this. */
export const TURN_DEADLINE_MS = 300_000

// Model text about untrusted data: drop control characters (ESC, C1 such as U+009B, DEL) so it cannot steer the
// terminal; newlines and tabs stay so answers keep their shape.
export const cleanText = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const oneLine = (s: string): string => cleanText(s).replace(/\s+/g, ' ').trim()

/** A frame longer than this without its blank-line end ends the read, as the console's own filter does (256 KiB). */
const MAX_BUFFER_CHARS = 1024 * 1024

/**
 * Reads SSE frames (`id: n\ndata: <json>\n\n`, `: ping` comments) and hands each event to onEvent. Ends at the first
 * `done`, at the deadline, at the end of the stream or on a dropped connection (Node's fetch rejects the read), never throws.
 */
export type StopReason = 'done' | 'end' | 'deadline' | 'dropped'

export async function readEvents(
  body: ReadableStream<Uint8Array>,
  onEvent: (e: CopilotEvent) => void,
  deadlineMs = TURN_DEADLINE_MS,
): Promise<StopReason> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), deadlineMs)
  })
  let buffer = ''
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline])
      if (next === 'deadline') return 'deadline'
      if (next.done) return 'end'
      buffer = (buffer + decoder.decode(next.value, {stream: true})).replace(/\r\n/g, '\n')
      if (buffer.length > MAX_BUFFER_CHARS) return 'dropped'
      let end: number
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const data = buffer
          .slice(0, end)
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n')
        buffer = buffer.slice(end + 2)
        let event: unknown
        try {
          event = data ? JSON.parse(data) : null
        } catch {
          continue
        }

        if (!event || typeof event !== 'object' || typeof (event as CopilotEvent).type !== 'string') continue
        onEvent(event as CopilotEvent)
        if ((event as CopilotEvent).type === 'done') return 'done'
      }
    }
  } catch {
    // The connection dropped: what arrived stands, and the outcome says there was no answer.
    return 'dropped'
  } finally {
    clearTimeout(timer)
    reader.cancel().catch(() => {})
  }
}

/** One plain line for a finished tool or a card that needs the console, else null. */
export function eventLine(e: CopilotEvent, conversationId?: string): string | null {
  if (e.type === 'tool' && (e.status === 'done' || e.status === 'failed')) {
    const what = str(e.label) ?? str(e.title) ?? str(e.name) ?? 'tool'
    return `· ${oneLine(what)}${e.status === 'failed' ? ' (failed)' : ''}`
  }

  // A CLI token can't answer a card (its routes answer 403 cli_read_only).
  if (e.type === 'interrupt') {
    return `· ${oneLine(str(e.title) ?? 'A question')}: open the Zof console to answer this${conversationId ? ` (conversation ${oneLine(conversationId)})` : ''}.`
  }

  return null
}

/** The events `ask --json` prints: no tokens (final.text has the answer; thinking is never shown). */
export const jsonEvents = (events: CopilotEvent[]): CopilotEvent[] => events.filter((e) => e.type !== 'token')

export interface TurnOutcome {
  answer: string | null
  error: string | null
  exit: 0 | 1
}

/** The answer is final.text (tokens can be shed under backpressure). Fail closed: anything but a real answer exits 1. */
export function turnOutcome(events: CopilotEvent[], stopped?: StopReason, conversationId?: string): TurnOutcome {
  const error = events.find((e) => e.type === 'error')
  if (error) {
    const retry = typeof error.retryAfter === 'number' && Number.isFinite(error.retryAfter) ? ` Retry after ${error.retryAfter}s.` : ''
    return {answer: null, error: cleanText(`${str(error.message) ?? `Copilot error (${String(error.code)}).`}${retry}`), exit: 1}
  }

  const final = events.find((e) => e.type === 'final')
  const text = final && str(final.text) ? cleanText(final.text as string) : null
  if (!final && stopped === 'deadline') {
    return {answer: null, error: oneLine(`Still running after ${TURN_DEADLINE_MS / 1000}s: see conversation ${conversationId ?? '?'} in the Zof console.`), exit: 1}
  }

  if (!final || !text) return {answer: null, error: 'No answer from Copilot.', exit: 1}
  if (final.status === 'complete' || final.status === 'no_answer') return {answer: text, error: null, exit: 0}
  return {answer: text, error: cleanText(`Copilot stopped (${String(final.status)}).`), exit: 1}
}

/** The console history shows CLI chats by this title. */
export const conversationTitle = (question: string): string => `CLI: ${[...oneLine(question)].slice(0, 60).join('')}`

export async function startConversation(api: CopilotApi, title: string): Promise<string> {
  const conversation = await api.post<{id?: unknown}>('/api/copilot/conversations', {title})
  const id = str(conversation?.id)
  if (!id) throw new ApiError(0, 'bad_response', 'The console did not start a conversation.')
  return id
}

/** Sends one turn and returns its events and why reading stopped, calling onEvent as each arrives. A non-stream answer gives no events. */
export async function askTurn(
  api: CopilotApi,
  conversationId: string,
  message: string,
  onEvent: (e: CopilotEvent) => void,
): Promise<{events: CopilotEvent[]; stopped: StopReason}> {
  const res = await api.stream('/api/copilot/chat', {conversationId, message, stream: true})
  const events: CopilotEvent[] = []
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream') && res.body) {
    const stopped = await readEvents(res.body, (e) => {
      events.push(e)
      onEvent(e)
    })
    return {events, stopped}
  }

  await res.body?.cancel().catch(() => {})
  return {events, stopped: 'end'}
}

/** An API refusal as one plain sentence, with what to do next (`inChat`: the next message starts a new conversation). */
export function errorHint(e: ApiError, inChat = false): string {
  // The cost guard's 503 says only "This is temporarily unavailable…": name Copilot instead.
  const text = e.statusCode === 503 && e.errorCode === 'unavailable' ? 'Copilot is temporarily unavailable.' : e.message
  const base = /[.!?]$/.test(text) ? text : `${text}.`
  const hint =
    e.errorCode === 'conversation_not_found'
      ? inChat ? ' Your next message starts a new one.' : ' Start a new one: zof copilot chat.'
      : e.errorCode === 'payload_too_large'
        ? ' Shorten the question.'
        : ''
  const retry = e.retryAfterS === undefined ? '' : ` Retry after ${e.retryAfterS}s.`
  return cleanText(`${base}${hint}${retry}`)
}

/** The console's HTTP API through the client (bearer, no Origin, no cookie). */
export const consoleApi = (client: ApiClient): CopilotApi => ({
  post: (path, body) => client.post(path, body),
  stream: (path, body) => client.postStream(path, body),
})
