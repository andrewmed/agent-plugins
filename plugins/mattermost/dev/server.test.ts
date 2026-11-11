import { afterEach, describe, expect, test } from 'bun:test'
import { Bridge, Mailbox, parseVerdict, terminalCommand } from '../server.ts'
import { TranscriptReader, assistantTexts, bashOutput, commandOutput, withLast, type Entry } from '../transcript.ts'
import { LOOP_LIMIT, MAX_POST, assertSendable, attachments, canReply, chunk, isNormalPost, mentionsBot, quote, route, safeFileName, sessionName, takeLock, type RouteContext } from '../session.ts'
import { Socket, botUsername, markedSession, provision, sessionMarker, type Post } from '../mattermost.ts'
import { appendFileSync, mkdtempSync, writeFileSync } from 'fs'
import { hostname, tmpdir } from 'os'
import { join } from 'path'

const ctx: RouteContext = {
  botId: 'bot',
  ownerId: 'owner',
  channelId: 'session',
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
  test('name and agent type', () => expect(botUsername('/home/user/code/ai')).toBe('ai-cc'))
  test('lowercase and permitted characters', () => expect(botUsername('/x/My Project.v2')).toBe('my-project-v2-cc'))
  test('at most 22 characters', () => {
    const name = botUsername('/x/a-very-long-repository-name-here', 'abc')
    expect(name.length).toBeLessThanOrEqual(22)
    expect(name.endsWith('-abc-cc')).toBe(true)
  })
  test('starts with a letter', () => expect(botUsername('/x/2fast')).toBe('fast-cc'))
  test('no letters', () => expect(botUsername('/x/1234')).toBe('agent-cc'))
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
})

describe('sessionName', () => {
  test('takes a bot username', () => expect(sessionName('@AI-cc')).toBe('ai-cc'))
  test('refuses other channels and paths', () => {
    expect(() => sessionName('town-square')).toThrow()
    expect(() => sessionName('../users/me-cc')).toThrow()
  })
})

describe('provision', () => {
  const config = { url: 'http://mm', team: 'home', ownerId: 'owner', user: 'provision', password: 'x' }
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
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
      if (path === '/channels') return send({ id: 'channel' }, 201)
      if (path.includes('/channels/name/gone-cc')) return send({ id: 'other', creator_id: 'someone' })
      if (path === '/users/owner') return send({ username: 'owner' })
      return send({})
    }) as typeof fetch
    return calls
  }

  const mine = { user_id: 'bot', username: 'ai-cc', display_name: 'ai', description: sessionMarker('mac', '/x/ai'), delete_at: 0 }

  test('the old token is revoked only after the setup is complete', async () => {
    const calls = stub(undefined, [mine])
    await provision(config, 'mac', '/x/ai', () => false, () => {})
    expect(calls.indexOf('POST /users/tokens/revoke')).toBeGreaterThan(calls.lastIndexOf('POST /channels'))
  })

  test('a failure in the setup keeps the old token', async () => {
    const calls = stub('POST /channels', [mine])
    await expect(provision(config, 'mac', '/x/ai', () => false, () => {})).rejects.toThrow()
    expect(calls).not.toContain('POST /users/tokens/revoke')
    expect(calls).toContain('POST /users/logout')
  })

  const gone = { user_id: 'b2', username: 'gone-cc', description: sessionMarker('mac', '/no/such/dir'), delete_at: 0 }

  test('a gone session is removed, but not a channel that its bot did not make', async () => {
    const calls = stub(undefined, [mine, gone])
    await provision(config, 'mac', '/x/ai', () => false, () => {})
    expect(calls).toContain('POST /bots/b2/disable')
    expect(calls).not.toContain('DELETE /channels/other')
  })

  test('a live session is not removed', async () => {
    const calls = stub(undefined, [mine, gone])
    await provision(config, 'mac', '/x/ai', project => project === '/no/such/dir', () => {})
    expect(calls).not.toContain('POST /bots/b2/disable')
  })

  test('a bot with the old marker of this host is removed, also when its session is live', async () => {
    const old = { user_id: 'b3', username: 'ai-claude', description: 'mm-agent host=mac session=/x/ai', delete_at: 0 }
    const other = { user_id: 'b4', username: 'ai-claude', description: 'mm-agent host=linux session=/x/ai', delete_at: 0 }
    const calls = stub(undefined, [mine, old, other])
    await provision(config, 'mac', '/x/ai', () => true, () => {})
    expect(calls).toContain('POST /bots/b3/disable')
    expect(calls).not.toContain('POST /bots/b4/disable')
    expect(calls).not.toContain('POST /bots/bot/disable')
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

  test('the end of the session removes the owner from the channel, after the end post', async () => {
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
    expect(calls).toEqual(['POST /posts :red_circle: Session ended', 'DELETE /channels/c/members/o '])
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
      await bridge.connect({}, '/x')
      await bridge.out
      expect(calls).toEqual([`POST /posts :large_green_circle: Session started on \`${hostname()}\` in \`/x\`, model \`m\``])
    })

    test('the model comes by an edit, and later values change nothing', async () => {
      const { bridge, calls } = startBridge()
      await bridge.connect({}, '/x')
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
