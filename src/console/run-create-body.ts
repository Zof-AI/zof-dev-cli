/** The triggers POST /api/runs accepts from the CLI (the API's RunTrigger values). */
export const RUN_CREATE_TRIGGERS = ['manual', 'ci', 'scheduled', 'api'] as const
export type RunCreateTrigger = (typeof RUN_CREATE_TRIGGERS)[number]

export interface RunCreateFlags {
  name: string
  trigger: string
  'target-url'?: string
  branch?: string
  environment?: string
}

export interface RunCreateBody {
  title: string
  trigger: string
  branch?: string
  environmentId?: string
  metadata?: {targetUrl: string}
}

/**
 * The POST /api/runs body for `runs create`: only the keys the API accepts (it rejects any other). The run name is
 * the title; the target URL travels in metadata, and only when given.
 */
export function buildRunCreateBody(flags: RunCreateFlags): RunCreateBody {
  const body: RunCreateBody = {title: flags.name, trigger: flags.trigger}
  if (flags.branch !== undefined) body.branch = flags.branch
  if (flags.environment !== undefined) body.environmentId = flags.environment
  if (flags['target-url'] !== undefined) body.metadata = {targetUrl: flags['target-url']}
  return body
}
