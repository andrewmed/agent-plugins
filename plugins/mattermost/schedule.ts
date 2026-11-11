import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export const MAX_STEPS = 10
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }
const INTERVAL_HELP = 'the interval must be a number and a unit (`m`, `h` or `d`), for example `30m`, `2h` or `1d`'

export type Step = { command: string } | { prompt: string }
export type StepKind = 'command' | 'text' | 'refused'
export type Job = { intervalMs: number; steps: Step[] }
export type JobState = { postId: string; editAt: number; nextAt: number; paused: boolean; lastRun?: { at: number; result: string } }

export function parseInterval(text: string): number | undefined {
  const match = /^(\d{1,5})([mhd])$/.exec(text)
  if (!match) return undefined
  return Number(match[1]) * UNIT_MS[match[2]!]! || undefined
}

export function formatInterval(ms: number): string {
  for (const unit of ['d', 'h']) if (ms % UNIT_MS[unit]! === 0) return `${ms / UNIT_MS[unit]!}${unit}`
  return `${ms / UNIT_MS.m!}m`
}

// The result is the job, or the cause that the post is not a correct job.
export function parseJob(message: string, kindOf: (line: string) => StepKind): Job | string {
  const lines = message.trim().split(/\r?\n/)
  const first = /^\/every(?:[ \t]+(\S+)(?:[ \t]+(.*))?)?$/.exec(lines[0]!.trimEnd())
  if (!first) return 'the post must start with `/every <interval>`'
  const intervalMs = parseInterval(first[1] ?? '')
  if (!intervalMs) return INTERVAL_HELP
  const steps: Step[] = []
  let prompt: string[] = []
  const endPrompt = (): void => {
    const text = prompt.join('\n').trim()
    if (text) steps.push({ prompt: text })
    prompt = []
  }
  for (const line of [first[2] ?? '', ...lines.slice(1)]) {
    const command = line.trim()
    const kind = kindOf(command)
    if (kind === 'refused') return `\`${command}\` cannot be a step of a job`
    if (kind === 'command') {
      endPrompt()
      steps.push({ command })
    } else prompt.push(line)
  }
  endPrompt()
  if (!steps.length) return 'the job has no steps'
  if (steps.length > MAX_STEPS) return `the job has ${steps.length} steps, and the maximum is ${MAX_STEPS}`
  return { intervalMs, steps }
}

// Missed runs do not collect: a time in the past moves to one interval after now.
export function nextTime(dueAt: number, intervalMs: number, now: number): number {
  const next = dueAt + intervalMs
  return next > now ? next : now + intervalMs
}

export function readState(path: string): JobState | undefined {
  let state: any
  try {
    state = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof state?.postId !== 'string' || !state.postId || !Number.isFinite(state.nextAt)) return undefined
  const lastRun = state.lastRun
  return {
    postId: state.postId,
    editAt: Number.isFinite(state.editAt) ? state.editAt : 0,
    nextAt: state.nextAt,
    paused: state.paused === true,
    ...(Number.isFinite(lastRun?.at) && typeof lastRun?.result === 'string' ? { lastRun: { at: lastRun.at, result: lastRun.result } } : {}),
  }
}

export function writeState(path: string, state: JobState | undefined): void {
  if (!state) {
    rmSync(path, { force: true })
    return
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}
