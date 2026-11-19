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
  rezone,
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
const random = (count: number, from = '00:00', to = '24:00', days: string[] = []): Trigger => ({ days, count, from, to })
// The times of a trigger on one day in UTC. index is the position of the trigger in the schedule.
const timesOf = (trigger: Trigger, day: string, seed = 'p', index = 0): string[] => {
  const triggers = [...Array(index).fill({ every: '1h' }), trigger]
  const out: string[] = []
  for (let at = utc(`${day}T00:00`) - 1; ; ) {
    at = firstDue(triggers, at, 'UTC', seed)[index]!
    const text = new Date(at).toISOString()
    if (text.slice(0, 10) !== day) return out
    out.push(text.slice(11, 16))
  }
}
const next = (trigger: Trigger, after: string, zone = MADRID): string => new Date(firstDue([trigger], utc(after), zone, 'p')[0]!).toISOString().slice(0, 16)

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
    expect(normalizeTriggers([{}])).toContain('`every`, `times` or `count`')
    expect(normalizeTriggers([{ every: '48 hours' }])).toContain('a number and a unit')
    expect(normalizeTriggers([{ every: 30 }])).toContain('a number and a unit')
    expect(normalizeTriggers([{ every: '1h', times: ['10:00'] }])).toContain('only one of')
    expect(normalizeTriggers([{ times: [] }])).toContain('`every`, `times` or `count`')
    expect(normalizeTriggers([{ every: '1h', days: [], times: null }, { every: null, days: null, times: ['9:00'] }])).toEqual([{ every: '1h' }, { days: [], times: ['09:00'] }])
    for (const time of ['24:00', '9', '09:60', '9am', 900]) expect(normalizeTriggers([{ times: [time] }])).toContain('HH:MM')
    expect(normalizeTriggers([{ days: 'sun', times: ['10:00'] }])).toContain('`days` must be a list')
    expect(normalizeTriggers([{ days: ['someday'], times: ['10:00'] }])).toContain('a day must be one of')
    expect(normalizeTriggers(Array(MAX_TRIGGERS + 1).fill({ every: '1h' }))).toContain(`the maximum is ${MAX_TRIGGERS}`)
    expect(normalizeTriggers([{ times: Array.from({ length: MAX_TIMES + 1 }, (_, i) => `00:${String(i).padStart(2, '0')}`) }])).toContain(`the maximum is ${MAX_TIMES}`)
  })
})

describe('normalizeTriggers with a number of random times', () => {
  test('the default window is the full day', () => {
    expect(normalizeTriggers([{ count: 5 }, { count: 1, days: ['wed', 'Mon'], from: '9:00', to: '21:00', times: [] }, { count: 2, from: '23:00', to: '24:00', every: null }])).toEqual([
      { days: [], count: 5, from: '00:00', to: '24:00' },
      { days: ['mon', 'wed'], count: 1, from: '09:00', to: '21:00' },
      { days: [], count: 2, from: '23:00', to: '24:00' },
    ])
  })
  test('a trigger that is not correct gives the cause', () => {
    for (const count of [0, -1, 1.5, '5', MAX_TIMES + 1]) expect(normalizeTriggers([{ count }])).toContain('`count` must be a whole number')
    expect(normalizeTriggers([{ count: 5, times: ['10:00'] }])).toContain('only one of')
    expect(normalizeTriggers([{ every: '1h', count: 5 }])).toContain('only one of')
    expect(normalizeTriggers([{ every: '1h', from: '09:00' }])).toContain('only one of')
    expect(normalizeTriggers([{ times: ['10:00'], to: '21:00' }])).toContain('only to a trigger with `count`')
    for (const from of ['9am', '24:00', 9]) expect(normalizeTriggers([{ count: 5, from }])).toContain('`from` must be HH:MM')
    for (const to of ['24:01', '21', 21]) expect(normalizeTriggers([{ count: 5, to }])).toContain('`to` must be HH:MM')
    expect(normalizeTriggers([{ count: 5, from: '21:00', to: '09:00' }])).toContain('across midnight')
    expect(normalizeTriggers([{ count: 5, from: '09:00', to: '09:00' }])).toContain('across midnight')
    expect(normalizeTriggers([{ count: 5, from: '09:00', to: '09:04' }])).toContain('less than `count`')
    expect(normalizeTriggers([{ count: 5, from: '09:00', to: '09:05' }])).toEqual([random(5, '09:00', '09:05')])
    expect(normalizeTriggers([{ count: 5, days: ['someday'] }])).toContain('a day must be one of')
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
  test('an interval starts at now', () => expect(firstDue([{ every: '48h' }], 1000, MADRID, 'p')).toEqual([1000 + 48 * HOUR]))
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

describe('a number of random times', () => {
  const day = '2026-11-19'

  test('each day has the number of different times, and the same day always has the same times', () => {
    const times = timesOf(random(5), day)
    expect(times).toHaveLength(5)
    expect(new Set(times).size).toBe(5)
    expect(times).toEqual([...times].sort())
    expect(timesOf(random(5), day)).toEqual(times)
  })
  test('a different day, job post or position in the schedule has different times', () => {
    const times = timesOf(random(5), day)
    expect(timesOf(random(5), '2026-11-20')).not.toEqual(times)
    expect(timesOf(random(5), day, 'q')).not.toEqual(times)
    expect(timesOf(random(5), day, 'p', 1)).not.toEqual(times)
  })
  test('all the times are in the window', () => {
    const minutes = Array.from({ length: MAX_TIMES }, (_, i) => `09:${String(i).padStart(2, '0')}`)
    expect(timesOf(random(MAX_TIMES, '09:00', '09:48'), day)).toEqual(minutes)
    for (const time of timesOf(random(20, '23:00', '24:00'), day)) expect(time.slice(0, 2)).toBe('23')
    for (const time of timesOf(random(20, '09:00', '21:00'), day)) expect(time >= '09:00' && time < '21:00').toBe(true)
  })
  test('the times are spread across the window', () => {
    const hours = new Set<string>()
    for (let date = 1; date <= 30; date++) for (const time of timesOf(random(MAX_TIMES), `2026-11-${String(date).padStart(2, '0')}`)) hours.add(time.slice(0, 2))
    expect(hours.size).toBe(24)
  })
  test('the first time is the next time of the day after now, and then the first one of the next day', () => {
    const times = timesOf(random(5), day)
    expect(next(random(5), `${day}T${times[2]}`, 'UTC')).toBe(`${day}T${times[3]}`)
    expect(next(random(5), `${day}T${times[4]}`, 'UTC')).toBe(`2026-11-20T${timesOf(random(5), '2026-11-20')[0]}`)
  })
  test('the days of the week limit the trigger', () => {
    // 2026-11-19 is a Thursday.
    const trigger = random(3, '00:00', '24:00', ['sun'])
    expect(timesOf(trigger, day)).toEqual([])
    expect(next(trigger, `${day}T10:00`, 'UTC')).toBe(`2026-11-22T${timesOf(trigger, '2026-11-22')[0]}`)
  })
  test('the times are in the zone, and a time that does not occur moves forward by the jump', () => {
    // 09:00 to 10:00 in Madrid is 08:00 to 09:00 UTC in the winter.
    expect(next(random(1, '09:00', '10:00'), '2026-11-19T00:00').slice(0, 13)).toBe('2026-11-19T08')
    // Madrid, 2026-03-29: 02:00 becomes 03:00 at 01:00 UTC.
    const trigger = random(10, '02:00', '03:00')
    let at = utc('2026-03-28T23:00')
    for (let i = 0; i < 10; i++) {
      at = firstDue([trigger], at, MADRID, 'p')[0]!
      expect(timeText(at, MADRID).slice(0, 13)).toBe('2026-03-29 03')
    }
  })
  test('settle gives the next random time, and a time that is more than 1 hour late starts no run', () => {
    const times = timesOf(random(5), day)
    const at = (time: string): number => utc(`${day}T${time}`)
    const state: Schedule = { text: 't', zone: 'UTC', triggers: [random(5)], due: [at(times[0]!)] }
    expect(settle(state, at(times[0]!), 'UTC', true, 'p')).toEqual({ due: [at(times[1]!)], run: true, skipped: [] })
    const late = at(times[4]!) + LATE_MS + 60_000
    expect(isLate(state, late)).toBe(true)
    const out = settle(state, late, 'UTC', true, 'p')
    expect(out.skipped).toEqual([at(times[0]!)])
    expect(out.run).toBe(false)
    expect(out.due[0]).toBeGreaterThan(late)
  })
  test('a change of the time zone gives the next random time in the new zone', () => {
    const trigger = random(1, '09:00', '10:00')
    const state: Schedule = { text: 't', zone: 'UTC', triggers: [trigger, { every: '1h' }], due: firstDue([trigger, { every: '1h' }], utc('2026-11-19T00:00'), 'UTC', 'p') }
    const moved = rezone(state, utc('2026-11-19T00:00'), 'Asia/Tokyo', 'p')
    // 09:00 to 10:00 in Tokyo is 00:00 to 01:00 UTC.
    expect(new Date(moved[0]!).toISOString().slice(0, 13)).toBe('2026-11-19T00')
    expect(moved[1]).toBe(state.due[1]!)
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
    expect(settle(state, utc('2026-11-19T13:59'), 'UTC', true, 'p')).toEqual({ due: state.due, run: false, skipped: [] })
  })
  test('each due trigger gets its next time, and all of them start one run', () => {
    const out = settle(schedule(['2026-11-22T14:00', '2026-11-22T14:00', '2026-11-22T14:00']), utc('2026-11-22T14:00'), 'UTC', true, 'p')
    expect(out.run).toBe(true)
    expect(out.skipped).toEqual([])
    expect(times(out.due)).toEqual(['2026-11-24T14:00', '2026-11-22T15:59', '2026-11-29T14:00'])
  })
  test('a session that is not ready keeps the due times', () => {
    const state = schedule(['2026-11-19T10:00', '2026-11-19T14:00', '2026-11-22T14:00'])
    expect(settle(state, utc('2026-11-19T14:30'), 'UTC', false, 'p')).toEqual({ due: state.due, run: false, skipped: [] })
    expect(isLate(state, utc('2026-11-19T14:30'))).toBe(false)
  })
  test('a time of the day that is more than 1 hour late starts no run, also when the session is not ready', () => {
    const state = schedule(['2026-11-20T10:00', '2026-11-19T14:00', '2026-11-22T14:00'])
    const now = utc('2026-11-19T14:00') + LATE_MS + 60_000
    expect(isLate(state, now)).toBe(true)
    for (const ready of [true, false]) {
      const out = settle(state, now, 'UTC', ready, 'p')
      expect(out.run).toBe(false)
      expect(out.skipped).toEqual([utc('2026-11-19T14:00')])
      expect(times(out.due)).toEqual(['2026-11-20T10:00', '2026-11-19T15:59', '2026-11-22T14:00'])
    }
  })
  test('after a long stop, a time that is less than 1 hour late starts one run', () => {
    const state = schedule(['2026-11-20T10:00', '2026-11-18T14:00', '2026-11-22T14:00'])
    const out = settle(state, utc('2026-11-19T16:10'), 'UTC', true, 'p')
    expect(out.run).toBe(true)
    expect(out.skipped).toEqual([utc('2026-11-18T14:00')])
    expect(times(out.due)).toEqual(['2026-11-20T10:00', '2026-11-19T20:00', '2026-11-22T14:00'])
    const busy = settle(state, utc('2026-11-19T16:10'), 'UTC', false, 'p')
    expect(busy.run).toBe(false)
    expect(times(busy.due)).toEqual(['2026-11-20T10:00', '2026-11-19T15:59', '2026-11-22T14:00'])
  })
  test('an interval has no limit for a late run, and missed runs do not collect', () => {
    const state = schedule(['2026-11-10T10:00', '2026-11-19T20:00', '2026-11-22T14:00'])
    expect(isLate(state, utc('2026-11-19T12:00'))).toBe(false)
    const out = settle(state, utc('2026-11-19T12:00'), 'UTC', true, 'p')
    expect(out.run).toBe(true)
    expect(out.skipped).toEqual([])
    expect(times(out.due)).toEqual(['2026-11-21T12:00', '2026-11-19T20:00', '2026-11-22T14:00'])
  })
})

test('scheduleText shows the triggers', () => {
  expect(scheduleText([{ days: ['sun'], times: ['14:00'] }, { days: ['mon', 'wed'], times: ['09:00', '21:00'] }, daily('20:00'), { every: '48h' }])).toBe(
    'Sun at 14:00; Mon, Wed at 09:00, 21:00; each day at 20:00; each 48h',
  )
  expect(scheduleText([random(5), random(1, '09:00', '10:00', ['mon'])])).toBe('each day at 5 random times from 00:00 to 24:00; Mon at 1 random time from 09:00 to 10:00')
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
  test('a schedule with a number of random times', () => {
    const path = newPath()
    const state = { postId: 'p', editAt: 0, paused: false, schedule: { text: '5 times a day', zone: MADRID, triggers: [random(5, '09:00', '24:00', ['mon'])], due: [5000] } }
    writeState(path, state)
    expect(readState(path)).toEqual(state)
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
