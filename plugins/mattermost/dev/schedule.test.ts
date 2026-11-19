import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  LATE_MS,
  MAX_SCHEDULE_CHARS,
  MAX_STEPS,
  MAX_TIMES,
  MAX_TRIGGERS,
  firstDue,
  isLate,
  localZone,
  nextAt,
  nextTime,
  normalizeTriggers,
  parseInterval,
  parseJob,
  readState,
  scheduleText,
  settle,
  timeText,
  userZone,
  writeState,
  zoneOk,
  type Schedule,
  type StepKind,
  type Trigger,
} from '../schedule.ts'

const kindOf = (line: string): StepKind => (line === '/clear' || line.startsWith('/compact') ? 'command' : line.startsWith('! ') ? 'refused' : 'text')
const MADRID = 'Europe/Madrid'
const HOUR = 3_600_000
const utc = (text: string): number => Date.parse(`${text}:00Z`)
const daily = (...times: string[]): Trigger => ({ days: [], times })
const next = (trigger: Trigger, after: string, zone = MADRID): string => new Date(firstDue([trigger], utc(after), zone)[0]!).toISOString().slice(0, 16)

describe('parseInterval', () => {
  test('a number and a unit', () => {
    expect(parseInterval('1m')).toBe(60_000)
    expect(parseInterval('30m')).toBe(1_800_000)
    expect(parseInterval('2h')).toBe(7_200_000)
    expect(parseInterval('1d')).toBe(86_400_000)
  })
  test('other text is not an interval', () => {
    for (const text of ['', '0m', '30', 'm', '30s', '1.5h', '-1h', '30 m', '1w', '123456m']) expect(parseInterval(text)).toBeUndefined()
  })
})

describe('parseJob', () => {
  test('line 1 is the schedule and the steps start on line 2', () => {
    expect(parseJob('/every sunday at 14:00, wedn 09am and 21pm and every 48 hours\nExamine the disk space.', kindOf)).toEqual({
      text: 'sunday at 14:00, wedn 09am and 21pm and every 48 hours',
      steps: [{ prompt: 'Examine the disk space.' }],
    })
  })
  test('many lines, with command steps', () => {
    expect(parseJob('/every 2h\n/clear\nExamine the disk space.\nTell me the result.\n/compact keep the result\nThen sleep.', kindOf)).toEqual({
      text: '2h',
      steps: [{ command: '/clear' }, { prompt: 'Examine the disk space.\nTell me the result.' }, { command: '/compact keep the result' }, { prompt: 'Then sleep.' }],
    })
  })
  test('empty lines in a prompt stay, and empty lines around it go', () => {
    expect(parseJob('  /every   1   minute \r\n\r\nFirst part.\r\n\r\nSecond part.\r\n\r\n/clear\n\n', kindOf)).toEqual({
      text: '1 minute',
      steps: [{ prompt: 'First part.\n\nSecond part.' }, { command: '/clear' }],
    })
  })
  test('no schedule on line 1', () => {
    for (const text of ['/every', '/every  \nGo.']) expect(parseJob(text, kindOf)).toContain('line 1 must have the schedule')
    expect(parseJob(`/every ${'x'.repeat(MAX_SCHEDULE_CHARS + 1)}\nGo.`, kindOf)).toContain(`the maximum is ${MAX_SCHEDULE_CHARS}`)
  })
  test('a different first line', () => {
    expect(parseJob('do it /every 30m', kindOf)).toContain('/every <schedule>')
    expect(parseJob('/everyday 30m\nx', kindOf)).toContain('/every <schedule>')
  })
  test('no steps, which includes the old form on one line', () => {
    for (const text of ['/every 30m', '/every 30m\n\n  \n', '/every 30m Examine the disk space.']) expect(parseJob(text, kindOf)).toContain('the job has no steps')
  })
  test('the maximum of steps', () => {
    const steps = (count: number) => Array.from({ length: count }, (_, i) => (i % 2 ? '/clear' : 'Go.')).join('\n')
    expect(parseJob(`/every 1m\n${steps(MAX_STEPS)}`, kindOf)).toHaveProperty('steps')
    expect(parseJob(`/every 1m\n${steps(MAX_STEPS + 1)}`, kindOf)).toContain(`the maximum is ${MAX_STEPS}`)
  })
  test('a refused line gives no job', () => {
    expect(parseJob('/every 1m\n! rm -rf x', kindOf)).toBe('`! rm -rf x` cannot be a step of a job')
  })
})

describe('normalizeTriggers', () => {
  test('an interval and times, in one form', () => {
    expect(normalizeTriggers([{ every: '48h' }, { days: ['Wednesday', 'sun', 'wed'], times: ['21:00', '9:00', '09:00'] }, { times: ['20:00'] }])).toEqual([
      { every: '48h' },
      { days: ['sun', 'wed'], times: ['09:00', '21:00'] },
      { days: [], times: ['20:00'] },
    ])
  })
  test('triggers that are not correct give the cause', () => {
    expect(normalizeTriggers(undefined)).toContain('one trigger or more')
    expect(normalizeTriggers([])).toContain('one trigger or more')
    expect(normalizeTriggers(['48h'])).toContain('must be an object')
    expect(normalizeTriggers([{}])).toContain('`every` or `times`')
    expect(normalizeTriggers([{ every: '48 hours' }])).toContain('a number and a unit')
    expect(normalizeTriggers([{ every: 30 }])).toContain('a number and a unit')
    expect(normalizeTriggers([{ every: '1h', times: ['10:00'] }])).toContain('not the two')
    expect(normalizeTriggers([{ times: [] }])).toContain('`every` or `times`')
    expect(normalizeTriggers([{ every: '1h', days: [], times: null }, { every: null, days: null, times: ['9:00'] }])).toEqual([{ every: '1h' }, { days: [], times: ['09:00'] }])
    for (const time of ['24:00', '9', '09:60', '9am', 900]) expect(normalizeTriggers([{ times: [time] }])).toContain('HH:MM')
    expect(normalizeTriggers([{ days: 'sun', times: ['10:00'] }])).toContain('`days` must be a list')
    expect(normalizeTriggers([{ days: ['someday'], times: ['10:00'] }])).toContain('a day must be one of')
    expect(normalizeTriggers(Array(MAX_TRIGGERS + 1).fill({ every: '1h' }))).toContain(`the maximum is ${MAX_TRIGGERS}`)
    expect(normalizeTriggers([{ times: Array.from({ length: MAX_TIMES + 1 }, (_, i) => `00:${String(i).padStart(2, '0')}`) }])).toContain(`the maximum is ${MAX_TIMES}`)
  })
})

describe('time zone', () => {
  test('zoneOk accepts only a zone that the runtime knows', () => {
    for (const zone of ['UTC', MADRID, 'America/New_York']) expect(zoneOk(zone)).toBe(true)
    for (const zone of ['', 'Mars/Phobos', undefined, 5]) expect(zoneOk(zone)).toBe(false)
    expect(zoneOk(localZone())).toBe(true)
  })
  test('userZone reads the time zone of a Mattermost user', () => {
    expect(userZone({ timezone: { useAutomaticTimezone: 'true', automaticTimezone: MADRID, manualTimezone: 'UTC' } })).toBe(MADRID)
    expect(userZone({ timezone: { useAutomaticTimezone: true, automaticTimezone: '', manualTimezone: 'UTC' } })).toBe('UTC')
    expect(userZone({ timezone: { useAutomaticTimezone: 'false', automaticTimezone: MADRID, manualTimezone: 'UTC' } })).toBe('UTC')
    for (const user of [undefined, {}, { timezone: {} }, { timezone: { useAutomaticTimezone: 'false', manualTimezone: 'Mars/Phobos' } }]) expect(userZone(user)).toBeUndefined()
  })
  test('timeText shows the clock of the zone', () => {
    expect(timeText(utc('2026-01-02T03:34'))).toBe('2026-01-02 03:34 UTC')
    expect(timeText(utc('2026-01-02T23:34'), MADRID)).toBe('2026-01-03 00:34 Europe/Madrid')
    expect(timeText(utc('2026-07-02T03:34'), MADRID)).toBe('2026-07-02 05:34 Europe/Madrid')
  })
})

describe('the next time of a trigger', () => {
  test('an interval starts at now', () => expect(firstDue([{ every: '48h' }], 1000, MADRID)).toEqual([1000 + 48 * HOUR]))
  test('the first time of the day after now, in the zone', () => {
    const trigger = daily('14:00', '15:59', '20:00')
    expect(next(trigger, '2026-11-19T10:00')).toBe('2026-11-19T13:00')
    expect(next(trigger, '2026-11-19T13:00')).toBe('2026-11-19T14:59')
    expect(next(trigger, '2026-11-19T14:59')).toBe('2026-11-19T19:00')
    expect(next(trigger, '2026-11-19T19:00')).toBe('2026-11-20T13:00')
    expect(next(trigger, '2026-11-19T10:00', 'UTC')).toBe('2026-11-19T14:00')
    expect(next(trigger, '2026-11-19T10:00', 'America/New_York')).toBe('2026-11-19T19:00')
  })
  test('a day of the week, in the zone', () => {
    // 2026-11-19 is a Thursday.
    expect(next({ days: ['sun'], times: ['14:00'] }, '2026-11-19T10:00')).toBe('2026-11-22T13:00')
    expect(next({ days: ['wed'], times: ['09:00', '21:00'] }, '2026-11-19T10:00')).toBe('2026-11-25T08:00')
    expect(next({ days: ['thu'], times: ['09:00'] }, '2026-11-19T10:00')).toBe('2026-11-26T08:00')
    expect(next({ days: ['thu', 'fri'], times: ['09:00'] }, '2026-11-19T10:00')).toBe('2026-11-20T08:00')
    // 23:30 UTC on Thursday is 00:30 on Friday in Madrid.
    expect(next({ days: ['fri'], times: ['00:45'] }, '2026-11-19T23:30')).toBe('2026-11-19T23:45')
  })
  test('the clocks go forward: a time that does not occur moves forward by the jump', () => {
    // Madrid, 2026-03-29: 02:00 becomes 03:00 at 01:00 UTC.
    expect(next(daily('02:30'), '2026-03-28T12:00')).toBe('2026-03-29T01:30')
    expect(timeText(utc('2026-03-29T01:30'), MADRID)).toBe('2026-03-29 03:30 Europe/Madrid')
    expect(next(daily('02:30'), '2026-03-29T01:30')).toBe('2026-03-30T00:30')
    expect(next(daily('01:59', '03:00'), '2026-03-28T12:00')).toBe('2026-03-29T00:59')
    expect(next(daily('01:59', '03:00'), '2026-03-29T00:59')).toBe('2026-03-29T01:00')
  })
  test('the clocks go back: a time that occurs two times gives only the first one', () => {
    // Madrid, 2026-10-25: 03:00 becomes 02:00 at 01:00 UTC.
    expect(next(daily('02:30'), '2026-10-24T12:00')).toBe('2026-10-25T00:30')
    expect(next(daily('02:30'), '2026-10-25T00:30')).toBe('2026-10-26T01:30')
    expect(next(daily('02:30'), '2026-10-25T01:15')).toBe('2026-10-26T01:30')
    expect(next(daily('03:00'), '2026-10-25T00:30')).toBe('2026-10-25T02:00')
  })
})

describe('nextTime', () => {
  test('a usual run', () => expect(nextTime(1000, 60_000, 1500)).toBe(61_000))
  test('missed runs do not collect', () => expect(nextTime(1000, 60_000, 500_000)).toBe(560_000))
  test('a next time that is exactly now moves by one interval', () => expect(nextTime(0, 60_000, 60_000)).toBe(120_000))
})

describe('settle', () => {
  const triggers: Trigger[] = [{ every: '48h' }, daily('14:00', '15:59', '20:00'), { days: ['sun'], times: ['14:00'] }]
  const schedule = (due: string[]): Schedule => ({ text: 't', zone: 'UTC', triggers, due: due.map(utc) })
  const times = (due: number[]): string[] => due.map(at => new Date(at).toISOString().slice(0, 16))

  test('nothing is due', () => {
    const state = schedule(['2026-11-20T10:00', '2026-11-19T14:00', '2026-11-22T14:00'])
    expect(nextAt(state)).toBe(utc('2026-11-19T14:00'))
    expect(settle(state, utc('2026-11-19T13:59'), 'UTC', true)).toEqual({ due: state.due, run: false, skipped: [] })
  })
  test('each due trigger gets its next time, and all of them start one run', () => {
    const out = settle(schedule(['2026-11-22T14:00', '2026-11-22T14:00', '2026-11-22T14:00']), utc('2026-11-22T14:00'), 'UTC', true)
    expect(out.run).toBe(true)
    expect(out.skipped).toEqual([])
    expect(times(out.due)).toEqual(['2026-11-24T14:00', '2026-11-22T15:59', '2026-11-29T14:00'])
  })
  test('a session that is not ready keeps the due times', () => {
    const state = schedule(['2026-11-19T10:00', '2026-11-19T14:00', '2026-11-22T14:00'])
    expect(settle(state, utc('2026-11-19T14:30'), 'UTC', false)).toEqual({ due: state.due, run: false, skipped: [] })
    expect(isLate(state, utc('2026-11-19T14:30'))).toBe(false)
  })
  test('a time of the day that is more than 1 hour late starts no run, also when the session is not ready', () => {
    const state = schedule(['2026-11-20T10:00', '2026-11-19T14:00', '2026-11-22T14:00'])
    const now = utc('2026-11-19T14:00') + LATE_MS + 60_000
    expect(isLate(state, now)).toBe(true)
    for (const ready of [true, false]) {
      const out = settle(state, now, 'UTC', ready)
      expect(out.run).toBe(false)
      expect(out.skipped).toEqual([utc('2026-11-19T14:00')])
      expect(times(out.due)).toEqual(['2026-11-20T10:00', '2026-11-19T15:59', '2026-11-22T14:00'])
    }
  })
  test('after a long stop, a time that is less than 1 hour late starts one run', () => {
    const state = schedule(['2026-11-20T10:00', '2026-11-18T14:00', '2026-11-22T14:00'])
    const out = settle(state, utc('2026-11-19T16:10'), 'UTC', true)
    expect(out.run).toBe(true)
    expect(out.skipped).toEqual([utc('2026-11-18T14:00')])
    expect(times(out.due)).toEqual(['2026-11-20T10:00', '2026-11-19T20:00', '2026-11-22T14:00'])
    const busy = settle(state, utc('2026-11-19T16:10'), 'UTC', false)
    expect(busy.run).toBe(false)
    expect(times(busy.due)).toEqual(['2026-11-20T10:00', '2026-11-19T15:59', '2026-11-22T14:00'])
  })
  test('an interval has no limit for a late run, and missed runs do not collect', () => {
    const state = schedule(['2026-11-10T10:00', '2026-11-19T20:00', '2026-11-22T14:00'])
    expect(isLate(state, utc('2026-11-19T12:00'))).toBe(false)
    const out = settle(state, utc('2026-11-19T12:00'), 'UTC', true)
    expect(out.run).toBe(true)
    expect(out.skipped).toEqual([])
    expect(times(out.due)).toEqual(['2026-11-21T12:00', '2026-11-19T20:00', '2026-11-22T14:00'])
  })
})

test('scheduleText shows the triggers', () => {
  expect(scheduleText([{ days: ['sun'], times: ['14:00'] }, { days: ['mon', 'wed'], times: ['09:00', '21:00'] }, daily('20:00'), { every: '48h' }])).toBe(
    'Sun at 14:00; Mon, Wed at 09:00, 21:00; each day at 20:00; each 48h',
  )
})

describe('state file', () => {
  const newPath = () => join(mkdtempSync(join(tmpdir(), 'mm-job-')), 'schedules', 'bot.json')
  const schedule: Schedule = { text: 'day at 14:00 and every 2 days', zone: MADRID, triggers: [daily('14:00'), { every: '2d' }], due: [5000, 6000] }

  test('write, then read', () => {
    const path = newPath()
    const state = { postId: 'p', editAt: 5, paused: true, lastRun: { at: 9, result: 'ok' }, schedule }
    writeState(path, state)
    expect(readState(path)).toEqual(state)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(dirname(path))).toEqual(['bot.json'])
  })
  test('a state with no last run and no schedule', () => {
    const path = newPath()
    writeState(path, { postId: 'p', editAt: 0, paused: false })
    expect(readState(path)).toEqual({ postId: 'p', editAt: 0, paused: false })
  })
  test('no state deletes the file', () => {
    const path = newPath()
    writeState(path, { postId: 'p', editAt: 0, paused: false })
    writeState(path, undefined)
    expect(existsSync(path)).toBe(false)
    expect(readState(path)).toBeUndefined()
  })
  test('a corrupt file gives no job', () => {
    const path = newPath()
    writeState(path, { postId: 'p', editAt: 0, paused: false })
    for (const text of ['', '{', '[]', 'null', '{"postId":7}', '{"editAt":1}', '{"postId":""}']) {
      writeFileSync(path, text)
      expect(readState(path)).toBeUndefined()
    }
  })
  test('fields of an incorrect type get safe values', () => {
    const path = newPath()
    writeState(path, { postId: 'p', editAt: 0, paused: false })
    writeFileSync(path, '{"postId":"p","paused":"yes","editAt":"x","lastRun":{"at":"x"},"schedule":"x"}')
    expect(readState(path)).toEqual({ postId: 'p', editAt: 0, paused: false })
  })
  test('a state file of the old form, and a schedule that is not correct, give a job with no schedule', () => {
    const path = newPath()
    writeState(path, { postId: 'p', editAt: 0, nextAt: 1000, paused: false })
    expect(readState(path)).toEqual({ postId: 'p', editAt: 0, paused: false })
    for (const bad of [{ zone: 'Mars/Phobos' }, { triggers: [{ every: 'soon' }] }, { due: [5000] }, { due: [5000, 'x'] }, { text: 7 }]) {
      writeState(path, { postId: 'p', editAt: 0, paused: false, schedule: { ...schedule, ...bad } })
      expect(readState(path)).toEqual({ postId: 'p', editAt: 0, paused: false })
    }
  })
})
