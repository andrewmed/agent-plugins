import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { MAX_STEPS, formatInterval, nextTime, parseInterval, parseJob, readState, writeState, type StepKind } from '../schedule.ts'

const kindOf = (line: string): StepKind => (line === '/clear' || line.startsWith('/compact') ? 'command' : line.startsWith('! ') ? 'refused' : 'text')

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
  test('formatInterval uses the largest unit that fits', () => {
    expect(formatInterval(1_800_000)).toBe('30m')
    expect(formatInterval(7_200_000)).toBe('2h')
    expect(formatInterval(5_400_000)).toBe('90m')
    expect(formatInterval(172_800_000)).toBe('2d')
  })
})

describe('parseJob', () => {
  test('one line', () => {
    expect(parseJob('/every 30m Examine the disk space.', kindOf)).toEqual({ intervalMs: 1_800_000, steps: [{ prompt: 'Examine the disk space.' }] })
  })
  test('many lines, with command steps', () => {
    expect(parseJob('/every 2h\n/clear\nExamine the disk space.\nTell me the result.\n/compact keep the result\nThen sleep.', kindOf)).toEqual({
      intervalMs: 7_200_000,
      steps: [{ command: '/clear' }, { prompt: 'Examine the disk space.\nTell me the result.' }, { command: '/compact keep the result' }, { prompt: 'Then sleep.' }],
    })
  })
  test('a command on the first line', () => {
    expect(parseJob('/every 1d /clear\nGo.', kindOf)).toEqual({ intervalMs: 86_400_000, steps: [{ command: '/clear' }, { prompt: 'Go.' }] })
  })
  test('empty lines in a prompt stay, and empty lines around it go', () => {
    expect(parseJob('  /every 1m\r\n\r\nFirst part.\r\n\r\nSecond part.\r\n\r\n/clear\n\n', kindOf)).toEqual({
      intervalMs: 60_000,
      steps: [{ prompt: 'First part.\n\nSecond part.' }, { command: '/clear' }],
    })
  })
  test('an incorrect interval', () => {
    for (const text of ['/every', '/every soon do it', '/every 0m do it', '/every 30s do it']) expect(parseJob(text, kindOf)).toContain('interval')
  })
  test('a different first line', () => {
    expect(parseJob('do it /every 30m', kindOf)).toContain('/every <interval>')
    expect(parseJob('/everyday 30m x', kindOf)).toContain('/every <interval>')
  })
  test('no steps', () => {
    expect(parseJob('/every 30m', kindOf)).toBe('the job has no steps')
    expect(parseJob('/every 30m\n\n  \n', kindOf)).toBe('the job has no steps')
  })
  test('the maximum of steps', () => {
    const steps = (count: number) => Array.from({ length: count }, (_, i) => (i % 2 ? '/clear' : 'Go.')).join('\n')
    expect(parseJob(`/every 1m\n${steps(MAX_STEPS)}`, kindOf)).toHaveProperty('steps')
    expect(parseJob(`/every 1m\n${steps(MAX_STEPS + 1)}`, kindOf)).toContain(`the maximum is ${MAX_STEPS}`)
  })
  test('a refused line gives no job', () => {
    expect(parseJob('/every 1m\n! rm -rf x', kindOf)).toBe('`! rm -rf x` cannot be a step of a job')
    expect(parseJob('/every 1m ! ls', kindOf)).toBe('`! ls` cannot be a step of a job')
  })
})

describe('nextTime', () => {
  test('a usual run', () => expect(nextTime(1000, 60_000, 1500)).toBe(61_000))
  test('missed runs do not collect', () => expect(nextTime(1000, 60_000, 500_000)).toBe(560_000))
  test('a next time that is exactly now moves by one interval', () => expect(nextTime(0, 60_000, 60_000)).toBe(120_000))
})

describe('state file', () => {
  const newPath = () => join(mkdtempSync(join(tmpdir(), 'mm-job-')), 'schedules', 'bot.json')

  test('write, then read', () => {
    const path = newPath()
    const state = { postId: 'p', editAt: 5, nextAt: 1000, paused: true, lastRun: { at: 9, result: 'ok' } }
    writeState(path, state)
    expect(readState(path)).toEqual(state)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(dirname(path))).toEqual(['bot.json'])
  })
  test('a state with no last run', () => {
    const path = newPath()
    writeState(path, { postId: 'p', editAt: 0, nextAt: 1, paused: false })
    expect(readState(path)).toEqual({ postId: 'p', editAt: 0, nextAt: 1, paused: false })
  })
  test('no state deletes the file', () => {
    const path = newPath()
    writeState(path, { postId: 'p', editAt: 0, nextAt: 1, paused: false })
    writeState(path, undefined)
    expect(existsSync(path)).toBe(false)
    expect(readState(path)).toBeUndefined()
  })
  test('a corrupt file gives no job', () => {
    const path = newPath()
    writeState(path, { postId: 'p', editAt: 0, nextAt: 1, paused: false })
    for (const text of ['', '{', '[]', 'null', '{"postId":7,"nextAt":1}', '{"postId":"p"}', '{"postId":"","nextAt":1}']) {
      writeFileSync(path, text)
      expect(readState(path)).toBeUndefined()
    }
  })
  test('fields of an incorrect type get safe values', () => {
    const path = newPath()
    writeState(path, { postId: 'p', editAt: 0, nextAt: 1, paused: false })
    writeFileSync(path, '{"postId":"p","nextAt":7,"paused":"yes","editAt":"x","lastRun":{"at":"x"}}')
    expect(readState(path)).toEqual({ postId: 'p', editAt: 0, nextAt: 7, paused: false })
  })
})
