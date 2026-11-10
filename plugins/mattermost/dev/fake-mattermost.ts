#!/usr/bin/env bun
import type { ServerWebSocket } from 'bun'

const port = Number(process.env.FAKE_PORT ?? 18065)
let serial = 0
const makeId = (prefix: string) => `${prefix}${String(++serial).padStart(6, '0')}`

type User = { id: string; username: string; is_bot: boolean; description?: string; delete_at: number; display_name?: string }
type Channel = { id: string; team_id: string; name: string; display_name: string; type: string; delete_at: number; creator_id?: string; members: Set<string> }
type Conn = { userId?: string }

const users = new Map<string, User>()
const tokens = new Map<string, { id: string; userId: string; revoked: boolean }>()
const channels = new Map<string, Channel>()
const posts: any[] = []
const reactions: any[] = []
const files = new Map<string, { name: string; data: ArrayBuffer }>()
const sockets = new Set<ServerWebSocket<Conn>>()
const team = { id: 'team1', name: 'home' }
const log: string[] = []

for (const [id, username] of [['ownerfake', 'owner'], ['provisionfake', 'provision'], ['otherfake', 'other']] as const) {
  users.set(id, { id, username, is_bot: false, delete_at: 0 })
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body ?? {}), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function fail(status: number, id: string): Response {
  return json({ id, message: id, status_code: status }, status)
}

function issue(userId: string): { id: string; token: string; user_id: string } {
  const token = makeId('tok')
  const id = makeId('tid')
  tokens.set(token, { id, userId, revoked: false })
  return { id, token, user_id: userId }
}

function caller(req: Request): string | undefined {
  const entry = tokens.get((req.headers.get('Authorization') ?? '').replace(/^Bearer /, ''))
  return entry && !entry.revoked ? entry.userId : undefined
}

function publicUser(user: User): object {
  return { id: user.id, username: user.username, is_bot: user.is_bot, delete_at: user.delete_at }
}

function broadcast(channel: Channel, event: string, data: object): void {
  const text = JSON.stringify({ event, data, broadcast: { channel_id: channel.id }, seq: ++serial })
  for (const ws of sockets) if (ws.data.userId && channel.members.has(ws.data.userId)) ws.send(text)
}

function makePost(channel: Channel, userId: string, fields: { message: string; root_id?: string; type?: string; props?: object; file_ids?: string[] }) {
  const post: any = {
    id: makeId('post'),
    channel_id: channel.id,
    user_id: userId,
    root_id: fields.root_id ?? '',
    message: fields.message,
    type: fields.type ?? '',
    props: fields.props ?? {},
    create_at: Date.now(),
    file_ids: fields.file_ids ?? [],
  }
  if (post.file_ids.length) {
    post.metadata = { files: post.file_ids.map((id: string) => ({ id, name: files.get(id)?.name, size: files.get(id)?.data.byteLength })) }
  }
  posts.push(post)
  const mentioned = [...users.values()].filter(u => post.message.includes(`@${u.username}`)).map(u => u.id)
  broadcast(channel, 'posted', {
    post: JSON.stringify(post),
    channel_type: channel.type,
    sender_name: users.get(userId)?.username,
    ...(mentioned.length ? { mentions: JSON.stringify(mentioned) } : {}),
  })
  return post
}

function byName(name: string): Channel | undefined {
  return [...channels.values()].find(c => c.name === name)
}

async function api(req: Request, path: string): Promise<Response> {
  const method = req.method
  const me = caller(req)
  log.push(`${method} ${path} ${me ?? 'anon'}`)
  const body: any = req.headers.get('content-type')?.includes('json') ? await req.json().catch(() => ({})) : undefined
  let m: RegExpExecArray | null
  if (method === 'POST' && path === '/users/login') {
    const user = [...users.values()].find(u => u.username === body.login_id)
    if (!user) return fail(401, 'api.user.login.invalid_credentials')
    return json(publicUser(user), 200, { Token: issue(user.id).token })
  }
  if (!me) return fail(401, 'api.context.session_expired.app_error')
  if (method === 'POST' && path === '/users/logout') return json({ status: 'OK' })
  if (method === 'GET' && path === '/teams/name/home') return json(team)
  if (method === 'GET' && path.startsWith('/bots')) {
    return json([...users.values()].filter(u => u.is_bot).map(u => ({ user_id: u.id, username: u.username, display_name: u.display_name, description: u.description, delete_at: u.delete_at })))
  }
  if (method === 'POST' && path === '/bots') {
    if ([...users.values()].some(u => u.username === body.username)) return fail(400, 'app.user.save.username_exists.app_error')
    const id = makeId('bot')
    users.set(id, { id, username: body.username, is_bot: true, description: body.description, display_name: body.display_name, delete_at: 0 })
    return json({ user_id: id, username: body.username, display_name: body.display_name, description: body.description, delete_at: 0 }, 201)
  }
  if ((m = /^\/bots\/([^/]+)\/(enable|disable)$/.exec(path)) && method === 'POST') {
    const bot = users.get(m[1]!)!
    bot.delete_at = m[2] === 'disable' ? Date.now() : 0
    return json({ user_id: bot.id, username: bot.username })
  }
  if ((m = /^\/users\/([^/]+)\/tokens/.exec(path))) {
    if (method === 'POST') {
      if (m[1] === 'ownerfake' || !users.get(m[1]!)?.is_bot) return fail(403, 'api.context.permissions.app_error')
      return json(issue(m[1]!))
    }
    return json([...tokens.values()].filter(t => t.userId === m![1] && !t.revoked).map(t => ({ id: t.id })))
  }
  if (method === 'POST' && path === '/users/tokens/revoke') {
    for (const t of tokens.values()) if (t.id === body.token_id) t.revoked = true
    return json({ status: 'OK' })
  }
  if ((m = /^\/teams\/[^/]+\/members$/.exec(path)) && method === 'POST') return json({}, 201)
  if (method === 'POST' && path === '/channels') {
    if (byName(body.name)) return fail(400, 'store.sql_channel.save_channel.exists.app_error')
    const channel: Channel = { id: makeId('ch'), team_id: body.team_id, name: body.name, display_name: body.display_name, type: body.type, delete_at: 0, creator_id: me, members: new Set([me]) }
    channels.set(channel.id, channel)
    return json({ ...channel, members: undefined }, 201)
  }
  if ((m = /^\/teams\/[^/]+\/channels\/name\/([^/?]+)/.exec(path)) && method === 'GET') {
    const channel = byName(m[1]!)
    return channel ? json({ ...channel, members: undefined }) : fail(404, 'store.sql_channel.get_by_name.missing.app_error')
  }
  if ((m = /^\/channels\/([^/]+)\/members/.exec(path))) {
    const channel = channels.get(m[1]!)
    if (!channel) return fail(404, 'missing')
    if (method === 'POST') {
      channel.members.add(body.user_id)
      return json({ channel_id: channel.id, user_id: body.user_id }, 201)
    }
    return json([...channel.members].map(user_id => ({ user_id })))
  }
  if ((m = /^\/channels\/([^/]+)\/restore$/.exec(path)) && method === 'POST') {
    channels.get(m[1]!)!.delete_at = 0
    return json({})
  }
  if ((m = /^\/channels\/([^/]+)\/posts/.exec(path)) && method === 'GET') {
    const list = posts.filter(p => p.channel_id === m![1]).reverse()
    return json({ order: list.map(p => p.id), posts: Object.fromEntries(list.map(p => [p.id, p])) })
  }
  if ((m = /^\/channels\/([^/]+)$/.exec(path)) && method === 'DELETE') {
    channels.get(m[1]!)!.delete_at = Date.now()
    return json({ status: 'OK' })
  }
  if (method === 'POST' && path === '/channels/direct') {
    const [a, b] = body as string[]
    let channel = byName(`${a}__${b}`) ?? byName(`${b}__${a}`)
    if (!channel) {
      channel = { id: makeId('dm'), team_id: '', name: `${a}__${b}`, display_name: '', type: 'D', delete_at: 0, members: new Set([a!, b!]) }
      channels.set(channel.id, channel)
    }
    return json({ id: channel.id }, 201)
  }
  if (method === 'POST' && path === '/users/ids') return json((body as string[]).map(id => publicUser(users.get(id)!)))
  if (method === 'POST' && path === '/users/status/ids') {
    const online = new Set([...sockets].map(ws => ws.data.userId))
    return json((body as string[]).map(user_id => ({ user_id, status: online.has(user_id) ? 'online' : 'offline' })))
  }
  if ((m = /^\/users\/([^/]+)$/.exec(path)) && method === 'GET') {
    const user = users.get(m[1]!)
    return user ? json(publicUser(user)) : fail(404, 'missing')
  }
  if (method === 'POST' && path === '/posts') {
    const channel = channels.get(body.channel_id)
    if (!channel) return fail(404, 'missing')
    if (!channel.members.has(me)) return fail(403, 'api.context.permissions.app_error')
    return json(makePost(channel, me, body), 201)
  }
  if ((m = /^\/posts\/([^/]+)$/.exec(path)) && method === 'GET') {
    const post = posts.find(p => p.id === m![1])
    return post ? json(post) : fail(404, 'missing')
  }
  if (method === 'POST' && path.endsWith('/posts/search')) {
    const list = posts.filter(p => p.message.includes(body.terms))
    return json({ order: list.map(p => p.id), posts: Object.fromEntries(list.map(p => [p.id, p])) })
  }
  if (method === 'POST' && path === '/reactions') {
    reactions.push(body)
    return json(body, 201)
  }
  if (method === 'POST' && path === '/files') {
    const form = await req.formData()
    const file = form.get('files') as File
    const id = makeId('file')
    files.set(id, { name: file.name, data: await file.arrayBuffer() })
    return json({ file_infos: [{ id, name: file.name }] }, 201)
  }
  if ((m = /^\/files\/([^/]+)\/info$/.exec(path)) && method === 'GET') {
    const file = files.get(m[1]!)
    return file ? json({ id: m[1], name: file.name, size: file.data.byteLength }) : fail(404, 'missing')
  }
  if ((m = /^\/files\/([^/]+)$/.exec(path)) && method === 'GET') {
    const file = files.get(m[1]!)
    return file ? new Response(file.data) : fail(404, 'missing')
  }
  return fail(501, `fake: no route for ${method} ${path}`)
}

async function testRoute(req: Request, path: string): Promise<Response> {
  if (path === '/state') {
    return json({
      users: [...users.values()],
      channels: [...channels.values()].map(c => ({ ...c, members: [...c.members] })),
      posts,
      reactions,
      log,
    })
  }
  const body: any = await req.json()
  const user = [...users.values()].find(u => u.username === body.from)
  if (!user) return fail(400, 'no such user')
  if (path === '/post') {
    const channel = byName(body.channel)
    if (!channel) return fail(400, 'no such channel')
    return json(makePost(channel, user.id, body))
  }
  if (path === '/dm') {
    const bot = [...users.values()].find(u => u.username === body.to)!
    let channel = byName(`${user.id}__${bot.id}`)
    if (!channel) {
      channel = { id: makeId('dm'), team_id: '', name: `${user.id}__${bot.id}`, display_name: '', type: 'D', delete_at: 0, members: new Set([user.id, bot.id]) }
      channels.set(channel.id, channel)
    }
    return json(makePost(channel, user.id, body))
  }
  if (path === '/reaction') {
    const post = posts.find(p => p.id === body.post_id)
    const reaction = { user_id: user.id, post_id: body.post_id, emoji_name: body.emoji }
    reactions.push(reaction)
    broadcast(channels.get(post.channel_id)!, 'reaction_added', { reaction: JSON.stringify(reaction) })
    return json(reaction)
  }
  return fail(404, 'no test route')
}

Bun.serve<Conn>({
  port,
  hostname: '127.0.0.1',
  async fetch(req, server) {
    const path = new URL(req.url)
    if (path.pathname === '/api/v4/websocket') {
      return server.upgrade(req, { data: {} }) ? undefined : fail(400, 'upgrade')
    }
    if (path.pathname.startsWith('/__test')) return testRoute(req, path.pathname.slice('/__test'.length))
    return api(req, path.pathname.slice('/api/v4'.length) + path.search)
  },
  websocket: {
    open(ws) {
      sockets.add(ws)
    },
    close(ws) {
      sockets.delete(ws)
    },
    message(ws, raw) {
      const message = JSON.parse(String(raw))
      if (message.action === 'authentication_challenge') {
        const entry = tokens.get(message.data.token)
        if (!entry || entry.revoked) {
          ws.close()
          return
        }
        ws.data.userId = entry.userId
        ws.send(JSON.stringify({ status: 'OK', seq_reply: message.seq }))
        ws.send(JSON.stringify({ event: 'hello', data: {}, broadcast: {}, seq: ++serial }))
        return
      }
      if (message.action === 'ping') ws.send(JSON.stringify({ status: 'OK', seq_reply: message.seq, data: { text: 'pong' } }))
      if (message.action === 'user_typing') log.push(`typing ${ws.data.userId} ${message.data.channel_id}`)
    },
  },
})
console.log(`fake mattermost on ${port}`)
