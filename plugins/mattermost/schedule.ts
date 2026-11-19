import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'

export const MAX_STEPS = 10
export const MAX_TRIGGERS = 10
export const MAX_TIMES = 48
export const MAX_SCHEDULE_CHARS = 300
export const LATE_MS = 3_600_000
export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }
const DAY_MS = 86_400_000

export type Step = { command: string } | { prompt: string }
export type StepKind = 'command' | 'text' | 'refused'
// text is line 1 of the job post after `/every`. The model of the session reads it.
export type Job = { text: string; steps: Step[] }
// every is a number and a unit, for example 48h. With no days, the times apply to each day.
export type Trigger = { every: string } | { days: string[]; times: string[] }
// text is the text that the model read. due has the next time of each trigger.
export type Schedule = { text: string; zone: string; triggers: Trigger[]; due: number[] }
export type JobState = { postId: string; editAt: number; paused: boolean; lastRun?: { at: number; result: string }; schedule?: Schedule }

export function parseInterval(text: string): number | undefined {
  const match = /^(\d{1,5})([mhd])$/.exec(text)
  if (!match) return undefined
  return Number(match[1]) * UNIT_MS[match[2]!]! || undefined
}

// The result is the job, or the cause that the post is not a correct job.
export function parseJob(message: string, kindOf: (line: string) => StepKind): Job | string {
  const lines = message.trim().split(/\r?\n/)
  const first = /^\/every(?:[ \t]+(.*))?$/.exec(lines[0]!.trimEnd())
  if (!first) return 'the post must start with `/every <schedule>`'
  const text = (first[1] ?? '').trim().replace(/\s+/g, ' ')
  if (!text) return 'line 1 must have the schedule after `/every`, for example `/every day at 14:00 and 20:00`'
  if (text.length > MAX_SCHEDULE_CHARS) return `the schedule on line 1 has ${text.length} characters, and the maximum is ${MAX_SCHEDULE_CHARS}`
  const steps: Step[] = []
  let prompt: string[] = []
  const endPrompt = (): void => {
    const body = prompt.join('\n').trim()
    if (body) steps.push({ prompt: body })
    prompt = []
  }
  for (const line of lines.slice(1)) {
    const command = line.trim()
    const kind = kindOf(command)
    if (kind === 'refused') return `\`${command}\` cannot be a step of a job`
    if (kind === 'command') {
      endPrompt()
      steps.push({ command })
    } else prompt.push(line)
  }
  endPrompt()
  if (!steps.length) return 'the job has no steps. Line 1 is the schedule, and the steps start on line 2'
  if (steps.length > MAX_STEPS) return `the job has ${steps.length} steps, and the maximum is ${MAX_STEPS}`
  return { text, steps }
}

function shown(value: unknown): string {
  return String(JSON.stringify(value)).slice(0, 40)
}

// A model can send null or an empty list for a field that it does not use.
function absent(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value) && !value.length)
}

// The triggers come from the model or from the state file. The result is the triggers in one form, or the cause that they are not correct.
export function normalizeTriggers(input: unknown): Trigger[] | string {
  if (!Array.isArray(input) || !input.length) return '`triggers` must be a list with one trigger or more'
  if (input.length > MAX_TRIGGERS) return `the schedule has ${input.length} triggers, and the maximum is ${MAX_TRIGGERS}`
  const triggers: Trigger[] = []
  for (const item of input) {
    if (!item || typeof item !== 'object') return `a trigger must be an object: ${shown(item)}`
    const { every, days, times } = item as { every?: unknown; days?: unknown; times?: unknown }
    if (!absent(every)) {
      if (!absent(days) || !absent(times)) return 'a trigger has `every` or `times`, not the two'
      if (typeof every !== 'string' || !parseInterval(every)) return `\`every\` must be a number and a unit (m, h or d), for example 30m, 48h or 1d: ${shown(every)}`
      triggers.push({ every })
      continue
    }
    if (!Array.isArray(times) || !times.length) return 'a trigger must have `every` or `times`'
    if (times.length > MAX_TIMES) return `a trigger has ${times.length} times, and the maximum is ${MAX_TIMES}`
    const clock = new Set<string>()
    for (const time of times) {
      const match = typeof time === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(time) : null
      if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return `a time must be HH:MM from 00:00 to 23:59: ${shown(time)}`
      clock.add(`${match[1]!.padStart(2, '0')}:${match[2]}`)
    }
    const week = new Set<number>()
    if (!absent(days) && !Array.isArray(days)) return '`days` must be a list'
    for (const day of Array.isArray(days) ? days : []) {
      const index = DAYS.indexOf(String(day).toLowerCase().slice(0, 3))
      if (typeof day !== 'string' || index < 0) return `a day must be one of ${DAYS.join(', ')}: ${shown(day)}`
      week.add(index)
    }
    triggers.push({ days: [...week].sort().map(index => DAYS[index]!), times: [...clock].sort() })
  }
  return triggers
}

const formats = new Map<string, Intl.DateTimeFormat>()

// The clock of the zone at an instant, as the timestamp that shows the same clock in UTC.
function wall(ms: number, zone: string): number {
  let format = formats.get(zone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formats.set(zone, format)
  }
  const part: Record<string, number> = {}
  for (const { type, value } of format.formatToParts(ms)) part[type] = Number(value)
  return Date.UTC(part.year!, part.month! - 1, part.day, part.hour, part.minute, part.second)
}

export function zoneOk(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone) return false
  try {
    wall(0, zone)
    return true
  } catch {
    return false
  }
}

export function localZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return zoneOk(zone) ? zone : 'UTC'
}

// The time zone of a Mattermost user, if the user has one.
export function userZone(user: any): string | undefined {
  const timezone = user?.timezone
  const zones = String(timezone?.useAutomaticTimezone) === 'true' ? [timezone.automaticTimezone, timezone.manualTimezone] : [timezone?.manualTimezone]
  return zones.find(zoneOk)
}

// The instant at which the zone shows a clock. When the clocks go back, a clock occurs two times: the result is the first one.
// When the clocks go forward, a clock does not occur: the result is that clock moved forward by the jump.
function instant(clock: number, zone: string): number {
  const offset = (at: number): number => wall(at, zone) - at
  const found = [clock - offset(clock - DAY_MS), clock - offset(clock + DAY_MS)]
  const exact = found.filter(at => wall(at, zone) === clock)
  return exact.length ? Math.min(...exact) : found[0]!
}

function nextClock(trigger: { days: string[]; times: string[] }, after: number, zone: string): number {
  const midnight = Math.floor(wall(after, zone) / DAY_MS) * DAY_MS
  for (let day = 0; day <= 8; day++) {
    const date = midnight + day * DAY_MS
    if (trigger.days.length && !trigger.days.includes(DAYS[new Date(date).getUTCDay()]!)) continue
    const times = trigger.times.map(time => instant(date + (Number(time.slice(0, 2)) * 60 + Number(time.slice(3))) * 60_000, zone)).filter(at => at > after)
    if (times.length) return Math.min(...times)
  }
  throw new Error('the trigger has no next time')
}

export function hasClock(triggers: Trigger[]): boolean {
  return triggers.some(trigger => 'times' in trigger)
}

// Missed runs do not collect: a time in the past moves to one interval after now.
export function nextTime(dueAt: number, intervalMs: number, now: number): number {
  const next = dueAt + intervalMs
  return next > now ? next : now + intervalMs
}

export function firstDue(triggers: Trigger[], now: number, zone: string): number[] {
  return triggers.map(trigger => ('every' in trigger ? now + parseInterval(trigger.every)! : nextClock(trigger, now, zone)))
}

// After a change of the time zone, each time of the day gets its next time in the new zone.
export function rezone(schedule: Schedule, now: number, zone: string): number[] {
  return schedule.triggers.map((trigger, i) => ('times' in trigger ? nextClock(trigger, now, zone) : schedule.due[i]!))
}

export function nextAt(schedule: Schedule): number {
  return Math.min(...schedule.due)
}

export function isLate(schedule: Schedule, now: number): boolean {
  return schedule.triggers.some((trigger, i) => 'times' in trigger && now - schedule.due[i]! > LATE_MS)
}

// Gives each due trigger its next time. All due triggers together start one run, and only when ready is true.
// A time of the day that is more than LATE_MS in the past starts no run: skipped has it. An interval has no such limit.
export function settle(schedule: Schedule, now: number, zone: string, ready: boolean): { due: number[]; run: boolean; skipped: number[] } {
  const skipped: number[] = []
  let run = false
  const due = schedule.triggers.map((trigger, i) => {
    let at = schedule.due[i]!
    if (at > now) return at
    if ('every' in trigger) {
      if (!ready) return at
      run = true
      return nextTime(at, parseInterval(trigger.every)!, now)
    }
    if (now - at > LATE_MS) {
      skipped.push(at)
      at = nextClock(trigger, now - LATE_MS, zone)
    }
    if (at > now || !ready) return at
    run = true
    return nextClock(trigger, now, zone)
  })
  return { due, run, skipped }
}

export function timeText(ms: number, zone = 'UTC'): string {
  return `${new Date(wall(ms, zone)).toISOString().slice(0, 16).replace('T', ' ')} ${zone}`
}

export function scheduleText(triggers: Trigger[]): string {
  const name = (day: string): string => day[0]!.toUpperCase() + day.slice(1)
  return triggers.map(trigger => ('every' in trigger ? `each ${trigger.every}` : `${trigger.days.length ? trigger.days.map(name).join(', ') : 'each day'} at ${trigger.times.join(', ')}`)).join('; ')
}

function readSchedule(value: any): Schedule | undefined {
  if (typeof value?.text !== 'string' || !zoneOk(value.zone)) return undefined
  const triggers = normalizeTriggers(value.triggers)
  if (typeof triggers === 'string') return undefined
  if (!Array.isArray(value.due) || value.due.length !== triggers.length || !value.due.every(Number.isFinite)) return undefined
  return { text: value.text, zone: value.zone, triggers, due: value.due }
}

// A state with no correct schedule gets none, and the model reads the job post again.
export function readState(path: string): JobState | undefined {
  let state: any
  try {
    state = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  if (typeof state?.postId !== 'string' || !state.postId) return undefined
  const lastRun = state.lastRun
  const schedule = readSchedule(state.schedule)
  return {
    postId: state.postId,
    editAt: Number.isFinite(state.editAt) ? state.editAt : 0,
    paused: state.paused === true,
    ...(Number.isFinite(lastRun?.at) && typeof lastRun?.result === 'string' ? { lastRun: { at: lastRun.at, result: lastRun.result } } : {}),
    ...(schedule ? { schedule } : {}),
  }
}

export function writeState(path: string, state: object | undefined): void {
  if (!state) {
    rmSync(path, { force: true })
    return
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}
