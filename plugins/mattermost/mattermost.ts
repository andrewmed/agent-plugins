import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { basename } from 'path'

export type Post = {
  id: string
  channel_id: string
  user_id: string
  root_id: string
  message: string
  type: string
  props?: Record<string, unknown>
  create_at: number
  edit_at?: number
  delete_at?: number
  file_ids?: string[]
  metadata?: { files?: { id: string; name: string; size: number }[] }
}

export type Config = { url: string; team: string; ownerId: string; user: string; password: string }

export type Harness = 'claude' | 'pi'

export type Identity = {
  botId: string
  botToken: string
  username: string
  teamId: string
  channelId: string
  agentsChannelId: string
  ownerUsername: string
}

export type WsEvent = { event: string; data: Record<string, any>; broadcast?: Record<string, any> }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly apiId: string,
    path: string,
  ) {
    super(`HTTP ${status} ${apiId} on ${path}`)
  }
}

export class Client {
  constructor(
    readonly url: string,
    public token = '',
  ) {}

  private authHeader(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {}
  }

  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${this.url}/api/v4${path}`, {
      method,
      headers: { ...this.authHeader(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      const detail: any = await res.json().catch(() => ({}))
      throw new ApiError(res.status, String(detail?.id ?? ''), path)
    }
    return res
  }

  async api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const text = await (await this.send(method, path, body)).text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  async login(user: string, password: string): Promise<void> {
    const res = await this.send('POST', '/users/login', { login_id: user, password })
    await res.arrayBuffer()
    this.token = res.headers.get('Token') ?? ''
    if (!this.token) throw new Error('login gave no session')
  }

  async upload(channelId: string, name: string, data: Blob): Promise<string> {
    const form = new FormData()
    form.append('channel_id', channelId)
    form.append('files', data, name)
    const res = await fetch(`${this.url}/api/v4/files`, {
      method: 'POST',
      headers: this.authHeader(),
      body: form,
      signal: AbortSignal.timeout(120000),
    })
    if (!res.ok) throw new ApiError(res.status, '', '/files')
    const out: any = await res.json()
    return out.file_infos[0].id
  }

  async download(fileId: string): Promise<ArrayBuffer> {
    const res = await fetch(`${this.url}/api/v4/files/${fileId}`, {
      headers: this.authHeader(),
      signal: AbortSignal.timeout(120000),
    })
    if (!res.ok) throw new ApiError(res.status, '', `/files/${fileId}`)
    return res.arrayBuffer()
  }
}

const PING_MS = 30_000
const SILENCE_LIMIT_MS = 75_000

export class Socket {
  private ws: WebSocket | undefined
  private stopped = false
  private attempt = 0
  private seq = 1
  private lastMessage = 0
  private lastTick = Date.now()
  private timer: ReturnType<typeof setInterval> | undefined
  private serverTime: number | undefined
  // Server time of the last pong before this connection. Undefined on the first connection.
  since: number | undefined

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly onEvent: (event: WsEvent) => void,
    private readonly log: (line: string) => void,
  ) {}

  start(): void {
    if (this.stopped) return
    this.timer ??= setInterval(() => this.check(), PING_MS)
    this.timer.unref()
    this.since = this.serverTime
    const ws = new WebSocket(`${this.url.replace(/^http/, 'ws')}/api/v4/websocket`)
    this.ws = ws
    ws.onopen = () => {
      this.lastMessage = Date.now()
      ws.send(JSON.stringify({ seq: this.seq++, action: 'authentication_challenge', data: { token: this.token } }))
      this.ping(ws)
    }
    ws.onmessage = message => {
      this.lastMessage = Date.now()
      let event: WsEvent
      try {
        event = JSON.parse(String(message.data))
      } catch {
        return
      }
      if (typeof event.data?.server_time === 'number') this.serverTime = event.data.server_time
      if (!event.event) return
      if (event.event === 'hello') this.attempt = 0
      this.onEvent(event)
    }
    ws.onerror = () => ws.close()
    ws.onclose = () => {
      if (this.stopped || ws !== this.ws) return
      const delay = Math.min(30000, 1000 * 2 ** this.attempt++)
      this.log(`websocket closed, new connection in ${delay} ms`)
      setTimeout(() => this.start(), delay)
    }
  }

  // After sleep a dead connection can stay open with no close event. Node has no terminate(), so do not wait for onclose.
  private check(): void {
    const now = Date.now()
    const slept = now - this.lastTick > 2 * PING_MS
    this.lastTick = now
    const ws = this.ws
    if (this.stopped || ws?.readyState !== WebSocket.OPEN) return
    if (slept || now - this.lastMessage > SILENCE_LIMIT_MS) {
      this.log(slept ? 'the computer slept, new connection' : 'no message from the server, new connection')
      this.ws = undefined
      ws.close()
      this.start()
      return
    }
    this.ping(ws)
  }

  private ping(ws: WebSocket): void {
    ws.send(JSON.stringify({ seq: this.seq++, action: 'ping' }))
  }

  typing(channelId: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ seq: this.seq++, action: 'user_typing', data: { channel_id: channelId, parent_id: '' } }))
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.timer)
    this.ws?.close()
  }
}

const NAME_SUFFIX: Record<Harness, string> = { claude: 'cc', pi: 'pi' }

export function botUsername(project: string, suffix = '', harness: Harness = 'claude'): string {
  const tail = `${suffix ? `-${suffix}` : ''}-${NAME_SUFFIX[harness]}`
  const name = basename(project)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 22 - tail.length)
    .replace(/[-_]+$/, '')
  return `${name || 'agent'}${tail}`
}

function markerPrefix(host: string, harness: Harness): string {
  return `mm-agent-${NAME_SUFFIX[harness]} host=${host} session=`
}

export function sessionMarker(host: string, key: string, harness: Harness = 'claude'): string {
  return `${markerPrefix(host, harness)}${key}`
}

export function markedSession(description: string, host: string, harness: Harness = 'claude'): string | undefined {
  const prefix = markerPrefix(host, harness)
  return description.startsWith(prefix) ? description.slice(prefix.length) : undefined
}

async function listBots(admin: Client): Promise<any[]> {
  const out: any[] = []
  for (let page = 0; ; page++) {
    const bots = await admin.api<any[]>('GET', `/bots?per_page=200&page=${page}&include_deleted=true`)
    out.push(...bots)
    if (bots.length < 200) return out
  }
}

async function removeGoneSessions(
  admin: Client,
  teamId: string,
  bots: any[],
  host: string,
  isLive: (project: string) => boolean | Promise<boolean>,
  log: (line: string) => void,
  harness: Harness,
): Promise<void> {
  for (const bot of bots) {
    const session = markedSession(String(bot.description ?? ''), host, harness)
    // Migration of 2026-11-10 from the suffix -claude to -cc: removes the bots that have the marker without a suffix.
    // Delete `old` when no session of the old version runs.
    const old = harness === 'claude' && !bot.delete_at && String(bot.description ?? '').startsWith(`mm-agent host=${host} session=`)
    if (!old && (!session || bot.delete_at || existsSync(session) || (await isLive(session)))) continue
    try {
      const channel = await admin.api('GET', `/teams/${teamId}/channels/name/${bot.username}`).catch(() => undefined)
      if (channel?.creator_id === bot.user_id) await admin.api('DELETE', `/channels/${channel.id}`)
      await admin.api('POST', `/bots/${bot.user_id}/disable`)
      log(old ? `removed the old bot ${bot.username}` : `removed the session of the gone directory ${session}`)
    } catch (err) {
      log(`cleanup of ${bot.username} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

async function findOrCreateBot(admin: Client, bots: any[], project: string, marker: string, harness: Harness): Promise<any> {
  const found = bots.find(bot => bot.description === marker)
  if (found) {
    if (found.delete_at) await admin.api('POST', `/bots/${found.user_id}/enable`)
    return found
  }
  const hash = createHash('sha256').update(marker).digest('hex').slice(0, 3)
  for (const suffix of ['', hash]) {
    const username = botUsername(project, suffix, harness)
    const label = NAME_SUFFIX[harness]
    const display_name = `${username.slice(0, -label.length - 1)} · ${label}`
    try {
      return await admin.api('POST', '/bots', { username, display_name, description: marker })
    } catch (err) {
      if (!(err instanceof ApiError) || err.status >= 500 || suffix) throw err
    }
  }
}

export async function ensureChannel(
  client: Client,
  teamId: string,
  name: string,
  displayName: string,
  botId: string,
): Promise<string> {
  let channel: any
  try {
    channel = await client.api('POST', '/channels', { team_id: teamId, name, display_name: displayName, type: 'O' })
  } catch (err) {
    if (!(err instanceof ApiError) || err.status >= 500) throw err
    channel = await client.api('GET', `/teams/${teamId}/channels/name/${name}?include_deleted=true`)
    if (channel.delete_at) await client.api('POST', `/channels/${channel.id}/restore`)
  }
  await client.api('POST', `/channels/${channel.id}/members`, { user_id: botId })
  return channel.id
}

export async function provision(
  config: Config,
  host: string,
  project: string,
  isLive: (project: string) => boolean | Promise<boolean>,
  log: (line: string) => void,
  harness: Harness = 'claude',
): Promise<Identity> {
  const admin = new Client(config.url)
  await admin.login(config.user, config.password)
  try {
    const team = await admin.api('GET', `/teams/name/${config.team}`)
    const teamId: string = team.id
    const bots = await listBots(admin)
    await removeGoneSessions(admin, teamId, bots, host, isLive, log, harness)
    const bot = await findOrCreateBot(admin, bots, project, sessionMarker(host, project, harness), harness)
    const made = await admin.api('POST', `/users/${bot.user_id}/tokens`, { description: 'mattermost-agents session' })
    const old = await admin.api<any[]>('GET', `/users/${bot.user_id}/tokens?per_page=200`)
    await admin.api('POST', `/teams/${teamId}/members`, { team_id: teamId, user_id: bot.user_id })
    const client = new Client(config.url, made.token)
    const channelId = await ensureChannel(client, teamId, bot.username, bot.display_name || bot.username, bot.user_id)
    await client.api('POST', `/channels/${channelId}/members`, { user_id: config.ownerId })
    const agentsChannelId = await ensureChannel(client, teamId, 'agents', 'agents', bot.user_id)
    await client.api('POST', `/channels/${agentsChannelId}/members`, { user_id: config.ownerId })
    const owner = await client.api('GET', `/users/${config.ownerId}`)
    for (const entry of old) {
      if (entry.id !== made.id) await admin.api('POST', '/users/tokens/revoke', { token_id: entry.id })
    }
    return {
      botId: bot.user_id,
      botToken: made.token,
      username: bot.username,
      teamId,
      channelId,
      agentsChannelId,
      ownerUsername: owner.username,
    }
  } finally {
    await admin.api('POST', '/users/logout').catch(() => {})
  }
}
