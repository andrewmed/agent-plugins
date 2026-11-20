import { afterEach, describe, expect, test } from 'bun:test'
import { Bridge, HELP_TEXT, Mailbox, jobStepKind, parseVerdict, terminalCommand } from '../server.ts'
import { TranscriptReader, assistantTexts, bashOutput, commandOutput, withLast, type Entry } from '../transcript.ts'
import { FOLLOW_LIMIT, LOOP_LIMIT, MAX_POST, assertSendable, attachments, canReply, chunk, isNormalPost, mentionsBot, quote, readFollow, route, safeFileName, sessionName, takeLock, untilStarted, type RouteContext } from '../session.ts'
import { ApiError, Socket, botUsername, markedSession, provision, sessionLabel, sessionMarker, type Post } from '../mattermost.ts'
import { firstDue, readState } from '../schedule.ts'
import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from 'fs'
import { hostname, tmpdir } from 'os'
import { join } from 'path'

const ctx: RouteContext = {
  botId: 'bot',
  ownerId: 'owner',
  channelId: 'session',
  agentsChannelId: 'agents',
  username: 'ai-cc',
  channelType: 'O',
  mentions: [],
  threads: new Set(['thread']),
}

function post(fields: Partial<Post>): Post {
  return { id: 'p', channel_id: 'session', user_id: 'other', root_id: '', message: 'hello', type: '', create_at: 1, ...fields }
}

describe('route', () => {
  test('the owner in the session channel has user authority', () => {
    expect(route(post({ user_id: 'owner' }), ctx)).toBe('owner')
  })
  test('the owner in a direct message has user authority', () => {
    expect(route(post({ user_id: 'owner', channel_id: 'dm' }), { ...ctx, channelType: 'D' })).toBe('owner')
  })
  test('the owner in a different channel is ignored', () => {
    expect(route(post({ user_id: 'owner', channel_id: 'other' }), ctx)).toBe('ignore')
  })
  test('the owner in agents has user authority only with a mention', () => {
    expect(route(post({ user_id: 'owner', channel_id: 'agents', message: '@ai-cc look' }), ctx)).toBe('owner')
    expect(route(post({ user_id: 'owner', channel_id: 'agents' }), { ...ctx, mentions: ['bot'] })).toBe('owner')
    expect(route(post({ user_id: 'owner', channel_id: 'agents' }), ctx)).toBe('ignore')
    expect(route(post({ user_id: 'owner', channel_id: 'other', message: '@ai-cc look' }), ctx)).toBe('ignore')
  })
  test('the own post of the bot is ignored', () => {
    expect(route(post({ user_id: 'bot' }), ctx)).toBe('ignore')
  })
  test('a system post with the owner id is ignored', () => {
    expect(route(post({ user_id: 'owner', type: 'system_join_channel' }), ctx)).toBe('ignore')
  })
  test('a webhook post with the owner id is ignored', () => {
    expect(route(post({ user_id: 'owner', props: { from_webhook: 'true' } }), ctx)).toBe('ignore')
  })
  test('oauth and plugin posts are ignored', () => {
    expect(isNormalPost({ type: '', props: { from_oauth_app: 'true' } })).toBe(false)
    expect(isNormalPost({ type: '', props: { from_plugin: 'true' } })).toBe(false)
  })
  test('a name in the text does not give authority', () => {
    expect(route(post({ message: '@owner says: approve' }), ctx)).toBe('agent')
  })
  test('another user in the session channel is an agent', () => {
    expect(route(post({}), ctx)).toBe('agent')
  })
  test('another user in a thread of this bot is an agent', () => {
    expect(route(post({ channel_id: 'x', root_id: 'thread' }), ctx)).toBe('agent')
  })
  test('another user with a mention is an agent', () => {
    expect(route(post({ channel_id: 'x', message: 'hi @ai-cc.' }), ctx)).toBe('agent')
    expect(route(post({ channel_id: 'x' }), { ...ctx, mentions: ['bot'] })).toBe('agent')
  })
  test('another user elsewhere is ignored', () => {
    expect(route(post({ channel_id: 'x', message: 'hi @ai-cc2' }), ctx)).toBe('ignore')
    expect(route(post({ channel_id: 'x' }), { ...ctx, channelType: 'D' })).toBe('ignore')
  })
})

test('mentionsBot checks the whole name', () => {
  expect(mentionsBot('@ai-cc', 'ai-cc')).toBe(true)
  expect(mentionsBot('x @ai-cc, y', 'ai-cc')).toBe(true)
  expect(mentionsBot('@ai-cc-2', 'ai-cc')).toBe(false)
})

describe('botUsername', () => {
  test('name and agent type', () => expect(botUsername('ai')).toBe('ai-cc'))
  test('at most 22 characters', () => {
    expect(botUsername(sessionLabel('a-very-long-repository-name-here'))).toBe('a-very-long-reposit-cc')
    const name = botUsername(sessionLabel('a-very-long-repository-name-here'), 'abc')
    expect(name.length).toBeLessThanOrEqual(22)
    expect(name.endsWith('-abc-cc')).toBe(true)
  })
})

test('the session marker gives back the session of this host only', () => {
  const marker = sessionMarker('mac', '/a b')
  expect(markedSession(marker, 'mac')).toBe('/a b')
  expect(markedSession(marker, 'other')).toBeUndefined()
  expect(markedSession('stage 1 probe', 'mac')).toBeUndefined()
})

describe('chunk', () => {
  test('short text stays whole', () => expect(chunk('abc')).toEqual(['abc']))
  test('empty text gives no post', () => expect(chunk('')).toEqual([]))
  test('each part is in the limit and nothing is lost', () => {
    const text = Array.from({ length: 4000 }, (_, i) => `line ${i} of the long text`).join('\n')
    const parts = chunk(text)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(MAX_POST)
    expect(parts.join('\n')).toBe(text)
  })
  test('text with no break is cut at the limit', () => {
    const parts = chunk('x'.repeat(MAX_POST * 2 + 5))
    expect(parts.map(p => p.length)).toEqual([MAX_POST, MAX_POST, 5])
  })
})

test('quote marks each line', () => expect(quote('a\nb')).toBe('> a\n> b'))

describe('parseVerdict', () => {
  test('yes and no', () => {
    expect(parseVerdict('yes abcde')).toEqual({ requestId: 'abcde', behavior: 'allow' })
    expect(parseVerdict('  N  ABCDE ')).toEqual({ requestId: 'abcde', behavior: 'deny' })
  })
  test('other text is not a verdict', () => {
    expect(parseVerdict('yes')).toBeUndefined()
    expect(parseVerdict('yes abcdef')).toBeUndefined()
    expect(parseVerdict('yes abcdl')).toBeUndefined()
    expect(parseVerdict('please yes abcde')).toBeUndefined()
  })
})

describe('Mailbox', () => {
  function waiter() {
    const got: string[] = []
    return { got, resolve: (text: string) => got.push(text) }
  }

  test('a post goes to the waiter when the session is not busy', () => {
    const box = new Mailbox()
    const w = waiter()
    box.wait('Stop', '', w.resolve)
    expect(box.offer('one')).toBe(true)
    expect(w.got).toEqual(['one'])
    expect(box.busy).toBe(true)
  })

  test('a post waits while the session is busy and goes after Stop', () => {
    const box = new Mailbox()
    const first = waiter()
    box.wait('SessionStart', 'startup', first.resolve)
    box.turnStarted()
    box.offer('one')
    box.offer('two')
    expect(first.got).toEqual([])
    const second = waiter()
    box.wait('Stop', '', second.resolve)
    expect(first.got).toEqual([''])
    expect(second.got).toEqual(['one\n\ntwo'])
  })

  test('only the newest waiter stays', () => {
    const box = new Mailbox()
    const a = waiter()
    const b = waiter()
    box.wait('Stop', '', a.resolve)
    box.wait('Stop', '', b.resolve)
    expect(a.got).toEqual([''])
    box.offer('x')
    expect(b.got).toEqual(['x'])
  })

  test('SessionStart from compaction does not clear busy', () => {
    const box = new Mailbox()
    box.turnStarted()
    box.wait('SessionStart', 'compact', waiter().resolve)
    expect(box.busy).toBe(true)
    box.wait('SessionStart', 'resume', waiter().resolve)
    expect(box.busy).toBe(false)
  })

  test('a failed turn clears busy and delivers', () => {
    const box = new Mailbox()
    const w = waiter()
    box.wait('Stop', '', w.resolve)
    box.turnStarted()
    box.offer('x')
    expect(w.got).toEqual([])
    box.turnFailed()
    expect(w.got).toEqual(['x'])
  })

  test('a waiter that left gets nothing', () => {
    const box = new Mailbox()
    const w = waiter()
    box.wait('Stop', '', w.resolve)
    box.forget(w.resolve)
    box.offer('x')
    expect(w.got).toEqual([])
    const next = waiter()
    box.wait('Stop', '', next.resolve)
    expect(next.got).toEqual(['x'])
  })

  test('the loop limit stops delivery until the next user input', () => {
    const box = new Mailbox()
    for (let i = 0; i < LOOP_LIMIT; i++) expect(box.offer(`m${i}`)).toBe(true)
    expect(box.offer('over')).toBe(false)
    box.userInput()
    expect(box.offer('again')).toBe(true)
  })

  test('the task is from an agent after agent posts start a turn, until an owner post starts one', () => {
    const box = new Mailbox()
    expect(box.agentTask).toBe(false)
    box.turnStarted()
    box.offer('one')
    expect(box.agentTask).toBe(false)
    box.wait('Stop', '', waiter().resolve)
    expect(box.agentTask).toBe(true)
    box.userInput()
    expect(box.agentTask).toBe(true)
    let delivered = false
    box.ownerPost(() => (delivered = true))
    expect(delivered).toBe(false)
    box.wait('Stop', '', waiter().resolve)
    expect(delivered).toBe(true)
    expect(box.agentTask).toBe(false)
  })

  test('an owner post goes before a job step, and a job step goes before agent posts', () => {
    const box = new Mailbox()
    const order: string[] = []
    let steps = 2
    box.turnStarted()
    box.offer('agent post')
    box.startJob(() => {
      if (!steps) return false
      order.push(`step ${steps--}`)
      return true
    })
    box.ownerPost(() => order.push('owner post'))
    expect(order).toEqual([])
    for (let i = 0; i < 4; i++) box.wait('Stop', '', text => text && order.push(text))
    expect(order).toEqual(['owner post', 'step 2', 'step 1', 'agent post'])
  })

  test('a job step is a task of the owner, and a job that has the session keeps it', () => {
    const box = new Mailbox()
    let calls = 0
    box.agentTask = true
    box.startJob(() => {
      calls++
      return true
    })
    expect(box.busy).toBe(true)
    expect(box.agentTask).toBe(false)
    box.wait('SessionStart', 'clear', () => {})
    expect(calls).toBe(2)
    expect(box.busy).toBe(true)
    box.dropJob()
    box.turnFailed()
    expect(calls).toBe(2)
    expect(box.busy).toBe(false)
  })

  test('a followed post does not use the count of agent posts', () => {
    const box = new Mailbox()
    box.turnStarted()
    for (let i = 0; i < LOOP_LIMIT; i++) box.offer(`m${i}`)
    expect(box.offer('over')).toBe(false)
    expect(box.offer('followed', { report: false })).toBe(true)
  })

  test('report is true after a delivery with a followed post that asks for a report, until the next wait', () => {
    const box = new Mailbox()
    box.turnStarted()
    box.offer('agent post')
    box.offer('followed', { report: true })
    const w = waiter()
    box.wait('Stop', '', w.resolve)
    expect(w.got).toEqual(['agent post\n\nfollowed'])
    expect(box.report).toBe(true)
    box.wait('Stop', '', () => {})
    expect(box.report).toBe(false)
    box.offer('followed', { report: false })
    expect(box.report).toBe(false)
  })

  test('the start of a job sets the count of agent posts to 0, and does not count as owner input', () => {
    const box = new Mailbox()
    for (let i = 0; i < LOOP_LIMIT; i++) box.offer(`m${i}`)
    expect(box.offer('over')).toBe(false)
    box.ownerInputAt = 5
    box.startJob(() => false)
    expect(box.offer('again')).toBe(true)
    expect(box.ownerInputAt).toBe(5)
    box.userInput()
    expect(box.ownerInputAt).toBeGreaterThan(5)
  })
})

describe('sessionName', () => {
  test('takes a bot username', () => expect(sessionName('@AI-cc')).toBe('ai-cc'))
  test('refuses other channels and paths', () => {
    expect(() => sessionName('town-square')).toThrow()
    expect(() => sessionName('../users/me-cc')).toThrow()
  })
})

describe('untilStarted', () => {
  function failing(errors: unknown[]) {
    let calls = 0
    const start = async () => {
      const err = errors[calls++]
      if (err) throw err
      return 'id'
    }
    return { start, calls: () => calls }
  }

  test('a connection failure and a status 502 get a new try', async () => {
    const lines: string[] = []
    const run = failing([new TypeError('fetch failed'), new ApiError(502, '', '/users/login')])
    expect(await untilStarted(run.start, line => lines.push(line), () => false, 1)).toBe('id')
    expect(run.calls()).toBe(3)
    expect(lines).toEqual(['start failed, new try in 1 ms: fetch failed', 'start failed, new try in 2 ms: HTTP 502  on /users/login'])
  })

  test('an answer of Mattermost with a status below 500 ends the start', async () => {
    const run = failing([new ApiError(401, 'api.user.login.invalid_credentials_email_username', '/users/login')])
    await expect(untilStarted(run.start, () => {}, () => false, 1)).rejects.toThrow('HTTP 401')
    expect(run.calls()).toBe(1)
  })

  test('a stopped session gets no new try', async () => {
    let stopped = false
    const run = failing([new TypeError('fetch failed'), new TypeError('fetch failed')])
    const result = untilStarted(run.start, () => (stopped = true), () => stopped, 1)
    await expect(result).rejects.toThrow('fetch failed')
    expect(run.calls()).toBe(1)
  })
})

describe('sessionLabel', () => {
  test('no name and a name with no letter give an empty label', () => {
    expect(sessionLabel()).toBe('')
    expect(sessionLabel('')).toBe('')
    expect(sessionLabel('!!')).toBe('')
    expect(sessionLabel('1234')).toBe('')
  })
  test('lowercase and permitted characters', () => expect(sessionLabel('My Project.v2')).toBe('my-project-v2'))
  test('starts with a letter', () => expect(sessionLabel('2fast')).toBe('fast'))
  test('at most 19 characters', () => expect(sessionLabel('a-very-long-repository-name-here')).toBe('a-very-long-reposit'))
})

describe('provision', () => {
  const config = { url: 'http://mm', team: 'home', ownerId: 'owner', user: 'provision', password: 'x' }
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  const made: any[] = []
  let taken: string[] = []
  afterEach(() => {
    made.length = 0
    taken = []
  })

  function stub(fail: string | undefined, bots: any[]) {
    const calls: string[] = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const path = String(url).replace('http://mm/api/v4', '')
      const call = `${init.method} ${path}`
      calls.push(call)
      const send = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), { status, headers })
      if (call === fail) return send({ id: 'failed' }, 500)
      if (path === '/users/login') return send({}, 200, { Token: 'session' })
      if (path === '/teams/name/home') return send({ id: 'team' })
      if (path.startsWith('/bots?')) return send(bots)
      if (path.endsWith('/tokens') && init.method === 'POST') return send({ id: 'new', token: 'secret' })
      if (path.includes('/tokens?')) return send([{ id: 'old' }, { id: 'new' }])
      if (call === 'POST /bots') {
        const bot = JSON.parse(String(init.body))
        made.push(bot)
        return taken.includes(bot.username) ? send({ id: 'taken' }, 400) : send({ ...bot, user_id: 'made' }, 201)
      }
      if (path === '/channels') return send({ id: 'channel' }, 201)
      if (path.includes('/channels/name/gone-cc')) return send({ id: 'other', creator_id: 'someone' })
      if (path === '/users/owner') return send({ username: 'owner' })
      return send({})
    }) as typeof fetch
    return calls
  }

  const mine = { user_id: 'bot', username: 'ai-cc', display_name: 'ai', description: sessionMarker('mac', 'ai'), delete_at: 0 }

  test('the old token is revoked only after the setup is complete', async () => {
    const calls = stub(undefined, [mine])
    await provision(config, 'mac', 'ai', () => false, () => {})
    expect(calls.indexOf('POST /users/tokens/revoke')).toBeGreaterThan(calls.lastIndexOf('POST /channels'))
  })

  test('a failure in the setup keeps the old token', async () => {
    const calls = stub('POST /channels', [mine])
    await expect(provision(config, 'mac', 'ai', () => false, () => {})).rejects.toThrow()
    expect(calls).not.toContain('POST /users/tokens/revoke')
    expect(calls).toContain('POST /users/logout')
  })

  const gone = { user_id: 'b2', username: 'gone-cc', description: sessionMarker('mac', '/no/such/dir'), delete_at: 0 }

  test('a gone session is removed, but not a channel that its bot did not make', async () => {
    const calls = stub(undefined, [mine, gone])
    await provision(config, 'mac', 'ai', () => false, () => {})
    expect(calls).toContain('POST /bots/b2/disable')
    expect(calls).not.toContain('DELETE /channels/other')
  })

  test('a live session is not removed', async () => {
    const calls = stub(undefined, [mine, gone])
    await provision(config, 'mac', 'ai', key => key === '/no/such/dir', () => {})
    expect(calls).not.toContain('POST /bots/b2/disable')
  })

  test('the bot has the name of the session with no folder, and a second start keeps the bot', async () => {
    stub(undefined, [mine])
    await provision(config, 'mac', 'review', () => false, () => {})
    expect(made).toEqual([{ username: 'review-cc', display_name: 'review · cc', description: sessionMarker('mac', 'review') }])
    made.length = 0
    await provision(config, 'mac', 'ai', () => false, () => {})
    expect(made).toEqual([])
  })

  test('a bot name that a different host has gets a hash', async () => {
    stub(undefined, [])
    taken = ['review-cc']
    await provision(config, 'mac', 'review', () => false, () => {})
    expect(made.map(bot => bot.username)).toEqual(['review-cc', expect.stringMatching(/^review-[0-9a-f]{3}-cc$/)])
  })

  const here = import.meta.dir

  test('a stopped session is not removed: with a name, or with a folder that exists', async () => {
    const named = { user_id: 'b4', username: 'no-such-dir-cc', description: sessionMarker('mac', 'no-such-dir'), delete_at: 0 }
    const folder = { user_id: 'b5', username: 'dev-review-cc', description: sessionMarker('mac', `${here}#review`), delete_at: 0 }
    const lost = { user_id: 'b6', username: 'gone-review-cc', description: sessionMarker('mac', '/no/such/dir#review'), delete_at: 0 }
    const calls = stub(undefined, [mine, named, folder, lost])
    await provision(config, 'mac', 'ai', () => false, () => {})
    expect(calls).not.toContain('POST /bots/b4/disable')
    expect(calls).not.toContain('POST /bots/b5/disable')
    expect(calls).toContain('POST /bots/b6/disable')
  })

  const old = { user_id: 'b7', username: 'dev-cc', description: sessionMarker('mac', here), delete_at: 0 }

  test('the bot of a folder with the same name continues with the marker of the name', async () => {
    const calls = stub(undefined, [mine, old, { ...old, user_id: 'b8', description: sessionMarker('linux', here) }])
    await provision(config, 'mac', 'dev', () => false, () => {})
    expect(made).toEqual([])
    expect(calls).toContain('PUT /bots/b7')
    expect(calls).toContain('POST /users/b7/tokens')
    expect(calls).not.toContain('PUT /bots/b8')
  })

  test('the bot of a folder is not taken from a live session of an old version', async () => {
    const calls = stub(undefined, [mine, old])
    await expect(provision(config, 'mac', 'dev', key => key === here, () => {})).rejects.toThrow('a session of an old version has the bot dev-cc')
    expect(calls).not.toContain('PUT /bots/b7')
    expect(calls).not.toContain('POST /users/b7/tokens')
  })
})

test('reply is limited to posts that this session received', () => {
  const delivered = new Set(['a'])
  const threads = new Set(['t'])
  expect(canReply('a', delivered, threads)).toBe(true)
  expect(canReply('t', delivered, threads)).toBe(true)
  expect(canReply('x', delivered, threads)).toBe(false)
})

describe('text of a turn', () => {
  const row = (type: string, content: unknown) => JSON.stringify({ type, message: { content } })
  const jsonl = [row('user', 'q'), row('assistant', [{ type: 'text', text: ' a ' }, { type: 'tool_use', name: 'Bash' }]), row('assistant', [{ type: 'text', text: 'b' }]), ''].join('\n')
  test('only assistant text, in order', () => expect(assistantTexts(jsonl)).toEqual(['a', 'b']))
  test('the last message is not posted twice', () => expect(withLast(['a', 'b'], 'b')).toEqual(['a', 'b']))
  test('a last message that is not in the file is added', () => expect(withLast(['a'], 'b')).toEqual(['a', 'b']))
  test('no text', () => expect(withLast([], '')).toEqual([]))
})

describe('TranscriptReader', () => {
  const row = (text: string) => `${JSON.stringify({ type: 'user', message: { content: text } })}\n`
  const newFile = (content: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'mm-')), 't.jsonl')
    writeFileSync(path, content)
    return path
  }
  const contents = async (reader: TranscriptReader) => {
    const got: Entry[] = []
    await reader.read(entry => got.push(entry))
    return got
  }

  test('the first file starts at its end', async () => {
    const path = newFile(row('old'))
    const reader = new TranscriptReader()
    reader.follow(path)
    appendFileSync(path, row('new'))
    expect((await contents(reader)).map(entry => entry.row.message.content)).toEqual(['new'])
  })

  test('a later file starts at its beginning', async () => {
    const reader = new TranscriptReader()
    reader.follow(newFile(row('old')))
    reader.follow(newFile(row('first')))
    expect((await contents(reader)).map(entry => entry.row.message.content)).toEqual(['first'])
  })

  test('each row comes once and start is its byte position', async () => {
    const path = newFile('')
    const reader = new TranscriptReader()
    reader.follow(path)
    appendFileSync(path, row('é') + row('b'))
    expect((await contents(reader)).map(entry => entry.start)).toEqual([0, Buffer.byteLength(row('é'))])
    expect(await contents(reader)).toEqual([])
  })

  test('a partial line waits for the next read', async () => {
    const path = newFile('')
    const reader = new TranscriptReader()
    reader.follow(path)
    appendFileSync(path, '{"type":"us')
    expect(await contents(reader)).toEqual([])
    appendFileSync(path, 'er"}\n')
    expect((await contents(reader)).map(entry => entry.row.type)).toEqual(['user'])
  })

  test('a read in flight during a change of file gives no rows', async () => {
    const path = newFile('')
    const reader = new TranscriptReader()
    reader.follow(path)
    appendFileSync(path, row('old file'))
    const got: Entry[] = []
    const pending = reader.read(entry => got.push(entry))
    await Promise.resolve()
    await Promise.resolve()
    reader.follow(newFile(row('new file')))
    await pending
    expect(got).toEqual([])
    expect((await contents(reader)).map(entry => entry.row.message.content)).toEqual(['new file'])
  })

  test('a row that the visitor cannot use does not stop the reader', async () => {
    const path = newFile('')
    const reader = new TranscriptReader()
    reader.follow(path)
    appendFileSync(path, row('bad') + row('good'))
    const got: string[] = []
    await reader.read(entry => {
      if (entry.row.message.content === 'bad') throw new Error('unknown form')
      got.push(entry.row.message.content)
    })
    expect(got).toEqual(['good'])
    expect(await contents(reader)).toEqual([])
  })

  test('a line that is not JSON is skipped', async () => {
    const path = newFile('')
    const reader = new TranscriptReader()
    reader.follow(path)
    appendFileSync(path, `not json\n${row('good')}`)
    expect((await contents(reader)).map(entry => entry.row.message.content)).toEqual(['good'])
  })
})

test('a second lock on one key fails until the first is released', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mm-lock-'))
  const key = `test-${process.pid}-${Date.now()}`
  const first = await takeLock(key, dir)
  expect(first).toBeDefined()
  expect(await takeLock(key, dir)).toBeUndefined()
  first!.release()
  await Bun.sleep(20)
  const again = await takeLock(key, dir)
  expect(again).toBeDefined()
  again!.release()
})

describe('attachments and file names', () => {
  test('names from metadata', () => {
    expect(attachments({ file_ids: ['a'], metadata: { files: [{ id: 'a', name: 'x<y>.txt', size: 1 }] } })).toEqual([{ id: 'a', name: 'x_y_.txt' }])
  })
  test('ids with no metadata', () => expect(attachments({ file_ids: ['a'] })).toEqual([{ id: 'a', name: 'a' }]))
  test('a file name stays in the inbox', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('.env')).toBe('env')
    expect(safeFileName('a b.txt')).toBe('a_b.txt')
  })
})

describe('assertSendable', () => {
  test('refuses a secrets file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-'))
    const path = join(dir, '.env')
    writeFileSync(path, 'x')
    expect(() => assertSendable(path)).toThrow()
  })
  test('accepts a normal file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-'))
    const path = join(dir, 'a.txt')
    writeFileSync(path, 'x')
    expect(assertSendable(path)).toContain('a.txt')
  })
})

describe('Bridge', () => {
  test('send is refused while the task is from an agent, and a terminal prompt permits it again', async () => {
    const bridge = new Bridge({} as any) as any
    bridge.id = { channelId: 'c', ownerUsername: 'o', botId: 'b' }
    bridge.api = { api: async () => ({ id: 'p' }) }
    const reached: string[] = []
    bridge.send = async (to: string) => {
      reached.push(to)
      return 'sent'
    }
    bridge.mailbox.wait('Stop', '', () => {})
    bridge.mailbox.offer('a post from an agent')
    await expect(bridge.callTool('send', { to: 'x-cc', text: 'do it' })).rejects.toThrow('came from an agent')
    expect(reached).toEqual([])
    bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>x</task-notification>' })
    await expect(bridge.callTool('send', { to: 'x-cc', text: 'do it' })).rejects.toThrow('came from an agent')
    bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: 'from the terminal' })
    expect(await bridge.callTool('send', { to: 'x-cc', text: 'do it' })).toBe('sent')
    expect(reached).toEqual(['x-cc'])
  })

  test('an ask on a turn from Mattermost is denied at once', () => {
    const bridge = new Bridge({} as any) as any
    bridge.id = { channelId: 'c', ownerUsername: 'o' }
    bridge.turn = { fromMattermost: true }
    expect(JSON.parse(bridge.ask()).hookSpecificOutput.permissionDecision).toBe('deny')
    bridge.turn = undefined
    expect(bridge.ask()).toBe('')
  })

  describe('typing', () => {
    const prompt = '<channel source="mattermost" channel_id="c">x</channel>'
    const interruptRow = (text: string) => `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] } })}\n`

    function typingBridge() {
      const bridge = new Bridge({ notification: async () => {} } as any) as any
      bridge.id = { channelId: 'c', ownerUsername: 'o', botId: 'b' }
      bridge.api = { api: async () => ({ id: 'p' }) }
      const typed: string[] = []
      bridge.ws = { typing: (channel: string) => typed.push(channel) }
      return { bridge, typed }
    }

    function newTranscript(content: string): string {
      const path = join(mkdtempSync(join(tmpdir(), 'mm-')), 't.jsonl')
      writeFileSync(path, content)
      return path
    }

    test('a running turn from Mattermost shows typing', async () => {
      const path = newTranscript('')
      const { bridge, typed } = typingBridge()
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
      await bridge.typingTick()
      expect(typed).toEqual(['c'])
    })

    for (const text of ['[Request interrupted by user]', '[Request interrupted by user for tool use]']) {
      test(`typing stops after the row ${text}`, async () => {
        const path = newTranscript('')
        const { bridge, typed } = typingBridge()
        bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
        await bridge.typingTick()
        appendFileSync(path, interruptRow(text))
        await bridge.transcriptTick()
        await bridge.typingTick()
        expect(typed).toEqual(['c'])
      })
    }

    test('an interrupt before the prompt does not stop typing of the new turn', async () => {
      const path = newTranscript(interruptRow('[Request interrupted by user]'))
      const { bridge, typed } = typingBridge()
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
      await bridge.transcriptTick()
      await bridge.typingTick()
      expect(typed).toEqual(['c'])
      expect(bridge.mailbox.busy).toBe(true)
    })

    test('the text of an interrupt in a tool result does not stop typing', async () => {
      const path = newTranscript('')
      const { bridge, typed } = typingBridge()
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
      appendFileSync(path, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: '[Request interrupted by user]' }] } })}\n`)
      await bridge.transcriptTick()
      await bridge.typingTick()
      expect(typed).toEqual(['c'])
    })

    test('an interrupt of a terminal turn clears busy', async () => {
      const path = newTranscript('')
      const { bridge } = typingBridge()
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: 'from the terminal', transcript_path: path })
      expect(bridge.mailbox.busy).toBe(true)
      appendFileSync(path, interruptRow('[Request interrupted by user]'))
      await bridge.transcriptTick()
      expect(bridge.mailbox.busy).toBe(false)
    })

    test('an interrupt delivers the queued agent posts', async () => {
      const path = newTranscript('')
      const { bridge } = typingBridge()
      const delivered: string[] = []
      bridge.mailbox.wait('Stop', '', (text: string) => delivered.push(text))
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
      bridge.mailbox.offer('agent post')
      expect(delivered).toEqual([])
      appendFileSync(path, interruptRow('[Request interrupted by user]'))
      await bridge.transcriptTick()
      expect(delivered).toEqual(['agent post'])
    })

    test('an interrupt clears the reply channel', async () => {
      const path = newTranscript('')
      const { bridge } = typingBridge()
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
      expect(bridge.turn.replyChannel).toBe('c')
      appendFileSync(path, interruptRow('[Request interrupted by user]'))
      await bridge.transcriptTick()
      expect(bridge.turn).toBeUndefined()
    })

    function postingBridge() {
      const { bridge } = typingBridge()
      const posted: string[] = []
      bridge.api = {
        api: async (_method: string, url: string, body: any) => {
          if (url === '/posts') posted.push(body.message)
          return { id: 'p' }
        },
      }
      return { bridge, posted }
    }

    const assistantRow = (text: string) => `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`

    test('an interrupt posts the held text with no mention', async () => {
      const path = newTranscript('')
      const { bridge, posted } = postingBridge()
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
      appendFileSync(path, assistantRow('partial') + interruptRow('[Request interrupted by user]'))
      await bridge.transcriptTick()
      await bridge.out
      expect(posted).toEqual(['partial'])
    })

    test('a failed turn posts the held text and then the warning', async () => {
      const path = newTranscript('')
      const { bridge, posted } = postingBridge()
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
      appendFileSync(path, assistantRow('partial'))
      bridge.onHook({ hook_event_name: 'StopFailure', error: 'overloaded', transcript_path: path })
      await bridge.out
      expect(posted).toEqual(['partial', ':warning: The turn stopped with an error: overloaded'])
      expect(bridge.mailbox.busy).toBe(false)
    })

    test('a row that is not from the assistant does not release a text', async () => {
      const path = newTranscript('')
      const { bridge, posted } = postingBridge()
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
      appendFileSync(path, assistantRow('one') + `${JSON.stringify({ type: 'user', message: { content: 'q' } })}\n`)
      await bridge.transcriptTick()
      await bridge.out
      expect(posted).toEqual([])
    })

    test('a new transcript ends the turn of the old transcript', () => {
      const path = newTranscript('')
      const { bridge } = postingBridge()
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
      expect(bridge.turn).toBeDefined()
      bridge.transcriptPath = newTranscript('')
      expect(bridge.turn).toBeUndefined()
    })

    test('a row of a new turn does not go to the turn that ended', async () => {
      const path = newTranscript('')
      const { bridge, posted } = postingBridge()
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
      appendFileSync(path, assistantRow('a'))
      bridge.onHook({ hook_event_name: 'Stop', last_assistant_message: 'a', transcript_path: path })
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
      appendFileSync(path, assistantRow('b') + assistantRow('c'))
      await bridge.out
      expect(posted).toEqual(['@o a'])
      await bridge.transcriptTick()
      await bridge.out
      expect(posted).toEqual(['@o a', 'b'])
    })

    test('an interrupt row is handled once', async () => {
      const path = newTranscript('')
      const { bridge } = typingBridge()
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
      appendFileSync(path, interruptRow('[Request interrupted by user]'))
      await bridge.transcriptTick()
      bridge.mailbox.turnStarted()
      await bridge.transcriptTick()
      expect(bridge.mailbox.busy).toBe(true)
    })

    test('a prompt that starts during the read keeps its state', async () => {
      const path = newTranscript('')
      const { bridge } = typingBridge()
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
      appendFileSync(path, interruptRow('[Request interrupted by user]'))
      const tick = bridge.transcriptTick()
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
      await tick
      await bridge.transcriptTick()
      expect(bridge.mailbox.busy).toBe(true)
      expect(bridge.turn.fromMattermost).toBe(true)
    })

    test('a text that only quotes an interrupt does not clear busy', async () => {
      const path = newTranscript('')
      const { bridge } = typingBridge()
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
      appendFileSync(path, interruptRow('see [Request interrupted by user] in the log'))
      await bridge.transcriptTick()
      expect(bridge.mailbox.busy).toBe(true)
    })

    test('an interrupt text beside another block does not clear busy', async () => {
      const path = newTranscript('')
      const { bridge } = typingBridge()
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
      appendFileSync(path, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }, { type: 'text', text: 'more' }] } })}\n`)
      await bridge.transcriptTick()
      expect(bridge.mailbox.busy).toBe(true)
    })

    test('Stop ends the interrupt scan', async () => {
      const path = newTranscript('')
      const { bridge } = typingBridge()
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
      appendFileSync(path, interruptRow('[Request interrupted by user]'))
      bridge.onHook({ hook_event_name: 'Stop', last_assistant_message: '', transcript_path: path })
      await bridge.out
      await bridge.transcriptTick()
      expect(bridge.mailbox.busy).toBe(true)
    })

    const dialog = { request_id: 'abcde', tool_name: 'Bash', description: 'd', input_preview: 'p' }

    test('no typing while a permission dialog waits, typing after the next user row', async () => {
      const path = newTranscript('')
      const { bridge, typed } = typingBridge()
      bridge.transcriptPath = path
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
      bridge.permissionRequest(dialog)
      await bridge.typingTick()
      expect(typed).toEqual([])
      appendFileSync(path, `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use' }] } })}\n`)
      await bridge.transcriptTick()
      await bridge.typingTick()
      expect(typed).toEqual([])
      appendFileSync(path, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } })}\n`)
      await bridge.transcriptTick()
      await bridge.typingTick()
      expect(typed).toEqual(['c'])
    })

    test('an answer from Mattermost starts typing at once', async () => {
      const path = newTranscript('')
      const { bridge, typed } = typingBridge()
      bridge.transcriptPath = path
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path: path })
      bridge.permissionRequest(dialog)
      await bridge.out
      await bridge.answerPermission('abcde', 'allow', 'p')
      await bridge.typingTick()
      expect(typed).toEqual(['c'])
    })
  })

  test('Stop posts each text of the turn and mentions the owner on the last', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mm-')), 't.jsonl')
    const row = (text: string) => `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`
    writeFileSync(path, row('old'))
    const bridge = new Bridge({} as any) as any
    bridge.id = { channelId: 'c', ownerUsername: 'o' }
    const posted: string[] = []
    bridge.api = {
      api: async (_method: string, _path: string, body: any) => {
        posted.push(body.message)
        return { id: 'p' }
      },
    }
    bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: '<channel source="mattermost" channel_id="c">x</channel>', transcript_path: path })
    appendFileSync(path, row('one') + row('two'))
    bridge.onHook({ hook_event_name: 'Stop', last_assistant_message: 'two', transcript_path: path })
    await bridge.out
    expect(posted).toEqual(['one', '@o two'])
  })

  test('a row of the turn before, written after the start of this turn, is not posted again', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mm-')), 't.jsonl')
    const row = (text: string, timestamp: string) => `${JSON.stringify({ type: 'assistant', timestamp, message: { content: [{ type: 'text', text }] } })}\n`
    writeFileSync(path, '')
    const bridge = new Bridge({} as any) as any
    bridge.id = { channelId: 'c', ownerUsername: 'o' }
    const posted: string[] = []
    bridge.api = {
      api: async (_method: string, _path: string, body: any) => {
        posted.push(body.message)
        return { id: 'p' }
      },
    }
    const before = new Date(Date.now() - 50).toISOString()
    bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: '<channel source="mattermost" channel_id="c">x</channel>', transcript_path: path })
    appendFileSync(path, row('last text of the turn before', before) + row('one', new Date(Date.now() + 50).toISOString()))
    bridge.onHook({ hook_event_name: 'Stop', last_assistant_message: 'one', transcript_path: path })
    await bridge.out
    expect(posted).toEqual(['@o one'])
  })

  test('a text is posted during the turn and Stop posts only the rest', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mm-')), 't.jsonl')
    const row = (content: unknown) => `${JSON.stringify({ type: 'assistant', message: { content } })}\n`
    const text = (value: string) => row([{ type: 'text', text: value }])
    writeFileSync(path, text('old'))
    const bridge = new Bridge({} as any) as any
    bridge.id = { channelId: 'c', ownerUsername: 'o' }
    const posted: string[] = []
    bridge.api = {
      api: async (_method: string, _path: string, body: any) => {
        posted.push(body.message)
        return { id: 'p' }
      },
    }
    const tick = async () => {
      await bridge.transcriptTick()
      await bridge.out
    }
    bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: '<channel source="mattermost" channel_id="c">x</channel>', transcript_path: path })
    appendFileSync(path, text('one'))
    await tick()
    expect(posted).toEqual([])
    appendFileSync(path, row([{ type: 'tool_use', name: 'Bash' }]) + text('two'))
    await tick()
    await tick()
    expect(posted).toEqual(['one'])
    bridge.onHook({ hook_event_name: 'Stop', last_assistant_message: 'two', transcript_path: path })
    await bridge.out
    expect(posted).toEqual(['one', '@o two'])
    await tick()
    expect(posted).toEqual(['one', '@o two'])
  })

  test('read gives reply rights only for the posts that it shows', async () => {
    const bridge = new Bridge({} as any) as any
    bridge.id = { channelId: 'c', username: 'ai-cc' }
    const base = { create_at: 1, user_id: 'u', message: 'm', root_id: '' }
    bridge.api = {
      api: async (_method: string, path: string) =>
        path.includes('/posts?')
          ? { order: ['a', 'b'], posts: { a: { id: 'a', type: 'system_join_channel', ...base }, b: { id: 'b', type: '', ...base } } }
          : [{ id: 'u', username: 'n' }],
    }
    const text = await bridge.readPosts('', 5)
    expect(text).toContain('post_id=b')
    expect(text).not.toContain('post_id=a')
    expect(bridge.delivered.has('b')).toBe(true)
    expect(bridge.delivered.has('a')).toBe(false)
  })

  test('the end of the session posts the end and keeps the owner in the channel', async () => {
    const bridge = new Bridge({} as any) as any
    const calls: string[] = []
    bridge.id = { channelId: 'c' }
    bridge.config = { ownerId: 'o' }
    bridge.api = {
      api: async (method: string, url: string, body: any) => {
        calls.push(`${method} ${url} ${body?.message ?? ''}`)
        return { id: 'made' }
      },
    }
    await bridge.shutdown()
    expect(calls).toEqual(['POST /posts :red_circle: Session ended'])
  })

  describe('start post', () => {
    function startBridge() {
      const bridge = new Bridge({} as any) as any
      const calls: string[] = []
      bridge.open = async () => {
        bridge.id = { channelId: 'c' }
      }
      bridge.api = {
        api: async (method: string, url: string, body: any) => {
          calls.push(`${method} ${url} ${body.message}`)
          return { id: 'start' }
        },
      }
      return { bridge, calls }
    }

    test('a model that comes before the start post is in the post', async () => {
      const { bridge, calls } = startBridge()
      bridge.sessionSettings({ hook_event_name: 'SessionStart', source: 'startup', model: 'm' })
      await bridge.connect({}, '/x', 'x')
      await bridge.out
      expect(calls).toEqual([`POST /posts :large_green_circle: Session started on \`${hostname()}\` in \`/x\`, model \`m\``])
    })

    test('a follow from the state file is in the start post, with no second post', async () => {
      const { bridge, calls } = startBridge()
      bridge.followPath = join(mkdtempSync(join(tmpdir(), 'mm-follow-')), 'bot.json')
      writeFileSync(bridge.followPath, JSON.stringify({ from: ['b-cc'], purpose: 'p', report: true }))
      await bridge.connect({}, '/x', 'x')
      await bridge.out
      expect(calls).toEqual([`POST /posts :large_green_circle: Session started on \`${hostname()}\` in \`/x\`\n:eyes: Follows @b-cc, with report: p`])
    })

    test('the model comes by an edit, and later values change nothing', async () => {
      const { bridge, calls } = startBridge()
      await bridge.connect({}, '/x', 'x')
      bridge.sessionSettings({ hook_event_name: 'SessionStart', source: 'startup', model: 'm' })
      await bridge.out
      bridge.sessionSettings({ hook_event_name: 'UserPromptSubmit' })
      bridge.sessionSettings({ hook_event_name: 'Stop', effort: { level: 'high' } })
      bridge.sessionSettings({ hook_event_name: 'Stop', effort: { level: 'low' } })
      bridge.sessionSettings({ hook_event_name: 'SessionStart', source: 'compact', model: 'n' })
      await bridge.out
      expect(calls).toEqual([
        `POST /posts :large_green_circle: Session started on \`${hostname()}\` in \`/x\``,
        `PUT /posts/start/patch :large_green_circle: Session started on \`${hostname()}\` in \`/x\`, model \`m\``,
      ])
    })
  })
})

describe('post retrieval', () => {
  for (const tool of ['read', 'search']) {
    test(`${tool} shows attachments and tracks only the normal posts it shows`, async () => {
      const bridge = new Bridge({} as any) as any
      bridge.id = { channelId: 'c', username: 'ai-cc', teamId: 't' }
      const normal = post({ id: 'shown', root_id: 'root', file_ids: ['file'], metadata: { files: [{ id: 'file', name: 'report.txt', size: 1 }] } })
      const hidden = post({ id: 'hidden', type: 'system_join_channel', file_ids: ['hidden-file'] })
      bridge.api = {
        api: async (_method: string, path: string) => path === '/users/ids'
          ? [{ id: normal.user_id, username: 'agent' }]
          : { order: ['shown', 'hidden'], posts: { shown: normal, hidden } },
      }
      const text = await bridge.callTool(tool, { terms: 'report', limit: 5 })
      expect(text).toContain('report.txt (file_id=file)')
      expect(bridge.delivered.has('shown')).toBe(true)
      expect(bridge.delivered.has('root')).toBe(true)
      expect(bridge.deliveredFiles.has('file')).toBe(true)
      expect(bridge.delivered.has('hidden')).toBe(false)
      expect(bridge.deliveredFiles.has('hidden-file')).toBe(false)
    })
  }
})

describe('terminal commands', () => {
  const stdout = (text: string) => `${JSON.stringify({ type: 'user', message: { content: `<local-command-stdout>${text}</local-command-stdout>` } })}\n`
  const ownerPost = (message: string) => ({ id: '1', channel_id: 'd', user_id: 'o', root_id: '', create_at: 1, message })

  function commandBridge(path?: string) {
    const sent: any[] = []
    const bridge = new Bridge({ notification: async (note: any) => sent.push(note) } as any) as any
    bridge.id = { channelId: 'c', ownerUsername: 'o', botId: 'b' }
    bridge.names.set('o', 'n')
    const posted: string[] = []
    bridge.api = {
      api: async (_method: string, url: string, body: any) => {
        if (url === '/posts') posted.push(body.message)
        return { id: 'p' }
      },
    }
    const typed: string[] = []
    bridge.typeText = async (text: string) => {
      typed.push(text)
    }
    bridge.transcriptPath = path
    return { bridge, posted, typed, sent }
  }

  const transcript = (content = '') => {
    const path = join(mkdtempSync(join(tmpdir(), 'mm-command-')), 't.jsonl')
    writeFileSync(path, content)
    return path
  }

  test('terminalCommand accepts only commands that open no dialog', () => {
    for (const text of ['/clear', ' /context\n', '/compact keep the plan', '/model opus', '/effort low', '! git status', '! ls | wc -l']) {
      expect(terminalCommand(text)).toBe(text.trim())
    }
    for (const text of ['/model', '/effort', '/cost', '/usage', '/exit', '/config', '/clear now', '/compact a\nb', '/compact a\x1b[A', '/model a\rb', 'clear', '!', '!ls', '! a\nb', '! a\x1b[A']) {
      expect(terminalCommand(text)).toBeUndefined()
    }
  })

  test('commandOutput reads a user row and a system row', () => {
    expect(commandOutput(stdout('Set model'))).toBe('Set model')
    const system = JSON.stringify({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>\x1b[1m Context\x1b[0m</local-command-stdout>' })
    expect(commandOutput(system)).toBe('Context')
    expect(commandOutput(stdout(''))).toBe('')
  })

  test('commandOutput ignores text that only quotes the tag', () => {
    const tool = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: '<local-command-stdout>x</local-command-stdout>' }] } })
    const prompt = JSON.stringify({ type: 'user', message: { content: 'see <local-command-stdout>x</local-command-stdout> here' } })
    expect(commandOutput(`${tool}\n${prompt}\n{"partial local-command-stdout`)).toBeUndefined()
  })

  const bashRow = (out: string, err: string) => `${JSON.stringify({ type: 'user', message: { content: `<bash-stdout>${out}</bash-stdout><bash-stderr>${err}</bash-stderr>` } })}\n`

  test('bashOutput reads stdout and stderr of the bash mode row', () => {
    expect(bashOutput(bashRow('marker\n', ''))).toBe('marker')
    expect(bashOutput(bashRow('', 'oops\n'))).toBe('oops')
    expect(bashOutput(bashRow('a\n', '\x1b[1mb\x1b[0m\n'))).toBe('a\nb')
    expect(bashOutput(bashRow('', ''))).toBe('')
  })

  test('bashOutput ignores other rows and cuts long output', () => {
    const input = JSON.stringify({ type: 'user', message: { content: '<bash-input> ls</bash-input>' } })
    const tool = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: '<bash-stdout>x</bash-stdout><bash-stderr></bash-stderr>' }] } })
    const prompt = JSON.stringify({ type: 'user', message: { content: 'see <bash-stdout>x</bash-stdout><bash-stderr></bash-stderr> here' } })
    expect(bashOutput(`${input}\n${tool}\n${prompt}\n{"partial bash-stdout`)).toBeUndefined()
    const long = bashOutput(bashRow('x'.repeat(20_000), ''))!
    expect(long.length).toBeLessThan(13_000)
    expect(long).toContain('[cut: 20000 characters in total]')
  })

  test('a post with ! is typed and posts the output of the command', async () => {
    const path = transcript(bashRow('old', ''))
    const { bridge, posted, typed, sent } = commandBridge(path)
    await bridge.fromOwner(ownerPost('! git status'))
    await Bun.sleep(300)
    expect(bridge.commandRunning).toBe(true)
    await bridge.fromOwner(ownerPost('! ls'))
    appendFileSync(path, bashRow('clean\n', ''))
    await bridge.commandDone
    await bridge.out
    expect(typed).toEqual(['!', 'git status', '\r'])
    expect(sent).toEqual([])
    expect(posted).toHaveLength(2)
    expect(posted[0]).toContain('busy')
    expect(posted[1]).toContain('clean')
    expect(posted[1]).not.toContain('old')
    expect(bridge.commandRunning).toBe(false)
  })

  test('an owner post types the command and posts only the new output', async () => {
    const path = transcript(stdout('old output'))
    const { bridge, posted, typed, sent } = commandBridge(path)
    await bridge.fromOwner(ownerPost('/context'))
    appendFileSync(path, stdout('new output'))
    await bridge.commandDone
    await bridge.out
    expect(typed).toEqual(['/context', '\r'])
    expect(sent).toEqual([])
    expect(posted).toHaveLength(1)
    expect(posted[0]).toContain('new output')
    expect(posted[0]).not.toContain('old output')
    expect(bridge.commandRunning).toBe(false)
  })

  test('/clear reads the new transcript from its start', async () => {
    const path = transcript(stdout('old output'))
    const { bridge, posted } = commandBridge(path)
    await bridge.fromOwner(ownerPost('/clear'))
    bridge.transcriptPath = transcript(stdout(''))
    await bridge.commandDone
    await bridge.out
    expect(posted[0]).toContain(':white_check_mark:')
  })

  test('the first path found during a command is read from its start', async () => {
    const { bridge, posted } = commandBridge()
    await bridge.fromOwner(ownerPost('/context'))
    bridge.transcriptPath = transcript(stdout('found'))
    await bridge.commandDone
    await bridge.out
    expect(posted[0]).toContain('found')
  })

  test('a running turn or a running command refuses the post', async () => {
    const { bridge, posted, typed } = commandBridge(transcript())
    bridge.mailbox.turnStarted()
    await bridge.fromOwner(ownerPost('/context'))
    bridge.mailbox.busy = false
    bridge.commandRunning = true
    await bridge.fromOwner(ownerPost('/clear'))
    await bridge.out
    expect(typed).toEqual([])
    expect(posted).toHaveLength(2)
    expect(posted[0]).toContain('busy')
    expect(posted[1]).toContain('busy')
  })

  test('a typing error is posted and frees the next command', async () => {
    const { bridge, posted } = commandBridge(transcript())
    bridge.typeText = async () => {
      throw new Error('Operation not permitted')
    }
    await bridge.fromOwner(ownerPost('/context'))
    await bridge.out
    expect(posted[0]).toContain('Operation not permitted')
    expect(bridge.commandRunning).toBe(false)
  })

  test('other slash commands stay channel messages', async () => {
    const { bridge, typed, sent } = commandBridge(transcript())
    await bridge.fromOwner(ownerPost('/state'))
    bridge.mailbox.turnFailed()
    await bridge.fromOwner(ownerPost('/cost'))
    expect(typed).toEqual([])
    expect(sent.map(note => note.params.content)).toEqual(['/state', '/cost'])
  })
})

describe('an owner post during a turn', () => {
  const ownerPost = (id: string) => ({ id, channel_id: 'c', user_id: 'o', root_id: '', create_at: 1, message: id })

  function busyBridge() {
    const sent: string[] = []
    const bridge = new Bridge({ notification: async (note: any) => sent.push(note.params.content) } as any) as any
    bridge.id = { channelId: 'c', ownerUsername: 'o', botId: 'b' }
    bridge.reactionDelayMs = 0
    bridge.names.set('o', 'n')
    const reactions: string[] = []
    bridge.api = {
      api: async (_method: string, url: string, body: any) => {
        if (url === '/reactions') reactions.push(`${body.post_id} ${body.emoji_name}`)
        return { id: 'p' }
      },
    }
    bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: 'from the terminal' })
    return { bridge, sent, reactions }
  }

  test('the post waits for the end of the turn', async () => {
    const { bridge, sent, reactions } = busyBridge()
    await bridge.fromOwner(ownerPost('one'))
    await bridge.out
    expect(sent).toEqual([])
    expect(reactions).toEqual(['one hourglass_flowing_sand'])
    bridge.mailbox.wait('Stop', '', () => {})
    await Bun.sleep(0)
    await bridge.out
    expect(sent).toEqual(['one'])
    expect(reactions).toEqual(['one hourglass_flowing_sand', 'one eyes'])
    expect(bridge.mailbox.busy).toBe(true)
  })

  test('each end of a turn delivers one post, and the owner posts go before the agent posts', async () => {
    const { bridge, sent } = busyBridge()
    const rewake: string[] = []
    bridge.mailbox.offer('agent post')
    await bridge.fromOwner(ownerPost('one'))
    await bridge.fromOwner(ownerPost('two'))
    for (const expected of [['one'], ['one', 'two']]) {
      bridge.mailbox.wait('Stop', '', (text: string) => rewake.push(text))
      await Bun.sleep(0)
      expect(sent).toEqual(expected)
    }
    expect(rewake).toEqual([''])
    bridge.mailbox.wait('Stop', '', (text: string) => rewake.push(text))
    expect(rewake).toEqual(['', '', 'agent post'])
  })

  test('an interrupt delivers the post', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mm-')), 't.jsonl')
    writeFileSync(path, '')
    const { bridge, sent } = busyBridge()
    bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: 'from the terminal', transcript_path: path })
    await bridge.fromOwner(ownerPost('one'))
    appendFileSync(path, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } })}\n`)
    await bridge.transcriptTick()
    await Bun.sleep(0)
    expect(sent).toEqual(['one'])
  })

  test('a delivery that fails does not keep the session busy', async () => {
    const { bridge, sent } = busyBridge()
    bridge.mailbox.turnFailed()
    const notification = bridge.mcp.notification
    bridge.mcp.notification = async () => {
      throw new Error('closed')
    }
    await bridge.fromOwner(ownerPost('one'))
    expect(bridge.mailbox.busy).toBe(false)
    bridge.mcp.notification = notification
    await bridge.fromOwner(ownerPost('two'))
    expect(sent).toEqual(['two'])
  })

  test('a permission answer does not wait', async () => {
    const { bridge, reactions } = busyBridge()
    bridge.permissions.set('abcde', 'p')
    await bridge.fromOwner({ ...ownerPost('one'), message: 'yes abcde' })
    await Bun.sleep(0)
    expect(reactions).toEqual(['one white_check_mark'])
    expect(bridge.permissions.size).toBe(0)
  })

  test('a reaction goes to Mattermost after a delay', async () => {
    const { bridge, reactions } = busyBridge()
    bridge.reactionDelayMs = 50
    bridge.react('one', 'eyes')
    await Bun.sleep(10)
    expect(reactions).toEqual([])
    await Bun.sleep(80)
    expect(reactions).toEqual(['one eyes'])
  })

  test('the delay of a reaction is 200 ms', () => {
    const bridge = new Bridge({ notification: async () => {} } as any) as any
    expect(bridge.reactionDelayMs).toBe(200)
  })
})

describe('job', () => {
  const stdout = (text: string) => `${JSON.stringify({ type: 'user', message: { content: `<local-command-stdout>${text}</local-command-stdout>` } })}\n`
  const assistant = (text: string) => `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`
  const promptOf = (note: any) =>
    `<channel source="plugin:mattermost:mattermost" ${Object.entries(note.params.meta).map(([key, value]) => `${key}="${value}"`).join(' ')}>\n${note.params.content}\n</channel>`

  function jobBridge(statePath = join(mkdtempSync(join(tmpdir(), 'mm-job-')), 'schedules', 'b.json')) {
    const sent: any[] = []
    const bridge = new Bridge({ notification: async (note: any) => sent.push(note) } as any) as any
    bridge.id = { channelId: 'c', ownerUsername: 'o', botId: 'b' }
    bridge.config = { ownerId: 'o' }
    bridge.reactionDelayMs = 0
    bridge.names.set('o', 'o')
    const posts = new Map<string, any>()
    const posted: { message: string; root: string }[] = []
    const reactions: string[] = []
    // The time zone of the owner in Mattermost. 'down' is a request that fails.
    const mattermost = { zone: 'UTC' }
    bridge.api = {
      api: async (method: string, url: string, body: any) => {
        if (method === 'GET' && url.startsWith('/posts/')) {
          const found = posts.get(url.slice('/posts/'.length))
          if (!found) throw new ApiError(404, 'missing', url)
          if (found === 'down') throw new Error('no connection')
          return found
        }
        if (method === 'GET' && url === '/users/o') {
          if (mattermost.zone === 'down') throw new Error('no connection')
          return { username: 'o', timezone: { useAutomaticTimezone: 'false', manualTimezone: mattermost.zone } }
        }
        if (url === '/posts') posted.push({ message: body.message, root: body.root_id })
        if (url === '/reactions') reactions.push(`${body.post_id} ${body.emoji_name}`)
        return { id: 'p' }
      },
    }
    const typed: string[] = []
    bridge.typeText = async (text: string) => {
      typed.push(text)
    }
    const path = join(mkdtempSync(join(tmpdir(), 'mm-job-')), 't.jsonl')
    writeFileSync(path, '')
    bridge.transcriptPath = path
    bridge.jobPath = statePath
    bridge.quietMs = 0
    const owner = async (id: string, message: string, fields: Partial<Post> = {}) => {
      const made = { id, channel_id: 'c', user_id: 'o', root_id: '', create_at: 1, type: '', message, ...fields }
      posts.set(id, made)
      await bridge.fromOwner(made)
      await bridge.out
      return made
    }
    const due = async (at = Date.now() - 1) => {
      bridge.job.schedule.due = bridge.job.schedule.due.map(() => at)
      await bridge.jobTick()
    }
    // The hooks of Claude Code for one turn of a prompt step.
    const turn = async (note: any, answer: string, during: () => Promise<unknown> = async () => {}) => {
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: promptOf(note), transcript_path: path })
      await during()
      if (answer) appendFileSync(path, assistant(answer))
      bridge.onHook({ hook_event_name: 'Stop', last_assistant_message: answer, transcript_path: path })
      await bridge.out
      bridge.mailbox.wait('Stop', '', () => {})
    }
    // The turn of the model for the last request for a schedule: it calls the tool with args.
    const answer = async (args: object) => {
      const note = sent.at(-1)
      await turn(note, '', () => bridge.callTool('schedule', { request_id: note.params.meta.run_id, ...args }))
      await bridge.out
    }
    // A job post, and the model that reads its schedule. Then sent is empty, so sent has only the prompts of the steps.
    const job = async (id: string, message: string, triggers: object[] = [{ every: /^\/every (\S+)/.exec(message)![1] }]) => {
      const made = await owner(id, message)
      await answer({ triggers })
      sent.length = 0
      // No waiter stays, so a later agent post does not start a turn.
      bridge.mailbox.close()
      return made
    }
    return { bridge, sent, posts, posted, reactions, typed, path, statePath, mattermost, owner, due, turn, answer, job }
  }

  test('jobStepKind accepts the slash commands of the terminal and refuses a ! command', () => {
    for (const line of ['/clear', '/context', '/compact keep the plan', '/model opus', '/effort low']) expect(jobStepKind(line)).toBe('command')
    for (const line of ['! ls', '! git status']) expect(jobStepKind(line)).toBe('refused')
    for (const line of ['/state', '/cost', 'Examine the disk.', '', '!', '!ls']) expect(jobStepKind(line)).toBe('text')
  })

  test('/every saves the job and sends only line 1 to the model, and the tool call of the model sets the schedule', async () => {
    const { bridge, posted, sent, reactions, statePath, owner, answer } = jobBridge()
    const before = Date.now()
    await owner('j1', '/every 30 minutes\n/clear\nExamine the disk.')
    expect(posted).toEqual([])
    expect(reactions).toEqual(['j1 eyes'])
    expect(readState(statePath)).toEqual({ postId: 'j1', editAt: 0, paused: false })
    expect(sent).toHaveLength(1)
    expect(sent[0].params.content).toContain('\n30 minutes\n')
    expect(sent[0].params.content).toContain(`the Mattermost tool \`mcp__plugin_mattermost_mattermost__schedule\` one time with the request_id "${bridge.run.id}"`)
    expect(sent[0].params.content).not.toContain('Examine')
    expect(sent[0].params.meta).toMatchObject({ user: 'o', post_id: 'j1', thread_id: 'j1', job: 'run', run_id: bridge.run.id, step: '1' })
    await answer({ triggers: [{ every: '30m' }] })
    expect(posted).toHaveLength(1)
    expect(posted[0]!.root).toBe('j1')
    expect(posted[0]!.message).toContain(':alarm_clock: Job: each 30m, 2 steps. Next run: ')
    expect(posted[0]!.message).not.toContain('@o')
    expect(posted[0]!.message).not.toContain('replaces')
    const state = readState(statePath)!
    expect(state).toEqual(bridge.job)
    expect(state.schedule).toMatchObject({ text: '30 minutes', zone: 'UTC', triggers: [{ every: '30m' }] })
    expect(state.schedule!.due[0]).toBeGreaterThanOrEqual(before + 1_800_000)
    expect(state.lastRun).toBeUndefined()
    expect(bridge.run).toBeUndefined()
    expect(bridge.mailbox.busy).toBe(false)
  })

  test('a schedule with days, times and an interval shows in the time zone of the owner', async () => {
    const { bridge, posted, mattermost, owner, answer } = jobBridge()
    mattermost.zone = 'Europe/Madrid'
    await owner('j1', '/every sunday at 14:00 , wedn 09am and 21pm and every 48 hours\nExamine the disk.')
    const before = Date.now()
    await answer({ triggers: [{ days: ['sun'], times: ['14:00'] }, { days: ['wed'], times: ['9:00', '21:00'] }, { every: '48h' }] })
    expect(posted[0]!.message).toContain(':alarm_clock: Job: Sun at 14:00; Wed at 09:00, 21:00; each 48h (Europe/Madrid), 1 step. Next run: ')
    expect(posted[0]!.message).toMatch(/Next run: \d{4}-\d\d-\d\d \d\d:\d\d Europe\/Madrid\.$/)
    const schedule = bridge.job.schedule
    expect(schedule.zone).toBe('Europe/Madrid')
    expect(schedule.due).toHaveLength(3)
    expect(schedule.due[2]).toBeGreaterThanOrEqual(before + 172_800_000)
    for (const at of schedule.due.slice(0, 2)) expect(at - before).toBeLessThanOrEqual(7 * 86_400_000)
  })

  test('a number of random times: the plugin selects the times, and /start keeps the times of the day', async () => {
    const { bridge, posted, sent, owner, answer } = jobBridge()
    await owner('j1', '/every 5 times a day in random time\nExamine the disk.')
    expect(sent[0].params.content).toContain('a trigger with `count`')
    const before = Date.now()
    await answer({ triggers: [{ count: 5 }] })
    expect(posted[0]!.message).toContain(':alarm_clock: Job: each day at 5 random times from 00:00 to 24:00 (UTC), 1 step. Next run: ')
    const schedule = bridge.job.schedule
    expect(schedule.triggers).toEqual([{ days: [], count: 5, from: '00:00', to: '24:00' }])
    expect(schedule.due[0]).toBeGreaterThan(before)
    expect(schedule.due[0] - before).toBeLessThanOrEqual(2 * 86_400_000)
    expect(schedule.due).toEqual(firstDue(schedule.triggers, before, 'UTC', 'j1'))
    await owner('s', '/stop')
    await owner('u', '/start')
    expect(posted.at(-1)!.message).toContain('The job runs again: each day at 5 random times from 00:00 to 24:00 (UTC), 1 step. Next run: ')
    expect(bridge.job.schedule.due).toEqual(schedule.due)
  })

  test('with no time zone in Mattermost the zone of the computer applies, and with no answer of Mattermost the zone of the state applies', async () => {
    const { bridge, mattermost, job, due } = jobBridge()
    mattermost.zone = ''
    await job('j1', '/every day at 10\ndo it', [{ times: ['10:00'] }])
    expect(bridge.job.schedule.zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    bridge.job.schedule.zone = 'Asia/Tokyo'
    mattermost.zone = 'down'
    await due()
    expect(bridge.job.schedule.zone).toBe('Asia/Tokyo')
    expect(new Date(bridge.job.schedule.due[0]).toISOString().slice(11, 16)).toBe('01:00')
  })

  test('a new time zone of the owner moves the times of the day, and the time in the old zone starts no run', async () => {
    const { bridge, sent, posted, mattermost, job, due } = jobBridge()
    await job('j1', '/every day at 10 and every 3 hours\ndo it', [{ times: ['10:00'] }, { every: '3h' }])
    posted.length = 0
    const interval = bridge.job.schedule.due[1]
    mattermost.zone = 'Asia/Tokyo'
    bridge.job.schedule.due[0] = Date.now() - 1
    await bridge.jobTick()
    expect(sent).toEqual([])
    expect(posted).toEqual([])
    expect(bridge.job.schedule.zone).toBe('Asia/Tokyo')
    expect(new Date(bridge.job.schedule.due[0]).toISOString().slice(11, 16)).toBe('01:00')
    expect(bridge.job.schedule.due[1]).toBe(interval)
    await due()
    expect(sent).toHaveLength(1)
  })

  test('a second /every replaces the job', async () => {
    const { bridge, posted, job } = jobBridge()
    await job('j1', '/every 30m\none')
    await job('j2', '/every 2h\ntwo')
    expect(bridge.job.postId).toBe('j2')
    expect(posted[1]).toEqual({ message: expect.stringContaining('each 2h, 1 step. '), root: 'j2' })
    expect(posted[1]!.message).toContain('replaces the old job')
  })

  test('a post that is not a correct job makes no job and gives the cause', async () => {
    const { bridge, posted, reactions, sent, statePath, owner } = jobBridge()
    await owner('j1', '/every')
    await owner('j2', '/every 1m\n! rm -rf x')
    await owner('j3', '/every 1m\ndo it', { root_id: 'r' })
    await owner('j4', '/every 30m Examine the disk.')
    expect(bridge.job).toBeUndefined()
    expect(existsSync(statePath)).toBe(false)
    expect(sent).toEqual([])
    expect(reactions).toEqual(['j1 x', 'j2 x', 'j3 x', 'j4 x'])
    expect(posted.map(made => made.root)).toEqual(['j1', 'j2', 'r', 'j4'])
    expect(posted[0]!.message).toContain('@o :warning: No job was made: line 1 must have the schedule')
    expect(posted[1]!.message).toContain('`! rm -rf x` cannot be a step')
    expect(posted[2]!.message).toContain('as a new post')
    expect(posted[3]!.message).toContain('the job has no steps. Line 1 is the schedule, and the steps start on line 2.')
  })

  test('a job command in a direct message is refused and does not go to the model', async () => {
    const { bridge, posted, sent, owner } = jobBridge()
    await owner('j1', '/every 1m\ndo it', { channel_id: 'dm' })
    await owner('j2', '/job', { channel_id: 'dm' })
    expect(bridge.job).toBeUndefined()
    expect(sent).toEqual([])
    expect(posted.map(made => made.message)).toEqual(Array(2).fill('@o A job command works only in the channel of the session.'))
  })

  test('/help lists the commands in the channel and in a direct message, and does not go to the model', async () => {
    const { posted, sent, owner } = jobBridge()
    await owner('h1', '/help')
    await owner('h2', ' /help ', { channel_id: 'dm' })
    await owner('h3', '/help me')
    expect(posted.map(made => made.message)).toEqual(Array(2).fill(`@o ${HELP_TEXT}`))
    expect(HELP_TEXT).toContain('`/every <schedule>`')
    expect(sent.map(note => note.params.content)).toEqual(['/help me'])
  })

  test('/job, /stop, /start and /drop with no job, and with text', async () => {
    const { posted, sent, owner } = jobBridge()
    for (const name of ['job', 'stop', 'start', 'drop']) await owner(name, `/${name}`)
    expect(posted.map(made => made.message)).toEqual(Array(4).fill('@o This session has no job.'))
    await owner('x', '/stop now')
    expect(posted[4]!.message).toBe('@o `/stop` takes no text.')
    await owner('y', '/jobs')
    expect(sent.map(note => note.params.content)).toEqual(['/jobs'])
  })

  test('/job shows the schedule, the steps, the state, the next time and the last result', async () => {
    const { bridge, posted, owner, job } = jobBridge()
    await job('j1', `/every 30m\n/clear\nExamine the disk.\nSecond line.`)
    bridge.job.lastRun = { at: Date.UTC(2026, 0, 2, 3, 4), result: 'ok' }
    bridge.job.schedule.due = [Date.UTC(2026, 0, 2, 3, 34)]
    await owner('q', '/job')
    expect(posted[1]!.message).toBe(
      ['@o :alarm_clock: Job: each 30m, 2 steps', 'State: active', 'Next run: 2026-01-02 03:34 UTC', 'Last run: 2026-01-02 03:04 UTC, ok', '1. `/clear`', '2. Examine the disk.…'].join('\n'),
    )
  })

  test('/job during the request for the schedule shows line 1 of the post', async () => {
    const { posted, owner } = jobBridge()
    await owner('j1', '/every day at 14\ndo it')
    await owner('q', '/job')
    expect(posted[0]!.message).toBe(['@o :alarm_clock: Job: `day at 14`, 1 step', 'State: the model reads the schedule', 'Last run: none', '1. do it'].join('\n'))
  })

  test('a due job types the command step, then sends the prompt with the ID of the job post, and the output goes to the thread with no mention', async () => {
    const { bridge, sent, posted, typed, path, statePath, job, due, turn } = jobBridge()
    await job('j1', '/every 30m\n/clear\nExamine the disk.')
    posted.length = 0
    const before = Date.now()
    await due()
    // The next time is the due time plus the interval, and due() makes the job due 1 ms before now.
    expect(readState(statePath)!.schedule!.due[0]).toBeGreaterThanOrEqual(before - 1 + 1_800_000)
    expect(bridge.mailbox.busy).toBe(true)
    // The SessionStart hook of /clear must not start the next step before the output of the command.
    bridge.mailbox.wait('SessionStart', 'clear', () => {})
    expect(sent).toEqual([])
    appendFileSync(path, stdout(''))
    await bridge.commandDone
    await bridge.out
    expect(typed).toEqual(['/clear', '\r'])
    expect(posted).toEqual([{ message: ':white_check_mark: `/clear`', root: 'j1' }])
    expect(sent).toHaveLength(1)
    expect(sent[0].params.content).toBe('Examine the disk.')
    expect(sent[0].params.meta).toMatchObject({ user: 'o', post_id: 'j1', channel_id: 'c', thread_id: 'j1', job: 'run', step: '2' })
    expect(bridge.promptWait).toBeDefined()
    expect(bridge.delivered.has('j1')).toBe(true)
    await turn(sent[0], 'The disk is 40 % full.')
    expect(bridge.promptWait).toBeUndefined()
    expect(posted[1]).toEqual({ message: 'The disk is 40 % full.', root: 'j1' })
    expect(bridge.run).toBeUndefined()
    expect(bridge.mailbox.busy).toBe(false)
    expect(readState(statePath)!.lastRun!.result).toBe('ok')
    await bridge.jobTick()
    expect(sent).toHaveLength(1)
  })

  test('two prompt steps: the end of the first turn starts the second step', async () => {
    const { bridge, sent, job, due, turn } = jobBridge()
    await job('j1', '/every 1m\nOne.\n/context\nTwo.')
    bridge.job = { ...bridge.job }
    await due()
    expect(sent.map(note => note.params.meta.step)).toEqual(['1'])
    await turn(sent[0], 'first')
    expect(bridge.run.inCommand).toBe(true)
  })

  test('no run while the session is busy, while the job is stopped, in the quiet time, and before a hook gave the transcript', async () => {
    const { bridge, sent, posted, owner, job, due } = jobBridge()
    await job('j1', '/every 1m\ndo it')
    bridge.mailbox.turnStarted()
    await due()
    bridge.mailbox.turnFailed()
    bridge.commandRunning = true
    await due()
    bridge.commandRunning = false
    bridge.quietMs = 60_000
    bridge.mailbox.ownerInputAt = Date.now() - 59_000
    await due()
    bridge.quietMs = 0
    await owner('n', '/start')
    expect(posted.at(-1)!.message).toBe('@o The job is not stopped.')
    await owner('p', '/stop')
    await due()
    expect(sent).toEqual([])
    expect(posted.at(-1)!.message).toContain('The job is stopped')
    const before = Date.now()
    await owner('u', '/start')
    expect(sent).toEqual([])
    expect(bridge.job.schedule.due[0]).toBeGreaterThanOrEqual(before + 60_000)
    expect(posted.at(-1)!.message).toContain('@o :white_check_mark: The job runs again: each 1m, 1 step. Next run: ')
    const known = bridge.transcript.path
    bridge.transcript.path = undefined
    await due()
    expect(sent).toEqual([])
    bridge.transcript.path = known
    await due()
    expect(sent).toHaveLength(1)
  })

  test('an owner post or a terminal prompt starts the quiet time again', async () => {
    const { bridge, sent, owner, job, due } = jobBridge()
    await job('j1', '/every 1m\ndo it')
    bridge.quietMs = 60_000
    bridge.mailbox.ownerInputAt = 0
    const prompts = () => sent.filter(note => note.method === 'notifications/claude/channel')
    bridge.permissions.set('abcde', 'p')
    await owner('x', 'yes abcde')
    await due()
    expect(prompts()).toEqual([])
    bridge.mailbox.ownerInputAt = 0
    bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: 'from the terminal' })
    bridge.mailbox.turnFailed()
    await due()
    expect(prompts()).toEqual([])
    bridge.mailbox.ownerInputAt = 0
    await due()
    expect(prompts()).toHaveLength(1)
  })

  test('a deleted job post deletes the job and tells the owner in the channel', async () => {
    const { bridge, sent, posts, posted, statePath, job, due } = jobBridge()
    await job('j1', '/every 1m\ndo it')
    posts.delete('j1')
    await due()
    expect(bridge.job).toBeUndefined()
    expect(existsSync(statePath)).toBe(false)
    expect(sent).toEqual([])
    expect(posted.at(-1)).toEqual({ message: '@o :warning: The job is deleted: the job post was deleted.', root: '' })
    await job('j2', '/every 1m\ndo it')
    posts.set('j2', { ...posts.get('j2'), delete_at: 5 })
    await due()
    expect(bridge.job).toBeUndefined()
  })

  test('a job post of a different author, of a different channel or of a webhook deletes the job', async () => {
    for (const fields of [{ user_id: 'x' }, { channel_id: 'd' }, { props: { from_webhook: 'true' } }, { type: 'system_x' }, { root_id: 'r' }]) {
      const { bridge, sent, posts, posted, job, due } = jobBridge()
      await job('j1', '/every 1m\ndo it')
      posts.set('j1', { ...posts.get('j1'), ...fields })
      await due()
      expect(bridge.job).toBeUndefined()
      expect(sent).toEqual([])
      expect(posted.at(-1)!.message).toContain('is not a post of the owner in the channel of the session')
    }
  })

  test('changed steps of the job post go to the next run, with a note in the thread', async () => {
    const { bridge, sent, posts, posted, job, due } = jobBridge()
    await job('j1', '/every 1m\ndo it')
    posts.set('j1', { ...posts.get('j1'), message: '/every 1m\ndo the new task\n/clear', edit_at: 7 })
    await due()
    expect(posted.at(-1)).toEqual({ message: 'The job post changed. The job is now: each 1m, 2 steps.', root: 'j1' })
    expect(sent).toHaveLength(1)
    expect(sent[0].params.content).toBe('do the new task')
    expect(bridge.job.editAt).toBe(7)
  })

  test('a changed line 1 of the job post starts no run, and the model reads the new schedule', async () => {
    const { bridge, sent, posts, posted, statePath, job, due, answer } = jobBridge()
    await job('j1', '/every 1m\ndo it')
    posts.set('j1', { ...posts.get('j1'), message: '/every 2 hours\ndo it', edit_at: 7 })
    const before = Date.now()
    await due()
    expect(readState(statePath)).toEqual({ postId: 'j1', editAt: 7, paused: false })
    expect(sent).toHaveLength(1)
    expect(sent[0].params.content).toContain('\n2 hours\n')
    expect(bridge.run.schedule).toEqual({ text: '2 hours', steps: 1 })
    await answer({ triggers: [{ every: '2h' }] })
    expect(posted.at(-1)).toEqual({ message: expect.stringContaining(':alarm_clock: Job: each 2h, 1 step. Next run: '), root: 'j1' })
    expect(posted.at(-1)!.message).not.toContain('replaces')
    expect(bridge.job.schedule.due[0]).toBeGreaterThanOrEqual(before + 7_200_000)
    await bridge.jobTick()
    expect(sent).toHaveLength(1)
  })

  test('the event of an edit changes the job at once, and only for the job post', async () => {
    const { bridge, sent, posts, posted, job } = jobBridge()
    await job('j1', '/every 1m\ndo it')
    posted.length = 0
    const edit = async (fields: object) => {
      const edited = { ...posts.get('j1'), ...fields }
      if (edited.id === 'j1') posts.set('j1', edited)
      bridge.onEvent({ event: 'post_edited', data: { post: JSON.stringify(edited) } })
      await bridge.inbound
      await bridge.out
    }
    await edit({ id: 'other', message: '/every day at 9\ndo it', edit_at: 5 })
    expect(bridge.job.schedule.text).toBe('1m')
    await edit({ message: '/every 1m\ndo more', edit_at: 6 })
    expect(posted).toEqual([{ message: 'The job post changed. The job is now: each 1m, 1 step.', root: 'j1' }])
    expect(sent).toEqual([])
    await edit({ message: '/every day at 9\ndo more', edit_at: 7 })
    expect(bridge.job.schedule).toBeUndefined()
    expect(bridge.job.editAt).toBe(7)
    expect(sent).toHaveLength(1)
    expect(sent[0].params.content).toContain('\nday at 9\n')
    // A second edit during the request: the old request ends, and the new one waits for the end of the turn.
    const old = bridge.run.id
    bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: promptOf(sent[0]) })
    await edit({ message: '/every day at 10\ndo more', edit_at: 8 })
    expect(bridge.run.schedule.text).toBe('day at 10')
    expect(sent).toHaveLength(1)
    await expect(bridge.callTool('schedule', { request_id: old, triggers: [{ times: ['09:00'] }] })).rejects.toThrow('no request for a schedule')
    bridge.onHook({ hook_event_name: 'Stop', last_assistant_message: '' })
    bridge.mailbox.wait('Stop', '', () => {})
    expect(sent).toHaveLength(2)
    expect(sent[1].params.content).toContain('\nday at 10\n')
    // A read of the post from before the last edit changes nothing.
    bridge.applyRead(bridge.job, { job: { text: 'day at 9', steps: [{ prompt: 'x' }] }, editAt: 7 })
    expect(bridge.run.schedule.text).toBe('day at 10')
  })

  test('/start keeps the job stopped when the state file is not written', async () => {
    const { bridge, posted, owner, job } = jobBridge()
    await job('j1', '/every 1m\ndo it')
    await owner('p', '/stop')
    bridge.jobPath = '/dev/null/schedules/b.json'
    await owner('u', '/start')
    expect(bridge.job.paused).toBe(true)
    expect(posted.at(-1)!.message).toBe('@o :warning: The job stays stopped: the state file was not written.')
  })

  test('a changed job post that is not correct stops the job, and /start reads it again', async () => {
    const { bridge, sent, posts, posted, statePath, owner, job, due } = jobBridge()
    await job('j1', '/every 1m\ndo it')
    posts.set('j1', { ...posts.get('j1'), message: '/every 1m', edit_at: 7 })
    await due()
    expect(sent).toEqual([])
    expect(readState(statePath)!.paused).toBe(true)
    expect(posted.at(-1)).toEqual({ message: expect.stringContaining('@o :warning: The job post is not correct: the job has no steps. Line 1 is the schedule, and the steps start on line 2. The job is stopped.'), root: 'j1' })
    await owner('u', '/start')
    expect(bridge.job.paused).toBe(true)
    expect(posted.at(-1)!.message).toContain('The job stays stopped: the job post is not correct')
    posts.set('j1', { ...posts.get('j1'), message: '/every 1m\ndo it again', edit_at: 8 })
    await owner('u2', '/start')
    expect(bridge.job.paused).toBe(false)
    expect(bridge.job.editAt).toBe(8)
    await due()
    expect(sent[0].params.content).toBe('do it again')
  })

  test('/start with a read of the post from before an edit keeps the job stopped', async () => {
    const { bridge, posts, posted, owner, job } = jobBridge()
    await job('j1', '/every 1m\ndo it')
    await owner('p', '/stop')
    bridge.job.editAt = 9
    posts.set('j1', { ...posts.get('j1'), edit_at: 8 })
    await owner('u', '/start')
    expect(bridge.job.paused).toBe(true)
    expect(posted.at(-1)!.message).toContain('the job post changed during the command')
  })

  test('/start with a changed line 1 asks the model for the new schedule', async () => {
    const { bridge, sent, posts, posted, owner, job, answer } = jobBridge()
    await job('j1', '/every 1m\ndo it')
    await owner('p', '/stop')
    posts.set('j1', { ...posts.get('j1'), message: '/every day at 9\ndo it', edit_at: 8 })
    await owner('u', '/start')
    expect(posted.at(-1)!.message).toBe('@o :white_check_mark: The job runs again when the model has read the schedule.')
    expect(bridge.job.schedule).toBeUndefined()
    expect(sent).toHaveLength(1)
    await answer({ triggers: [{ times: ['09:00'] }] })
    expect(posted.at(-1)).toEqual({ message: expect.stringContaining(':alarm_clock: Job: each day at 09:00 (UTC), 1 step. Next run: '), root: 'j1' })
    expect(bridge.job.paused).toBe(false)
  })

  test('a model that gives no schedule, or an error, stops the job, and /start asks again', async () => {
    const { bridge, sent, posted, statePath, owner, turn, answer } = jobBridge()
    await owner('j1', '/every now and then\ndo it')
    await turn(sent[0], 'I do not know.')
    expect(posted.at(-2)).toEqual({ message: 'I do not know.', root: 'j1' })
    expect(posted.at(-1)).toEqual({
      message: '@o :warning: The job is stopped: the model did not give the schedule. If line 1 of the job post is not clear, correct it. Then send `/start`.',
      root: 'j1',
    })
    expect(readState(statePath)).toEqual({ postId: 'j1', editAt: 0, paused: true })
    expect(bridge.run).toBeUndefined()
    await bridge.jobTick()
    expect(sent).toHaveLength(1)
    await owner('u', '/start')
    expect(sent).toHaveLength(2)
    posted.length = 0
    await answer({ error: 'The text gives no interval and no time.', triggers: [] })
    expect(posted).toEqual([
      {
        message: '@o :warning: The job is stopped: the model cannot read the schedule `now and then`: The text gives no interval and no time. If line 1 of the job post is not clear, correct it. Then send `/start`.',
        root: 'j1',
      },
    ])
    expect(bridge.job.paused).toBe(true)
    expect(bridge.job.schedule).toBeUndefined()
  })

  test('the tool refuses triggers that are not correct, a request_id that is not open, and a call with no request', async () => {
    const { bridge, sent, owner } = jobBridge()
    await expect(bridge.callTool('schedule', { request_id: 'x', triggers: [{ every: '1m' }] })).rejects.toThrow('no request for a schedule')
    await owner('j1', '/every minute\ndo it')
    const request_id = sent[0].params.meta.run_id
    await expect(bridge.callTool('schedule', { request_id: 'other', triggers: [{ every: '1m' }] })).rejects.toThrow('no request for a schedule')
    await expect(bridge.callTool('schedule', { request_id })).rejects.toThrow('one trigger or more')
    await expect(bridge.callTool('schedule', { request_id, triggers: [{ every: '1 minute' }] })).rejects.toThrow('a number and a unit')
    expect(bridge.job.schedule).toBeUndefined()
    expect(await bridge.callTool('schedule', { request_id, triggers: [{ every: '1m' }] })).toContain('The schedule is set')
    expect(bridge.job.schedule.triggers).toEqual([{ every: '1m' }])
    // A run of the steps is not a request for a schedule.
    const second = jobBridge()
    await second.job('j1', '/every 1m\ndo it')
    await second.due()
    await expect(second.bridge.callTool('schedule', { request_id: second.bridge.run.id, triggers: [{ every: '2m' }] })).rejects.toThrow('no request for a schedule')
  })

  test('a request for the schedule that starts no turn, or with a turn that fails, stops the job', async () => {
    for (const end of ['no turn', 'StopFailure', 'interrupt']) {
      const { bridge, sent, posted, path, owner } = jobBridge()
      bridge.promptStartMs = 20
      await owner('j1', '/every 1m\ndo it')
      if (end === 'no turn') await Bun.sleep(60)
      else {
        bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: promptOf(sent[0]), transcript_path: path })
        if (end === 'StopFailure') bridge.onHook({ hook_event_name: 'StopFailure', error: 'overloaded' })
        else {
          appendFileSync(path, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } })}\n`)
          await bridge.transcriptTick()
        }
      }
      await bridge.out
      const cause = { 'no turn': 'the prompt of step 1 started no turn in 0 seconds', StopFailure: 'the turn stopped with an error: overloaded', interrupt: 'the turn was interrupted at the terminal' }[end]
      expect(posted).toEqual([{ message: `@o :warning: The job is stopped: the model did not give the schedule: ${cause}. If line 1 of the job post is not clear, correct it. Then send \`/start\`.`, root: 'j1' }])
      expect(bridge.job.paused).toBe(true)
      expect(bridge.job.lastRun).toBeUndefined()
      expect(bridge.run).toBeUndefined()
      expect(bridge.mailbox.busy).toBe(false)
    }
  })

  test('the request for the schedule waits for the end of a turn, and does not wait for the quiet time', async () => {
    const { bridge, sent, reactions, owner } = jobBridge()
    bridge.quietMs = 60_000
    bridge.mailbox.turnStarted()
    await owner('j1', '/every 1m\ndo it')
    expect(sent).toEqual([])
    expect(reactions).toEqual(['j1 hourglass_flowing_sand'])
    expect(bridge.run.schedule.text).toBe('1m')
    bridge.mailbox.wait('Stop', '', () => {})
    expect(sent).toHaveLength(1)
    expect(bridge.mailbox.busy).toBe(true)
  })

  test('a session that is not ready gets the request for the schedule at a later tick', async () => {
    const { bridge, sent, reactions, owner } = jobBridge()
    bridge.commandRunning = true
    await owner('j1', '/every 1m\ndo it')
    expect(bridge.run).toBeUndefined()
    expect(reactions).toEqual(['j1 hourglass_flowing_sand'])
    await bridge.jobTick()
    expect(sent).toEqual([])
    bridge.commandRunning = false
    await bridge.jobTick()
    expect(sent).toHaveLength(1)
    await bridge.jobTick()
    expect(sent).toHaveLength(1)
  })

  test('a state file of the old form: the model reads the schedule one time, and a post of the old form on one line stops the job', async () => {
    const { bridge, sent, posts, statePath, answer } = jobBridge()
    posts.set('j1', { id: 'j1', channel_id: 'c', user_id: 'o', root_id: '', create_at: 1, type: '', message: '/every 30m\ndo it' })
    writeFileSync(statePath.replace(/schedules.*/, 'old.json'), JSON.stringify({ postId: 'j1', editAt: 0, nextAt: Date.now() + 500_000, paused: false }))
    bridge.job = readState(statePath.replace(/schedules.*/, 'old.json'))
    await bridge.jobTick()
    expect(sent).toHaveLength(1)
    expect(sent[0].params.content).toContain('\n30m\n')
    await answer({ triggers: [{ every: '30m' }] })
    expect(readState(statePath)!.schedule!.triggers).toEqual([{ every: '30m' }])
    await bridge.jobTick()
    expect(sent).toHaveLength(1)

    const old = jobBridge()
    old.posts.set('j1', { id: 'j1', channel_id: 'c', user_id: 'o', root_id: '', create_at: 1, type: '', message: '/every 30m do it' })
    old.bridge.job = { postId: 'j1', editAt: 0, paused: false }
    await old.bridge.jobTick()
    await old.bridge.out
    expect(old.sent).toEqual([])
    expect(old.bridge.job.paused).toBe(true)
    expect(old.posted.at(-1)!.message).toContain('@o :warning: The job post is not correct: the job has no steps.')
  })

  test('no run while Mattermost does not give the job post, and the job stays', async () => {
    const { bridge, sent, posts, posted, job, due } = jobBridge()
    await job('j1', '/every 1m\ndo it')
    const made = posts.get('j1')
    posts.set('j1', 'down')
    posted.length = 0
    await due()
    expect(sent).toEqual([])
    expect(posted).toEqual([])
    expect(bridge.job.paused).toBe(false)
    posts.set('j1', made)
    await bridge.jobTick()
    expect(sent).toHaveLength(1)
  })

  test('a time of the day that is more than 1 hour late starts no run, also while the session is busy, and tells the owner in the thread', async () => {
    for (const busy of [false, true]) {
      const { bridge, sent, posted, statePath, job, due } = jobBridge()
      await job('j1', '/every day at 14 and 20\ndo it', [{ times: ['14:00', '20:00'] }])
      posted.length = 0
      if (busy) bridge.mailbox.turnStarted()
      const late = Date.now() - 3_700_000
      await due(late)
      await bridge.out
      expect(sent).toEqual([])
      expect(posted).toEqual([{ message: expect.stringMatching(/^The run of \d{4}-\d\d-\d\d \d\d:\d\d UTC did not start: it was more than 1 hour late\.$/), root: 'j1' }])
      const next = readState(statePath)!.schedule!.due[0]!
      expect(next).toBeGreaterThan(late)
      expect(bridge.run).toBeUndefined()
      // A time that is less than 1 hour late starts a run when the session is free.
      await due(Date.now() - 3_000_000)
      expect(sent).toHaveLength(busy ? 0 : 1)
      expect(posted).toHaveLength(1)
    }
  })

  test('an interval that is more than 1 hour late starts a run', async () => {
    const { sent, posted, job, due } = jobBridge()
    await job('j1', '/every 1m\ndo it')
    posted.length = 0
    await due(Date.now() - 7_200_000)
    expect(sent).toHaveLength(1)
    expect(posted).toEqual([])
  })

  test('a command that is not typed stops the run and keeps the job, and only the first failure has a mention', async () => {
    const { bridge, sent, posted, statePath, job, due } = jobBridge()
    await job('j1', '/every 1m\n/clear\ndo it')
    bridge.typeText = async () => {
      throw new Error('Operation not permitted')
    }
    for (const mention of ['@o ', '']) {
      await due()
      await bridge.commandDone
      await bridge.out
      expect(posted.at(-1)).toEqual({ message: `${mention}:warning: The run of the job stopped: \`/clear\` was not typed in the terminal: Operation not permitted. The job stays.`, root: 'j1' })
      expect(sent).toEqual([])
      expect(bridge.run).toBeUndefined()
      expect(bridge.mailbox.busy).toBe(false)
      expect(bridge.commandRunning).toBe(false)
    }
    expect(readState(statePath)!.lastRun!.result).toContain('was not typed')
    expect(bridge.job.paused).toBe(false)
  })

  test('a prompt that starts no turn stops the run, and a good run gives the next failure a mention again', async () => {
    const { bridge, sent, posted, job, due, turn } = jobBridge()
    await job('j1', '/every 1m\ndo it\n/clear')
    bridge.promptStartMs = 20
    for (const mention of ['@o ', '']) {
      await due()
      await Bun.sleep(60)
      await bridge.out
      expect(posted.at(-1)).toEqual({ message: `${mention}:warning: The run of the job stopped: the prompt of step 1 started no turn in 0 seconds. The job stays.`, root: 'j1' })
      expect(bridge.mailbox.busy).toBe(false)
      expect(bridge.run).toBeUndefined()
    }
    bridge.promptStartMs = 30_000
    await due()
    await turn(sent.at(-1), 'done')
    appendFileSync(bridge.transcript.path, stdout(''))
    await bridge.commandDone
    expect(bridge.job.lastRun.result).toBe('ok')
    bridge.promptStartMs = 20
    await due()
    await Bun.sleep(60)
    await bridge.out
    expect(posted.at(-1)!.message).toStartWith('@o :warning: The run of the job stopped')
  })

  test('a turn from the terminal that starts in the wait for the prompt is not made free by the time limit', async () => {
    const { bridge, job, due } = jobBridge()
    await job('j1', '/every 1m\ndo it')
    bridge.promptStartMs = 20
    await due()
    bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: 'from the terminal' })
    await Bun.sleep(60)
    expect(bridge.run).toBeUndefined()
    expect(bridge.mailbox.busy).toBe(true)
  })

  test('a prompt that is not sent stops the run', async () => {
    const { bridge, posted, job, due } = jobBridge()
    await job('j1', '/every 1m\ndo it')
    bridge.mcp.notification = async () => {
      throw new Error('closed')
    }
    await due()
    await Bun.sleep(0)
    await bridge.out
    expect(posted.at(-1)!.message).toContain('the prompt of step 1 was not sent: closed')
    expect(bridge.promptWait).toBeUndefined()
    expect(bridge.mailbox.busy).toBe(false)
  })

  test('StopFailure and an interrupt in a job turn stop the run, and the next step does not start', async () => {
    for (const end of ['StopFailure', 'interrupt']) {
      const { bridge, sent, posted, path, job, due } = jobBridge()
      await job('j1', '/every 1m\none\n/clear\ntwo')
      await due()
      bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: promptOf(sent[0]), transcript_path: path })
      if (end === 'StopFailure') bridge.onHook({ hook_event_name: 'StopFailure', error: 'overloaded' })
      else {
        appendFileSync(path, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } })}\n`)
        await bridge.transcriptTick()
      }
      await bridge.out
      expect(posted.at(-1)!.root).toBe('j1')
      expect(posted.at(-1)!.message).toContain(end === 'StopFailure' ? 'the turn stopped with an error: overloaded' : 'the turn was interrupted at the terminal')
      expect(posted).toHaveLength(2)
      expect(bridge.run).toBeUndefined()
      expect(bridge.mailbox.busy).toBe(false)
      expect(bridge.commandRunning).toBe(false)
      expect(bridge.job.postId).toBe('j1')
      expect(bridge.job.paused).toBe(false)
    }
  })

  test('/stop cancels the steps of a run that did not start, and /drop deletes the job and its file', async () => {
    const { bridge, sent, posted, typed, path, statePath, owner, job, due, turn } = jobBridge()
    await job('j1', '/every 1m\none\n/clear\ntwo')
    await due()
    bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: promptOf(sent[0]), transcript_path: path })
    await owner('p', '/stop')
    expect(bridge.mailbox.busy).toBe(true)
    await turn(sent[0], 'one is done')
    expect(typed).toEqual([])
    expect(sent).toHaveLength(1)
    expect(bridge.mailbox.busy).toBe(false)
    expect(readState(statePath)!.paused).toBe(true)
    await owner('d', '/drop')
    expect(bridge.job).toBeUndefined()
    expect(existsSync(statePath)).toBe(false)
    expect(posted.at(-1)!.message).toBe('@o :white_check_mark: The job is deleted.')
  })

  test('/stop during the request for the schedule: the tool call of the model sets nothing', async () => {
    const { bridge, sent, path, owner } = jobBridge()
    await owner('j1', '/every 1m\ndo it')
    bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: promptOf(sent[0]), transcript_path: path })
    await owner('p', '/stop')
    await expect(bridge.callTool('schedule', { request_id: sent[0].params.meta.run_id, triggers: [{ every: '1m' }] })).rejects.toThrow('no request for a schedule')
    expect(bridge.job.schedule).toBeUndefined()
    expect(bridge.job.paused).toBe(true)
  })

  test('/drop during a command step: the output frees the session and no step follows', async () => {
    const { bridge, sent, path, owner, job, due } = jobBridge()
    await job('j1', '/every 1m\n/clear\ntwo')
    await due()
    await owner('d', '/drop')
    appendFileSync(path, stdout(''))
    await bridge.commandDone
    expect(sent).toEqual([])
    expect(bridge.mailbox.busy).toBe(false)
  })

  test('an owner post goes between two steps, and its answer has the mention', async () => {
    const { bridge, sent, posted, path, owner, job, due, turn } = jobBridge()
    await job('j1', '/every 1m\none\n/clear\ntwo')
    posted.length = 0
    await due()
    bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: promptOf(sent[0]), transcript_path: path })
    await owner('x', 'a question')
    await turn(sent[0], 'one is done')
    await Bun.sleep(0)
    expect(sent.map(note => note.params.content)).toEqual(['one', 'a question'])
    expect(sent[1].params.meta.thread_id).toBeUndefined()
    await turn(sent[1], 'the answer')
    expect(posted.at(-1)).toEqual({ message: '@o the answer', root: '' })
    expect(bridge.run.inCommand).toBe(true)
  })

  test('an owner post in the thread of the job post gets its answer in that thread, with the mention', async () => {
    const { sent, posted, owner, job, turn } = jobBridge()
    await job('j1', '/every 1m\ndo it')
    await owner('x', 'why?', { root_id: 'j1' })
    await owner('y', 'other thread', { root_id: 'r' })
    expect(sent[0].params.meta.thread_id).toBe('j1')
    await turn(sent[0], 'because')
    expect(posted.at(-1)).toEqual({ message: '@o because', root: 'j1' })
    await Bun.sleep(0)
    expect(sent[1].params.meta.thread_id).toBeUndefined()
  })

  test('a new session with the same state file runs a missed job one time', async () => {
    const first = jobBridge()
    await first.job('j1', '/every 1m\ndo it')
    first.bridge.job.schedule.due = [Date.now() - 200_000]
    first.bridge.saveJob()
    const { bridge, sent, posts, turn } = jobBridge(first.statePath)
    posts.set('j1', first.posts.get('j1'))
    bridge.job = readState(first.statePath)
    const before = Date.now()
    await bridge.jobTick()
    expect(sent).toHaveLength(1)
    expect(readState(first.statePath)!.schedule!.due[0]).toBeGreaterThanOrEqual(before + 60_000)
    await turn(sent[0], 'done')
    await bridge.jobTick()
    expect(sent).toHaveLength(1)
  })

  test('a run sets the count of agent posts to 0', async () => {
    const { bridge, job, due } = jobBridge()
    await job('j1', '/every 1m\ndo it')
    for (let i = 0; i < LOOP_LIMIT; i++) bridge.mailbox.offer(`m${i}`)
    expect(bridge.mailbox.offer('over')).toBe(false)
    await due()
    expect(bridge.mailbox.offer('again')).toBe(true)
  })

  test('send works in a job step that follows a task from an agent', async () => {
    const { bridge, job, due } = jobBridge()
    bridge.send = async () => 'sent'
    await job('j1', '/every 1m\ndo it')
    bridge.mailbox.agentTask = true
    await due()
    expect(await bridge.callTool('send', { to: 'x-cc', text: 'do it' })).toBe('sent')
  })

  describe('the start post', () => {
    async function started(change: (first: ReturnType<typeof jobBridge>) => void) {
      const first = jobBridge()
      await first.job('j1', '/every 30m\ndo it')
      first.bridge.job.schedule.due = [Date.UTC(2026, 0, 2, 3, 34)]
      change(first)
      const second = jobBridge()
      const { bridge, posts } = second
      posts.set('j1', first.posts.get('j1'))
      bridge.job = first.bridge.job
      const calls: string[] = []
      const api = bridge.api.api
      bridge.api.api = async (method: string, url: string, body: any) => {
        if (method !== 'GET') calls.push(`${method} ${url} ${body.message}`)
        return method === 'GET' ? api(method, url, body) : { id: 'start' }
      }
      bridge.startPost = { text: 'Session started' }
      bridge.showStart()
      await bridge.showJobAtStart(bridge.job)
      await bridge.out
      return { ...second, calls }
    }

    test('shows the job', async () => {
      const { calls, sent } = await started(() => {})
      expect(calls).toEqual(['POST /posts Session started', 'PUT /posts/start/patch Session started\n:alarm_clock: Job: each 30m, 1 step. Next run: 2026-01-02 03:34 UTC'])
      expect(sent).toEqual([])
    })

    test('the job line comes before the follow line', async () => {
      const { bridge, calls } = await started(() => {})
      bridge.follow = { from: ['b-cc'], purpose: 'p', report: false }
      bridge.showStart()
      await bridge.out
      expect(calls.at(-1)).toBe('PUT /posts/start/patch Session started\n:alarm_clock: Job: each 30m, 1 step. Next run: 2026-01-02 03:34 UTC\n:eyes: Follows @b-cc: p')
    })

    test('shows a job with a post that Mattermost did not give', async () => {
      const { bridge, calls } = await started(() => {})
      const api = bridge.api.api
      bridge.api.api = async (method: string, url: string, body: any) => {
        if (method === 'GET') throw new Error('down')
        return api(method, url, body)
      }
      await bridge.showJobAtStart(bridge.job)
      await bridge.out
      expect(calls.at(-1)).toBe('PUT /posts/start/patch Session started\n:alarm_clock: Job: each 30m. Next run: 2026-01-02 03:34 UTC')
    })

    test('shows a stopped job', async () => {
      const { calls } = await started(first => (first.bridge.job.paused = true))
      expect(calls.at(-1)).toBe('PUT /posts/start/patch Session started\n:alarm_clock: Job: each 30m, 1 step. Stopped')
    })

    test('a line 1 that changed while the session was stopped goes to the model', async () => {
      const { bridge, calls, sent } = await started(first => first.posts.set('j1', { ...first.posts.get('j1'), message: '/every day at 9\ndo it', edit_at: 9 }))
      expect(calls.at(-1)).toBe('PUT /posts/start/patch Session started\n:alarm_clock: Job: `day at 9`, 1 step. The model reads the schedule')
      expect(bridge.job.schedule).toBeUndefined()
      expect(sent).toHaveLength(1)
      expect(sent[0].params.content).toContain('\nday at 9\n')
    })
  })
})

describe('Socket liveness', () => {
  async function connected(): Promise<{ socket: any; opens: () => number; actions: string[]; stop: () => void }> {
    let count = 0
    const actions: string[] = []
    const server = Bun.serve({
      port: 0,
      fetch: (req, s) => (s.upgrade(req) ? undefined : new Response('no')),
      websocket: {
        open() {
          count++
        },
        message(_ws, raw) {
          actions.push(JSON.parse(String(raw)).action)
        },
      },
    })
    const socket: any = new Socket(`http://localhost:${server.port}`, 't', () => {}, () => {})
    socket.start()
    while (socket.ws.readyState !== WebSocket.OPEN) await Bun.sleep(10)
    return { socket, opens: () => count, actions, stop: () => (socket.stop(), server.stop(true)) }
  }

  async function opensAfter(check: (socket: any) => void): Promise<number> {
    const s = await connected()
    check(s.socket)
    s.socket.check()
    await Bun.sleep(200)
    s.stop()
    return s.opens()
  }

  test('a live connection sends ping', async () => {
    const s = await connected()
    s.socket.check()
    await Bun.sleep(100)
    s.stop()
    expect(s.actions).toEqual(['authentication_challenge', 'ping', 'ping'])
    expect(s.opens()).toBe(1)
  })

  test('no message for too long gives a new connection', async () => {
    expect(await opensAfter(socket => (socket.lastMessage = Date.now() - 80_000))).toBe(2)
  })

  test('a late tick after sleep gives a new connection', async () => {
    expect(await opensAfter(socket => (socket.lastTick = Date.now() - 120_000))).toBe(2)
  })
})

test('since is the server time of the last pong before the reconnect', async () => {
  let opens = 0
  const server = Bun.serve({
    port: 0,
    fetch: (req, s) => (s.upgrade(req) ? undefined : new Response('no')),
    websocket: {
      open() {
        opens++
      },
      message(ws, raw) {
        const message = JSON.parse(String(raw))
        if (message.action === 'ping') ws.send(JSON.stringify({ status: 'OK', seq_reply: message.seq, data: { text: 'pong', server_time: opens * 100 } }))
      },
    },
  })
  const socket: any = new Socket(`http://localhost:${server.port}`, 't', () => {}, () => {})
  socket.start()
  while (socket.serverTime !== 100) await Bun.sleep(10)
  expect(socket.since).toBeUndefined()
  socket.lastMessage = 0
  socket.check()
  while (socket.serverTime !== 200) await Bun.sleep(10)
  expect(socket.since).toBe(100)
  socket.stop()
  server.stop(true)
})

describe('sender of an agent post', () => {
  test('only a post from a session bot goes to the model, with one user request for each sender', async () => {
    const users: Record<string, object> = {
      person: { username: 'eve-cc', is_bot: false, delete_at: 0 },
      session: { username: 'ai-pi', is_bot: true, delete_at: 0 },
      otherbot: { username: 'jenkins', is_bot: true, delete_at: 0 },
      gone: { username: 'old-cc', is_bot: true, delete_at: 5 },
    }
    const got: string[] = []
    const requests: string[] = []
    const bridge = new Bridge({} as any) as any
    bridge.id = { botId: 'bot', channelId: 'session', username: 'ai-cc' }
    bridge.config = { ownerId: 'owner' }
    bridge.api = {
      api: async (_method: string, path: string) => {
        requests.push(path)
        return users[path.split('/')[2]!]
      },
    }
    bridge.fromAgent = async (p: Post) => got.push(p.id)
    for (const user_id of Object.keys(users)) {
      for (const n of [1, 2]) await bridge.onPost(post({ id: `${user_id}${n}`, user_id }), 'O', [])
    }
    expect(got).toEqual(['session1', 'session2'])
    expect(requests).toEqual(['/users/person', '/users/session', '/users/otherbot', '/users/gone'])
    expect(bridge.names.get('session')).toBe('ai-pi')
  })
})

describe('pull of missed posts', () => {
  function bridgeWith(pages: Record<string, Partial<Post>[]>): { bridge: any; got: string[]; paths: string[] } {
    const got: string[] = []
    const paths: string[] = []
    const bridge = new Bridge({} as any) as any
    bridge.id = { botId: 'bot', channelId: 'c', agentsChannelId: 'a', username: 'ai-cc', ownerUsername: 'o' }
    bridge.config = { ownerId: 'owner' }
    bridge.ws = { since: 100 }
    bridge.threadChannels.add('t')
    bridge.api = {
      api: async (_method: string, path: string) => {
        if (path === '/users/x') return { username: 'x-cc', is_bot: true, delete_at: 0 }
        paths.push(path)
        if (path === '/channels/direct') return { id: 'd' }
        const channel = /^\/channels\/(\w+)\/posts/.exec(path)![1]!
        const list = (pages[channel] ?? []).map(p => post({ channel_id: channel, ...p }))
        return { order: list.map(p => p.id), posts: Object.fromEntries(list.map(p => [p.id, p])) }
      },
    }
    bridge.fromOwner = async (p: Post) => got.push(`owner ${p.id}`)
    bridge.fromAgent = async (p: Post) => got.push(`agent ${p.id}`)
    return { bridge, got, paths }
  }

  test('a hello after a reconnect delivers the missed posts in time order, once', async () => {
    const { bridge, got, paths } = bridgeWith({
      c: [{ id: 'late', user_id: 'owner', create_at: 300 }, { id: 'old', user_id: 'owner', create_at: 100 }, { id: 'gone', user_id: 'owner', create_at: 150, delete_at: 160 }],
      a: [{ id: 'mention', user_id: 'x', message: 'hi @ai-cc', create_at: 250 }, { id: 'other', user_id: 'x', message: 'hi', create_at: 260 }],
      d: [{ id: 'dm', user_id: 'owner', create_at: 200 }],
      t: [{ id: 'live', user_id: 'x', root_id: 'r', create_at: 120 }],
    })
    bridge.threads.add('r')
    bridge.seen.set('live', 120)
    bridge.onEvent({ event: 'hello', data: {} })
    await bridge.inbound
    expect(got).toEqual(['owner dm', 'agent mention', 'owner late'])
    expect(paths).toContain('/channels/t/posts?since=100')
  })

  test('the first hello pulls nothing', async () => {
    const { bridge, paths } = bridgeWith({})
    bridge.ws = { since: undefined }
    bridge.onEvent({ event: 'hello', data: {} })
    await bridge.inbound
    expect(paths).toEqual([])
  })
})

describe('channel agents and follow', () => {
  const assistant = (text: string) => `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })}\n`
  const promptOf = (note: any) =>
    `<channel source="plugin:mattermost:mattermost" ${Object.entries(note.params.meta).map(([key, value]) => `${key}="${value}"`).join(' ')}>\n${note.params.content}\n</channel>`

  function agentsBridge() {
    const sent: any[] = []
    const bridge = new Bridge({ notification: async (note: any) => sent.push(note) } as any) as any
    bridge.id = { botId: 'bot', channelId: 'c', agentsChannelId: 'ag', username: 'ai-cc', ownerUsername: 'o' }
    bridge.config = { ownerId: 'owner' }
    bridge.reactionDelayMs = 0
    bridge.followPath = join(mkdtempSync(join(tmpdir(), 'mm-follow-')), 'follows', 'bot.json')
    const users: Record<string, object> = {
      owner: { username: 'o', is_bot: false, delete_at: 0 },
      b: { username: 'b-cc', is_bot: true, delete_at: 0 },
      d: { username: 'd-pi', is_bot: true, delete_at: 0 },
      person: { username: 'eve-cc', is_bot: false, delete_at: 0 },
    }
    const stored = new Map<string, any>()
    const posted: { channel: string; message: string; root: string }[] = []
    const reactions: string[] = []
    const calls: string[] = []
    bridge.api = {
      api: async (method: string, url: string, body: any) => {
        calls.push(`${method} ${url}`)
        if (method === 'GET' && url.startsWith('/users/')) return users[url.split('/')[2]!]
        if (url.startsWith('/channels/ag/members')) return Object.keys(users).map(user_id => ({ user_id }))
        if (url === '/users/ids') return body.map((key: string) => ({ id: key, ...users[key] }))
        if (method === 'GET' && url.startsWith('/posts/')) return stored.get(url.slice('/posts/'.length))
        if (url.split('?')[0] === '/posts') {
          posted.push({ channel: body.channel_id, message: body.message, root: body.root_id })
          return { id: `made${posted.length}` }
        }
        if (url === '/reactions') reactions.push(`${body.post_id} ${body.emoji_name}`)
        return {}
      },
    }
    const path = join(mkdtempSync(join(tmpdir(), 'mm-follow-')), 't.jsonl')
    writeFileSync(path, '')
    const texts: string[] = []
    const free = () => bridge.mailbox.wait('Stop', '', (text: string) => text && texts.push(text))
    const agentPost = (fields: Partial<Post>) => post({ channel_id: 'ag', user_id: 'b', ...fields })
    return { bridge, sent, stored, posted, reactions, calls, path, texts, free, agentPost }
  }

  test('send to agents makes a new post there, and the answers in its thread arrive', async () => {
    const { bridge, posted, calls } = agentsBridge()
    expect(await bridge.callTool('send', { to: 'agents', text: 'who has the key? @b-cc' })).toBe('sent (post_id: made1)')
    expect(posted).toEqual([{ channel: 'ag', message: 'who has the key? @b-cc', root: '' }])
    expect(calls.some(call => call.includes('/members'))).toBe(false)
    expect(bridge.threads.has('made1')).toBe(true)
  })

  test('reply in agents does not add the thread, so the answers of other sessions there do not arrive', async () => {
    const { bridge, stored, posted, agentPost } = agentsBridge()
    stored.set('q', agentPost({ id: 'q' }))
    bridge.delivered.add('q')
    expect(await bridge.callTool('reply', { post_id: 'q', text: 'I have it' })).toBe('sent in the thread (post_id: made1)')
    expect(posted).toEqual([{ channel: 'ag', message: 'I have it', root: 'q' }])
    expect(bridge.threads.has('q')).toBe(false)
    const got: string[] = []
    bridge.fromAgent = async (p: Post) => got.push(p.id)
    await bridge.onPost(agentPost({ id: 'r', user_id: 'd', root_id: 'q' }), 'O', [])
    expect(got).toEqual([])
    stored.set('s', post({ id: 's', channel_id: 'other', user_id: 'b' }))
    bridge.delivered.add('s')
    await bridge.callTool('reply', { post_id: 's', text: 'ok' })
    expect(bridge.threads.has('s')).toBe(true)
  })

  test('an owner post in agents with a mention starts a turn, and its texts go to the thread of the post with the mention', async () => {
    const { bridge, sent, posted, path } = agentsBridge()
    await bridge.onPost(post({ id: 'op', channel_id: 'ag', user_id: 'owner', message: '@ai-cc check the disk' }), 'O', [])
    await bridge.onPost(post({ id: 'op2', channel_id: 'ag', user_id: 'owner', message: 'no mention' }), 'O', [])
    expect(sent).toHaveLength(1)
    expect(sent[0].params.meta).toMatchObject({ channel_id: 'ag', post_id: 'op', thread_id: 'op' })
    bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: promptOf(sent[0]), transcript_path: path })
    appendFileSync(path, assistant('done'))
    bridge.onHook({ hook_event_name: 'Stop', last_assistant_message: 'done', transcript_path: path })
    await bridge.out
    expect(posted).toEqual([{ channel: 'ag', message: '@o done', root: 'op' }])
  })

  test('follow is refused in a task from an agent, checks the names, and saves the list', async () => {
    const { bridge, posted } = agentsBridge()
    bridge.mailbox.wait('Stop', '', () => {})
    bridge.mailbox.offer('a post from an agent')
    await expect(bridge.callTool('follow', { from: ['b-cc'], purpose: 'p' })).rejects.toThrow('came from an agent')
    bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: 'from the terminal' })
    await expect(bridge.callTool('follow', { from: 'b-cc', purpose: 'p' })).rejects.toThrow('must be a list')
    await expect(bridge.callTool('follow', { from: ['ai-cc'], purpose: 'p' })).rejects.toThrow('the name of this session')
    await expect(bridge.callTool('follow', { from: ['town-square'], purpose: 'p' })).rejects.toThrow('not the name of a session')
    await expect(bridge.callTool('follow', { from: ['b-cc'], purpose: ' ' })).rejects.toThrow('purpose is empty')
    expect(existsSync(bridge.followPath)).toBe(false)
    expect(await bridge.callTool('follow', { from: ['@B-cc', 'b-cc', 'd-pi'], purpose: 'report mail from the bank', report: true })).toBe('this session follows b-cc, d-pi')
    expect(readFollow(bridge.followPath)).toEqual({ from: ['b-cc', 'd-pi'], purpose: 'report mail from the bank', report: true })
    expect(await bridge.callTool('follow', { from: ['b-cc', 'x-cc', 'eve-cc'], purpose: 'p' })).toBe(
      'this session follows b-cc, x-cc, eve-cc. No session has the name x-cc, eve-cc now. Its posts arrive when a session with that name runs.',
    )
    expect(await bridge.callTool('follow', { from: ['b-cc', 'all'], purpose: 'p' })).toBe('this session follows all')
    expect(readFollow(bridge.followPath)).toEqual({ from: ['all'], purpose: 'p', report: false })
    expect(await bridge.callTool('follow', { from: [] })).toBe('this session follows no session')
    expect(existsSync(bridge.followPath)).toBe(false)
    expect(bridge.follow).toBeUndefined()
    await bridge.out
    const notes = posted.filter(entry => entry.message.startsWith(':eyes:'))
    expect(notes.map(entry => entry.channel)).toEqual(['c', 'c', 'c', 'c'])
    expect(notes[0]!.message).toContain('@b-cc, @d-pi')
    expect(notes[0]!.message).toContain('mentions the owner')
    expect(notes[0]!.message).toContain('Purpose: report mail from the bank')
    expect(notes[2]!.message).toContain('all sessions')
    expect(notes[3]!.message).toBe(':eyes: This session follows no session.')
  })

  test('the follow list comes back at the start, in the start post', async () => {
    const { bridge, posted } = agentsBridge()
    bridge.startPost = { text: 'Session started' }
    bridge.loadFollow()
    bridge.showStart()
    expect(bridge.follow).toBeUndefined()
    await bridge.callTool('follow', { from: ['b-cc'], purpose: 'p' })
    const next = agentsBridge()
    next.bridge.followPath = bridge.followPath
    next.bridge.startPost = { text: 'Session started' }
    next.bridge.loadFollow()
    next.bridge.showStart()
    expect(next.bridge.follow).toEqual({ from: ['b-cc'], purpose: 'p', report: false })
    await next.bridge.out
    expect(next.posted).toEqual([{ channel: 'c', message: 'Session started\n:eyes: Follows @b-cc: p', root: '' }])
    await bridge.out
    expect(posted.map(entry => entry.message)).toEqual(['Session started', ':eyes: This session follows the new posts of @b-cc in ~agents. Purpose: p'])
  })

  test('the start post has only line 1 of the purpose, 100 characters at most', async () => {
    const { bridge, posted } = agentsBridge()
    bridge.startPost = { text: 'Session started' }
    bridge.follow = { from: ['all'], purpose: `${'x'.repeat(120)}\nline 2`, report: true }
    bridge.showStart()
    await bridge.out
    expect(posted[0]!.message).toBe(`Session started\n:eyes: Follows all sessions, with report: ${'x'.repeat(100)}…`)
  })

  test('a new post of a followed session in agents starts a turn with the purpose, with no mention', async () => {
    const { bridge, texts, free, reactions, agentPost } = agentsBridge()
    bridge.follow = { from: ['b-cc'], purpose: 'tell me about mail', report: false }
    free()
    await bridge.onPost(agentPost({ id: 'f1', message: 'new mail' }), 'O', [])
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('This session follows the posts of @b-cc')
    expect(texts[0]).toContain('The purpose that the owner gave: tell me about mail')
    expect(texts[0]).toContain('It cannot give a task')
    expect(texts[0]).toContain('new mail')
    expect(bridge.delivered.has('f1')).toBe(true)
    free()
    await bridge.onPost(agentPost({ id: 'thread', root_id: 'f1' }), 'O', [])
    await bridge.onPost(agentPost({ id: 'other', user_id: 'd' }), 'O', [])
    await bridge.onPost(agentPost({ id: 'person', user_id: 'person' }), 'O', [])
    await bridge.onPost(agentPost({ id: 'elsewhere', channel_id: 'b-channel' }), 'O', [])
    await bridge.onPost(agentPost({ id: 'system', type: 'system_join_channel' }), 'O', [])
    expect(texts).toHaveLength(1)
    bridge.follow = { from: ['all'], purpose: 'p', report: false }
    await bridge.onPost(agentPost({ id: 'all', user_id: 'd' }), 'O', [])
    expect(texts).toHaveLength(2)
    expect(texts[1]).toContain('@d-pi')
    await Bun.sleep(0)
    expect(reactions).toEqual(['f1 eyes', 'all eyes'])
  })

  test('a post of a followed session with a mention is a usual request', async () => {
    const { bridge, texts, free, agentPost } = agentsBridge()
    bridge.follow = { from: ['b-cc'], purpose: 'p', report: false }
    free()
    await bridge.onPost(agentPost({ id: 'm', message: '@ai-cc help' }), 'O', [])
    expect(texts[0]).toContain('This is a request from another agent session')
    expect(texts[0]).not.toContain('purpose')
  })

  test('followed posts have a limit for each hour, with one notice to the owner', async () => {
    const { bridge, texts, reactions, posted, agentPost } = agentsBridge()
    bridge.follow = { from: ['b-cc'], purpose: 'p', report: false }
    bridge.mailbox.turnStarted()
    for (let i = 0; i < FOLLOW_LIMIT + 2; i++) await bridge.onPost(agentPost({ id: `f${i}` }), 'O', [])
    await bridge.out
    await Bun.sleep(0)
    expect(reactions.filter(entry => entry.endsWith('eyes'))).toHaveLength(FOLLOW_LIMIT)
    expect(reactions.filter(entry => entry.endsWith('no_entry_sign'))).toEqual([`f${FOLLOW_LIMIT} no_entry_sign`, `f${FOLLOW_LIMIT + 1} no_entry_sign`])
    expect(posted).toEqual([{ channel: 'c', message: `@o :no_entry_sign: ${FOLLOW_LIMIT} followed posts arrived in this hour. The other followed posts of this hour start no turn.`, root: '' }])
    bridge.followHour = 0
    await bridge.onPost(agentPost({ id: 'next hour' }), 'O', [])
    await Bun.sleep(0)
    expect(reactions.at(-1)).toBe('next hour eyes')
    bridge.mailbox.wait('Stop', '', (text: string) => texts.push(text))
    expect(texts[0]!.split('Mattermost post from').length - 1).toBe(FOLLOW_LIMIT + 1)
  })

  test('the last text of a turn from a followed post mentions the owner only when the follow asks for a report', async () => {
    for (const report of [true, false]) {
      const { bridge, posted, path, free, agentPost } = agentsBridge()
      bridge.follow = { from: ['b-cc'], purpose: 'p', report }
      free()
      await bridge.onPost(agentPost({ id: 'f' }), 'O', [])
      const turn = async (answer: string) => {
        bridge.onHook({ hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>x</task-notification>', transcript_path: path })
        appendFileSync(path, assistant(answer))
        bridge.onHook({ hook_event_name: 'Stop', last_assistant_message: answer, transcript_path: path })
        await bridge.out
        free()
      }
      await turn('bank mail')
      await turn('a background task ended')
      expect(posted).toEqual([
        { channel: 'c', message: report ? '@o bank mail' : 'bank mail', root: '' },
        { channel: 'c', message: 'a background task ended', root: '' },
      ])
    }
  })

  test('readFollow refuses a file that is not correct', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mm-follow-'))
    const file = (text: string) => {
      const path = join(dir, `${Math.random()}.json`)
      writeFileSync(path, text)
      return path
    }
    expect(readFollow(join(dir, 'none.json'))).toBeUndefined()
    expect(readFollow(file('x'))).toBeUndefined()
    expect(readFollow(file('{"from":[],"purpose":"p"}'))).toBeUndefined()
    expect(readFollow(file('{"from":[1],"purpose":"p"}'))).toBeUndefined()
    expect(readFollow(file('{"from":["b-cc"],"purpose":""}'))).toBeUndefined()
    expect(readFollow(file('{"from":["b-cc"],"purpose":"p","report":"yes"}'))).toEqual({ from: ['b-cc'], purpose: 'p', report: false })
  })
})
