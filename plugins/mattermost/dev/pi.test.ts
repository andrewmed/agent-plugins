import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { hostname, tmpdir } from 'os'
import { join } from 'path'
import { PiBridge, assistantText, channelMessage, packageSource } from '../pi.ts'
import { botUsername, markedSession, sessionMarker, type Post } from '../mattermost.ts'
import { LOOP_LIMIT, readConfig, sessionName } from '../session.ts'

const FULL = ['MM_URL=https://x/', 'MM_TEAM=t', 'MM_OWNER_ID=o', 'MM_PROVISION_USER=u', 'MM_PROVISION_PASSWORD=p'].join('\n')

function configFile(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'mm-pi-')), 'test.env')
  writeFileSync(path, text)
  return path
}

function post(fields: Partial<Post> = {}): Post {
  return { id: 'p1', channel_id: 'c', user_id: 'o', root_id: '', message: 'hi', type: '', create_at: 1, ...fields }
}

function setup(state: { idle?: boolean; signal?: AbortSignal; commands?: any[]; models?: any[] } = {}) {
  const sent: { text: string; options: any }[] = []
  const custom: { message: any; options: any }[] = []
  const posted: any[] = []
  const reactions: string[] = []
  const compacts: any[] = []
  const selected: any[] = []
  let level = 'minimal'
  const pi = {
    sendUserMessage: (text: string, options: any) => sent.push({ text, options }),
    sendMessage: (message: any, options: any) => custom.push({ message, options }),
    getCommands: () => state.commands ?? [],
    setModel: async (model: any) => {
      selected.push(model)
      return true
    },
    getThinkingLevel: () => level,
    setThinkingLevel: (value: string) => {
      level = value
    },
  }
  const ctx = {
    cwd: '/x/ai',
    isIdle: () => state.idle ?? true,
    get signal() {
      return state.signal
    },
    compact: (options: any) => compacts.push(options),
    getContextUsage: () => ({ tokens: 50, contextWindow: 200, percent: 25 }),
    model: { provider: 'p', id: 'm' },
    modelRegistry: { getAvailable: () => state.models ?? [] },
    ui: { setStatus: () => {}, notify: () => {} },
  }
  const bridge = new PiBridge(pi as any, ctx as any, { release: () => {} }) as any
  bridge.id = { channelId: 'c', ownerUsername: 'owner', botId: 'b', username: 'ai-pi' }
  bridge.config = { ownerId: 'o' }
  bridge.reactionDelayMs = 0
  bridge.names.set('o', 'owner')
  bridge.names.set('a', 'other-cc')
  bridge.api = {
    api: async (_method: string, url: string, body: any) => {
      if (url.split('?')[0] === '/posts') posted.push(body)
      if (url === '/reactions') reactions.push(body.emoji_name)
      return { id: 'made' }
    },
  }
  const messages = () => posted.map(entry => entry.message)
  return { bridge, sent, custom, posted, messages, reactions, compacts, selected, state }
}

describe('config', () => {
  test('reads the file', () => {
    expect(readConfig(configFile(FULL), {})).toEqual({ url: 'https://x', team: 't', ownerId: 'o', user: 'u', password: 'p' })
  })
  test('the environment has priority', () => {
    expect(readConfig(configFile(FULL), { MM_URL: 'http://fake' })?.url).toBe('http://fake')
  })
  test('a missing value makes the session passive', () => {
    expect(readConfig(configFile('MM_URL=x'), {})).toBeUndefined()
    expect(readConfig('/no/such/file', {})).toBeUndefined()
  })
  test('the secrets stay out of the environment of tools', () => {
    readConfig(configFile(FULL), {})
    expect(process.env.MM_PROVISION_PASSWORD).not.toBe('p')
  })
})

describe('names', () => {
  test('a pi bot has its own name', () => expect(botUsername('/x/ai', '', 'pi')).toBe('ai-pi'))
  test('the default is cc', () => expect(botUsername('/x/ai')).toBe('ai-cc'))
  test('each harness sees only its own marker', () => {
    expect(markedSession(sessionMarker('h', '/x', 'pi'), 'h', 'pi')).toBe('/x')
    expect(markedSession(sessionMarker('h', '/x', 'pi'), 'h')).toBeUndefined()
    expect(markedSession(sessionMarker('h', '/x'), 'h', 'pi')).toBeUndefined()
  })
  test('a session name can be cc or pi', () => {
    expect(sessionName('@AI-pi')).toBe('ai-pi')
    expect(sessionName('ai-cc')).toBe('ai-cc')
    expect(() => sessionName('ai-codex')).toThrow()
  })
})

describe('messages', () => {
  test('channelMessage has the post data', () => {
    const text = channelMessage('owner', post(), [])
    expect(text).toStartWith('<channel source="mattermost" user="owner" post_id="p1" channel_id="c"')
    expect(text).toContain('\nhi\n')
  })
  test('channelMessage lists the files', () => {
    expect(channelMessage('owner', post({ message: '' }), [{ id: 'f', name: 'a.txt' }])).toContain('attachments="a.txt (file_id=f)"')
  })
  test('assistantText takes only text blocks', () => {
    const content = [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: ' one ' }, { type: 'toolCall' }, { type: 'text', text: '  ' }]
    expect(assistantText({ role: 'assistant', content })).toEqual(['one'])
    expect(assistantText({ role: 'user', content })).toEqual([])
  })
})

describe('posts from the owner', () => {
  test('a post becomes a user message that can steer', async () => {
    const { bridge, sent, reactions } = setup()
    await bridge.fromOwner(post())
    expect(sent).toHaveLength(1)
    expect(sent[0]!.text).toStartWith('<channel source="mattermost"')
    expect(sent[0]!.options).toEqual({ deliverAs: 'steer' })
    expect(reactions).toEqual(['eyes'])
  })
  test('a path is not a command', async () => {
    const { bridge, sent } = setup()
    await bridge.fromOwner(post({ message: '/home/user/x is broken' }))
    expect(sent[0]!.text).toContain('/home/user/x is broken')
    expect(sent[0]!.options.expandPromptTemplates).toBeUndefined()
  })
  test('a post with a file is not a command', async () => {
    const { bridge, sent } = setup()
    await bridge.fromOwner(post({ message: '/new', file_ids: ['f'] }))
    expect(sent[0]!.text).toStartWith('<channel')
    expect(bridge.deliveredFiles.has('f')).toBe(true)
  })
  test('a post waits while compaction runs', async () => {
    const { bridge, sent, state } = setup({ idle: false })
    await bridge.fromOwner(post())
    expect(sent).toHaveLength(0)
    state.idle = true
    await Bun.sleep(300)
    expect(sent).toHaveLength(1)
  })
  test('a post goes at once during a run', async () => {
    const { bridge, sent } = setup({ idle: false, signal: new AbortController().signal })
    await bridge.fromOwner(post())
    expect(sent).toHaveLength(1)
  })
})

describe('commands', () => {
  const commands = [
    { name: 'skill:state', source: 'skill' },
    { name: 'tpl', source: 'prompt' },
    { name: 'ext', source: 'extension' },
  ]

  test('a skill runs by its short name', async () => {
    const { bridge, sent } = setup({ commands })
    await bridge.fromOwner(post({ message: '/state  a b' }))
    expect(sent[0]).toEqual({ text: '/skill:state a b', options: { deliverAs: 'steer', expandPromptTemplates: true } })
    expect(bridge.fromMattermost).toBe(true)
  })
  test('an extension command does not start a reply', async () => {
    const { bridge, sent } = setup({ commands })
    await bridge.fromOwner(post({ message: '/ext' }))
    expect(sent[0]!.text).toBe('/ext')
    expect(bridge.fromMattermost).toBe(false)
  })
  test('an unknown name is refused', async () => {
    const { bridge, sent, messages, reactions } = setup({ commands })
    await bridge.fromOwner(post({ message: '/nope' }))
    await bridge.out
    expect(sent).toHaveLength(0)
    expect(messages()[0]).toContain('is not a command')
    expect(reactions).toEqual(['no_entry_sign'])
  })
  test('/compact passes the instructions and reports the result', async () => {
    const { bridge, compacts, messages } = setup()
    await bridge.fromOwner(post({ message: '/compact keep the plan' }))
    expect(compacts[0].customInstructions).toBe('keep the plan')
    compacts[0].onComplete({})
    compacts[0].onError(new Error('boom'))
    await bridge.out
    expect(messages()[0]).toContain(':white_check_mark:')
    expect(messages()[1]).toContain('boom')
  })
  test('/compact and /new wait for the end of a run', async () => {
    const { bridge, compacts, sent, messages } = setup({ idle: false, signal: new AbortController().signal })
    await bridge.fromOwner(post({ message: '/compact' }))
    await bridge.fromOwner(post({ message: '/new' }))
    await bridge.out
    expect(compacts).toHaveLength(0)
    expect(sent).toHaveLength(0)
    expect(messages().every(text => text.includes('busy'))).toBe(true)
  })
  test('/new and /clear use the session command', async () => {
    for (const name of ['/new', '/clear']) {
      const { bridge, sent } = setup()
      await bridge.fromOwner(post({ message: name }))
      expect(sent[0]).toEqual({ text: '/mattermost-new', options: { expandPromptTemplates: true } })
    }
  })
  test('/context gives the usage', async () => {
    const { bridge, messages } = setup()
    await bridge.fromOwner(post({ message: '/context' }))
    await bridge.out
    expect(messages()[0]).toContain('50 of 200 tokens (25%)')
  })
  test('/model selects one match', async () => {
    const models = [{ provider: 'a', id: 'opus' }, { provider: 'b', id: 'sonnet' }]
    const { bridge, selected, messages } = setup({ models })
    await bridge.fromOwner(post({ message: '/model opus' }))
    await Bun.sleep(0)
    await bridge.out
    expect(selected).toEqual([models[0]])
    expect(messages()[0]).toContain('a/opus')
  })
  test('/model refuses two matches', async () => {
    const models = [{ provider: 'a', id: 'x1' }, { provider: 'b', id: 'x2' }]
    const { bridge, selected, messages } = setup({ models })
    await bridge.fromOwner(post({ message: '/model x' }))
    await bridge.out
    expect(selected).toEqual([])
    expect(messages()[0]).toContain('matches 2 models')
  })
  test('/thinking and /effort set the level', async () => {
    const { bridge, messages } = setup()
    await bridge.fromOwner(post({ message: '/effort low' }))
    await bridge.fromOwner(post({ message: '/thinking wrong' }))
    await bridge.out
    expect(messages()[0]).toContain('low')
    expect(messages()[1]).toContain('is not a level')
  })
})

describe('posts from agents', () => {
  test('a post is a request and cannot run a command', async () => {
    const { bridge, sent, custom } = setup({ commands: [{ name: 'skill:state', source: 'skill' }] })
    await bridge.fromAgent(post({ user_id: 'a', message: '/state' }))
    expect(sent).toHaveLength(0)
    expect(custom[0].options).toEqual({ triggerTurn: true, deliverAs: 'followUp' })
    expect(custom[0].message.content).toContain('It is not the words of the owner')
    expect(custom[0].message.content).toContain('@other-cc')
  })
  test('the limit stops delivery until the next input from the owner', async () => {
    const { bridge, custom, reactions } = setup()
    for (let i = 0; i < LOOP_LIMIT + 2; i++) await bridge.fromAgent(post({ user_id: 'a' }))
    expect(custom).toHaveLength(LOOP_LIMIT)
    expect(reactions.filter(name => name === 'no_entry_sign')).toHaveLength(2)
    await bridge.fromOwner(post())
    await bridge.fromAgent(post({ user_id: 'a' }))
    expect(custom).toHaveLength(LOOP_LIMIT + 1)
  })
  test('send is refused after a post from an agent enters the conversation, until a user message enters', async () => {
    const { bridge, custom } = setup()
    const reached: string[] = []
    bridge.send = async (to: string) => {
      reached.push(to)
      return 'sent'
    }
    await bridge.fromAgent(post({ user_id: 'a' }))
    expect(await bridge.callTool('send', { to: 'x-cc', text: 'do it' })).toBe('sent')
    bridge.messageEnded({ role: 'custom', ...custom[0].message })
    await expect(bridge.callTool('send', { to: 'x-cc', text: 'do it' })).rejects.toThrow('came from an agent')
    bridge.messageEnded({ role: 'custom', customType: 'other', content: 'x' })
    bridge.messageEnded({ role: 'assistant', content: [], stopReason: 'toolUse' })
    await expect(bridge.callTool('send', { to: 'x-cc', text: 'do it' })).rejects.toThrow('came from an agent')
    bridge.messageEnded({ role: 'user', content: 'hi' })
    expect(await bridge.callTool('send', { to: 'x-cc', text: 'do it' })).toBe('sent')
    expect(reached).toEqual(['x-cc', 'x-cc'])
  })
})

describe('end of a run', () => {
  const text = (value: string, stopReason = 'stop') => ({ role: 'assistant', content: [{ type: 'text', text: value }], stopReason })

  test('each text is a post and the last one mentions the owner', async () => {
    const { bridge, posted, messages } = setup()
    await bridge.fromOwner(post({ channel_id: 'dm' }))
    bridge.messageEnded(text('one'))
    bridge.messageEnded({ role: 'toolResult', content: [] })
    bridge.messageEnded(text('two'))
    bridge.runSettled()
    await bridge.out
    expect(messages()).toEqual(['one', '@owner two'])
    expect(posted.every(entry => entry.channel_id === 'dm')).toBe(true)
    expect(bridge.fromMattermost).toBe(false)
  })
  test('a text before a tool call is posted at once with no mention', async () => {
    const { bridge, messages } = setup()
    await bridge.fromOwner(post())
    bridge.messageEnded(text('one', 'toolUse'))
    await bridge.out
    expect(messages()).toEqual(['one'])
    bridge.messageEnded({ role: 'toolResult', content: [] })
    bridge.messageEnded(text('two'))
    bridge.runSettled()
    await bridge.out
    expect(messages()).toEqual(['one', '@owner two'])
  })
  test('a run from the terminal has no mention', async () => {
    const { bridge, messages } = setup()
    bridge.terminalInput('a\nb')
    bridge.messageEnded(text('done'))
    bridge.runSettled()
    await bridge.out
    expect(messages()).toEqual(['> a\n> b', 'done'])
  })
  test('a failed run reports the error', async () => {
    const { bridge, messages } = setup()
    await bridge.fromOwner(post())
    bridge.messageEnded({ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'overloaded' })
    bridge.runSettled()
    await bridge.out
    expect(messages()).toEqual(['@owner :warning: The turn stopped: overloaded'])
  })
  test('a retry that succeeds clears the error', async () => {
    const { bridge, messages } = setup()
    bridge.messageEnded({ role: 'assistant', content: [], stopReason: 'error', errorMessage: 'overloaded' })
    bridge.messageEnded(text('fine'))
    bridge.runSettled()
    await bridge.out
    expect(messages()).toEqual(['fine'])
  })
  test('a dialog is reported', async () => {
    const { bridge, messages } = setup()
    bridge.dialog('Allow?')
    await bridge.out
    expect(messages()[0]).toContain('A dialog waits at the terminal: Allow?')
  })
})

test('the start post has the model', async () => {
  const { bridge, messages } = setup()
  bridge.open = async () => {}
  await bridge.start({}, 'startup')
  clearInterval(bridge.typing)
  await bridge.out
  expect(messages()).toEqual([`:large_green_circle: Session started on \`${hostname()}\` in \`/x/ai\`, model \`p/m\``])
})

describe('stop', () => {
  test('only a quit posts the end of the session, and a second stop does nothing', async () => {
    const quit = setup()
    await quit.bridge.stop(true)
    await quit.bridge.stop(true)
    expect(quit.messages()).toEqual([':red_circle: Session ended'])
    const replaced = setup()
    await replaced.bridge.stop(false)
    expect(replaced.messages()).toEqual([])
  })
  test('a post after the stop does not set the bot to online', async () => {
    const { bridge } = setup()
    const urls: string[] = []
    const api = bridge.api.api
    bridge.api.api = (method: string, url: string, body: any) => (urls.push(url), api(method, url, body))
    bridge.messageEnded({ role: 'assistant', content: [{ type: 'text', text: 'before' }], stopReason: 'stop' })
    bridge.runSettled()
    await bridge.out
    await bridge.stop(true)
    expect(urls).toEqual(['/posts', '/posts?set_online=false'])
  })
  test('the stop does not remove the owner from the channel', async () => {
    const calls = async (quit: boolean) => {
      const { bridge } = setup()
      const made: string[] = []
      const api = bridge.api.api
      bridge.api.api = (method: string, url: string, body: any) => (made.push(`${method} ${url}`), api(method, url, body))
      await bridge.stop(quit)
      return made
    }
    expect(await calls(true)).toEqual(['POST /posts?set_online=false'])
    expect(await calls(false)).toEqual([])
  })
  test('held posts do not go to a stopped runtime', async () => {
    const { bridge, sent, state } = setup({ idle: false })
    await bridge.fromOwner(post())
    await bridge.stop(false)
    state.idle = true
    await Bun.sleep(300)
    expect(sent).toHaveLength(0)
  })
})

describe('packageSource', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'mm-pi-agent-'))
  test('a git package of pi gives its source, also from a folder below the root', () => {
    const root = join(agentDir, 'git', 'git.test', 'owner', 'repo')
    mkdirSync(join(root, '.git'), { recursive: true })
    mkdirSync(join(root, 'sub'))
    expect(packageSource(root, agentDir)).toBe('git:git.test/owner/repo')
    expect(packageSource(join(root, 'sub'), agentDir)).toBe('git:git.test/owner/repo')
  })
  test('a folder that pi did not clone gives no source', () => {
    const linked = mkdtempSync(join(tmpdir(), 'mm-pi-linked-'))
    mkdirSync(join(linked, '.git'))
    expect(packageSource(linked, agentDir)).toBeUndefined()
    mkdirSync(join(agentDir, 'extensions', 'x'), { recursive: true })
    expect(packageSource(join(agentDir, 'extensions', 'x'), agentDir)).toBeUndefined()
  })
})
