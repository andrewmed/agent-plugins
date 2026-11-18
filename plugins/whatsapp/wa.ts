import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SYNC_LIMIT_MS = 20_000
const CHUNK_WAIT_MS = 40_000
const QUIET_MS = 2_000
const ACK_MS = 10_000
const SEND_LIMIT_MS = 30_000
const LOCK_WAIT_MS = 30_000
const LINK_QUIET_MS = 60_000
const LINK_LIMIT_MS = 30 * 60_000
const VERSION_LIMIT_MS = 10_000
const SERVER_ACK = 2
const STATUS_ERROR = 0
const STUB_REVOKE = 1
const QR_MODULE = 'qrcode-terminal'
// White modules as foreground on a black background: the terminal theme cannot invert the code.
const QR_COLORS = '\x1b[38;5;231;48;5;16m'

const USAGE = `usage: node wa.ts <command>
  chats [--search TEXT] [--type user|group] [--limit 50] [--offline]
  search [QUERY] [--chat CHAT ...] [--since D] [--before D] [--limit 20] [--offline]
  read CHAT [--since D] [--before D] [--limit 20] [--offline]
  context ID [--chat CHAT] [--around 5] [--offline]
  draft CHAT                    the text on stdin
  drafts [--offline]
  send N
  link [--phone NUMBER]         the user runs it in a terminal: a QR code, or a pairing code with --phone
CHAT: a JID, a phone number with the country code, or a part of a name.
D: 2026-09-01, or 7d, 3w, 6m before today.`

const SILENT: any = { level: 'silent', child: () => SILENT, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} }

export class UserError extends Error {
  exitCode = 1
}

export class NeedLink extends UserError {
  exitCode = 2
}

function fail(message: string): never {
  throw new UserError(message)
}

const now = () => Math.floor(Date.now() / 1000)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: any
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms) })
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer))
}

// ---------- state and store

export function paths(dir = path.join(os.homedir(), '.local/state/whatsapp')) {
  return { dir, auth: path.join(dir, 'auth'), db: path.join(dir, 'store.db'), lock: path.join(dir, 'lock.db') }
}

type Paths = ReturnType<typeof paths>

export function prepareState(p: Paths) {
  process.umask(0o077)
  fs.mkdirSync(p.auth, { recursive: true, mode: 0o700 })
  fs.chmodSync(p.dir, 0o700)
  fs.chmodSync(p.auth, 0o700)
  for (const f of [p.db, `${p.db}-wal`, `${p.db}-shm`]) if (fs.existsSync(f)) fs.chmodSync(f, 0o600)
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS chats(jid TEXT PRIMARY KEY, name TEXT, is_group INTEGER NOT NULL DEFAULT 0, last_ts INTEGER);
CREATE TABLE IF NOT EXISTS contacts(jid TEXT PRIMARY KEY, name TEXT, notify TEXT);
CREATE TABLE IF NOT EXISTS jid_map(lid TEXT PRIMARY KEY, pn TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(rid INTEGER PRIMARY KEY, chat TEXT NOT NULL, id TEXT NOT NULL, ts INTEGER NOT NULL,
  sender TEXT, from_me INTEGER NOT NULL, text TEXT, kind TEXT NOT NULL, expires_ts INTEGER, UNIQUE(chat, id));
CREATE INDEX IF NOT EXISTS messages_chat_ts ON messages(chat, ts);
CREATE INDEX IF NOT EXISTS messages_id ON messages(id);
CREATE INDEX IF NOT EXISTS messages_expires ON messages(expires_ts) WHERE expires_ts IS NOT NULL;
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='rid',
  tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF text ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rid, new.text);
END;
CREATE TABLE IF NOT EXISTS drafts(n INTEGER PRIMARY KEY AUTOINCREMENT, chat TEXT NOT NULL, text TEXT NOT NULL,
  created_ts INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'draft', state_ts INTEGER, message_id TEXT, error TEXT);
CREATE TRIGGER IF NOT EXISTS drafts_fixed BEFORE UPDATE OF chat, text ON drafts BEGIN
  SELECT RAISE(ABORT, 'a draft does not change');
END;
CREATE TABLE IF NOT EXISTS sent(id TEXT PRIMARY KEY, chat TEXT NOT NULL, proto BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS sync(key TEXT PRIMARY KEY, value TEXT);
`

export function openStore(file: string) {
  const db = new DatabaseSync(file)
  db.exec(SCHEMA)
  q(db, 'DELETE FROM messages WHERE expires_ts IS NOT NULL AND expires_ts < ?').run(now())
  return db
}

const statements = new WeakMap<DatabaseSync, Map<string, any>>()

function q(db: DatabaseSync, sql: string) {
  let cache = statements.get(db)
  if (!cache) statements.set(db, (cache = new Map()))
  let s = cache.get(sql)
  if (!s) cache.set(sql, (s = db.prepare(sql)))
  return s
}

function getKV(db: DatabaseSync, key: string): string | undefined {
  return q(db, 'SELECT value FROM sync WHERE key = ?').get(key)?.value
}

function setKV(db: DatabaseSync, key: string, value: string) {
  q(db, 'INSERT INTO sync(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

// ---------- lock: an exclusive transaction on lock.db; the system releases it when the process ends

export function takeLock(file: string, waitMs: number) {
  const db = new DatabaseSync(file)
  db.exec(`PRAGMA busy_timeout = ${Math.floor(waitMs)}`)
  try {
    db.exec('BEGIN EXCLUSIVE')
    return db
  } catch (e: any) {
    db.close()
    if (/locked|busy/i.test(e.message)) return null
    throw e
  }
}

export function releaseLock(lock: DatabaseSync) {
  try { lock.exec('COMMIT') } catch {}
  lock.close()
}

// ---------- JIDs

export const skipJid = (j?: string | null) =>
  !!j && (j === 'status@broadcast' || j.endsWith('@broadcast') || j.endsWith('@newsletter'))

export function normJid(j?: string | null) {
  if (!j) return j ?? undefined
  const at = j.indexOf('@')
  return at < 0 ? j : `${j.slice(0, at).split(':')[0]}@${j.slice(at + 1)}`
}

const isLid = (j?: string) => !!j && j.endsWith('@lid')
const isPn = (j?: string) => !!j && j.endsWith('@s.whatsapp.net')

function mapped(db: DatabaseSync, jid: string) {
  return isLid(jid) ? q(db, 'SELECT pn FROM jid_map WHERE lid = ?').get(jid)?.pn ?? jid : jid
}

function canon(db: DatabaseSync, jid?: string | null, alt?: string | null) {
  const j = normJid(jid)!
  const a = normJid(alt)
  if (isLid(j) && isPn(a)) addMap(db, j, a)
  return mapped(db, j)
}

export function addMap(db: DatabaseSync, lid?: string, pn?: string) {
  lid = normJid(lid)
  pn = normJid(pn)
  if (!isLid(lid) || !isPn(pn)) return
  if (q(db, 'SELECT pn FROM jid_map WHERE lid = ?').get(lid)?.pn === pn) return
  q(db, 'INSERT OR REPLACE INTO jid_map(lid, pn) VALUES (?, ?)').run(lid, pn)
  q(db, 'UPDATE OR IGNORE messages SET chat = ? WHERE chat = ?').run(pn, lid)
  q(db, 'DELETE FROM messages WHERE chat = ?').run(lid)
  q(db, 'UPDATE messages SET sender = ? WHERE sender = ?').run(pn, lid)
  q(db, `UPDATE chats SET name = coalesce(name, (SELECT name FROM chats WHERE jid = ?)),
    last_ts = max(coalesce(last_ts, 0), coalesce((SELECT last_ts FROM chats WHERE jid = ?), 0)) WHERE jid = ?`).run(lid, lid, pn)
  q(db, 'UPDATE OR IGNORE chats SET jid = ? WHERE jid = ?').run(pn, lid)
  q(db, 'DELETE FROM chats WHERE jid = ?').run(lid)
  q(db, `UPDATE contacts SET name = coalesce(name, (SELECT name FROM contacts WHERE jid = ?)),
    notify = coalesce(notify, (SELECT notify FROM contacts WHERE jid = ?)) WHERE jid = ?`).run(lid, lid, pn)
  q(db, 'UPDATE OR IGNORE contacts SET jid = ? WHERE jid = ?').run(pn, lid)
  q(db, 'DELETE FROM contacts WHERE jid = ?').run(lid)
}

// ---------- message content

const toNum = (v: any): number =>
  v == null ? 0 : typeof v === 'object' ? (typeof v.toNumber === 'function' ? v.toNumber() : Number(v.low ?? 0)) : Number(v)

const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'editedMessage', 'groupMentionedMessage', 'botInvokeMessage', 'associatedChildMessage',
  'lottieStickerMessage']

const NOT_CONTENT = new Set(['senderKeyDistributionMessage', 'messageContextInfo', 'reactionMessage', 'encReactionMessage',
  'pollUpdateMessage', 'protocolMessage', 'keepInChatMessage', 'pinInChatMessage', 'encEventResponseMessage'])

export function unwrap(m: any) {
  for (let i = 0; m && i < 5; i++) {
    const w = WRAPPERS.find(k => m[k]?.message)
    if (!w) break
    m = m[w].message
  }
  return m
}

const label = (kind: string, name?: string | null) => (name ? `${kind} ${name}` : kind)

export function describe(content: any): { kind: string, text: string | null } | null {
  const c = unwrap(content)
  if (!c) return null
  if (typeof c.conversation === 'string') return { kind: 'text', text: c.conversation }
  if (c.extendedTextMessage) return { kind: 'text', text: c.extendedTextMessage.text ?? '' }
  if (c.imageMessage) return { kind: 'image', text: c.imageMessage.caption || null }
  if (c.videoMessage) return { kind: c.videoMessage.gifPlayback ? 'gif' : 'video', text: c.videoMessage.caption || null }
  if (c.ptvMessage) return { kind: 'video note', text: null }
  if (c.audioMessage) return { kind: c.audioMessage.ptt ? 'voice' : 'audio', text: null }
  if (c.documentMessage) return { kind: label('document', c.documentMessage.fileName), text: c.documentMessage.caption || null }
  if (c.stickerMessage) return { kind: 'sticker', text: null }
  const loc = c.locationMessage ?? c.liveLocationMessage
  if (loc) return { kind: label('location', loc.name), text: loc.address || null }
  if (c.contactMessage) return { kind: label('contact', c.contactMessage.displayName), text: null }
  if (c.contactsArrayMessage) return { kind: label('contacts', c.contactsArrayMessage.displayName), text: null }
  const poll = c.pollCreationMessage ?? c.pollCreationMessageV2 ?? c.pollCreationMessageV3
  if (poll) return { kind: 'poll', text: [poll.name, ...(poll.options ?? []).map((o: any) => `- ${o.optionName}`)].join('\n') }
  if (c.eventMessage) return { kind: 'event', text: c.eventMessage.name || null }
  const keys = Object.keys(c).filter(k => c[k] != null)
  if (keys.every(k => NOT_CONTENT.has(k))) return null
  return { kind: 'other', text: null }
}

function expiresAt(msg: any, ts: number) {
  let d = toNum(msg.ephemeralDuration)
  const c = unwrap(msg.message)
  if (!d && c) for (const v of Object.values(c) as any[]) { d = toNum(v?.contextInfo?.expiration); if (d) break }
  return d > 0 ? ts + d : null
}

// ---------- events

export function putMessage(db: DatabaseSync, msg: any) {
  const key = msg?.key
  if (!key?.id || !key.remoteJid || skipJid(key.remoteJid)) return
  const d = describe(msg.message)
  if (!d) return
  const chat = canon(db, key.remoteJid, key.remoteJidAlt)
  const isGroup = chat.endsWith('@g.us')
  const fromMe = !!key.fromMe
  const sender = fromMe ? null : isGroup ? (key.participant ? canon(db, key.participant, key.participantAlt) : null) : chat
  const ts = toNum(msg.messageTimestamp) || now()
  q(db, `INSERT INTO chats(jid, is_group, last_ts) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET last_ts = max(coalesce(last_ts, 0), excluded.last_ts)`).run(chat, isGroup ? 1 : 0, ts)
  q(db, `INSERT OR IGNORE INTO messages(chat, id, ts, sender, from_me, text, kind, expires_ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(chat, key.id, ts, sender, fromMe ? 1 : 0, d.text, d.kind, expiresAt(msg, ts))
  if (sender && msg.pushName) {
    q(db, 'INSERT INTO contacts(jid, notify) VALUES (?, ?) ON CONFLICT(jid) DO UPDATE SET notify = excluded.notify')
      .run(sender, msg.pushName)
  }
}

function putChat(db: DatabaseSync, c: any) {
  if (!c?.id || skipJid(c.id)) return
  const jid = canon(db, c.id, c.pnJid)
  if (c.lidJid && isPn(jid)) addMap(db, c.lidJid, jid)
  const ts = toNum(c.conversationTimestamp) || null
  q(db, `INSERT INTO chats(jid, name, is_group, last_ts) VALUES (?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = coalesce(excluded.name, name),
    last_ts = max(coalesce(last_ts, 0), coalesce(excluded.last_ts, 0))`)
    .run(jid, c.name ?? c.subject ?? null, jid.endsWith('@g.us') ? 1 : 0, ts)
}

function putContact(db: DatabaseSync, c: any) {
  const id = normJid(c?.id)
  if (!id || skipJid(id)) return
  const lid = isLid(id) ? id : normJid(c.lid)
  const pn = isPn(id) ? id : normJid(c.phoneNumber)
  if (lid && pn) addMap(db, lid, pn)
  q(db, `INSERT INTO contacts(jid, name, notify) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = coalesce(excluded.name, name), notify = coalesce(excluded.notify, notify)`)
    .run(canon(db, id), c.name ?? null, c.notify ?? c.verifiedName ?? null)
}

function markDraft(db: DatabaseSync, messageId: string, state: string, error: string | null = null) {
  q(db, `UPDATE drafts SET state = ?, state_ts = ?, error = ? WHERE message_id = ? AND state IN ('sending', 'unknown')`)
    .run(state, now(), error, messageId)
}

function applyUpdate(db: DatabaseSync, { key, update }: any) {
  if (!key?.id || !update) return
  if (key.fromMe && typeof update.status === 'number') {
    if (update.status >= SERVER_ACK) markDraft(db, key.id, 'sent')
    if (update.status === STATUS_ERROR) markDraft(db, key.id, 'failed', `error ${update.messageStubParameters?.[0] ?? ''}`.trim())
  }
  if (!key.remoteJid || skipJid(key.remoteJid)) return
  const chat = canon(db, key.remoteJid, key.remoteJidAlt)
  if (update.message === null && update.messageStubType === STUB_REVOKE) {
    q(db, `UPDATE messages SET text = NULL, kind = 'deleted' WHERE chat = ? AND id = ?`).run(chat, key.id)
    return
  }
  const edited = update.message?.editedMessage?.message
  const d = edited && describe(edited)
  if (d) q(db, `UPDATE messages SET text = ? WHERE chat = ? AND id = ? AND kind != 'deleted'`).run(d.text, chat, key.id)
}

function dropChat(db: DatabaseSync, jid: string) {
  const j = canon(db, jid)
  q(db, 'DELETE FROM messages WHERE chat = ?').run(j)
  q(db, 'DELETE FROM chats WHERE jid = ?').run(j)
}

export function applyEvents(db: DatabaseSync, ev: any, state?: any) {
  const h = ev['messaging-history.set']
  db.exec('BEGIN')
  try {
    if (h) {
      for (const m of h.lidPnMappings ?? []) addMap(db, m.lid, m.pn)
      for (const c of h.contacts ?? []) putContact(db, c)
      for (const c of h.chats ?? []) putChat(db, c)
      for (const m of h.messages ?? []) putMessage(db, m)
    }
    const lm = ev['lid-mapping.update']
    if (lm) for (const m of [].concat(lm) as any[]) addMap(db, m.lid, m.pn)
    for (const c of [...(ev['contacts.upsert'] ?? []), ...(ev['contacts.update'] ?? [])]) putContact(db, c)
    for (const c of [...(ev['chats.upsert'] ?? []), ...(ev['chats.update'] ?? [])]) putChat(db, c)
    for (const g of [...(ev['groups.upsert'] ?? []), ...(ev['groups.update'] ?? [])]) if (g.subject) putChat(db, { id: g.id, name: g.subject })
    const up = ev['messages.upsert']
    if (up && (up.type === 'notify' || up.type === 'append')) for (const m of up.messages ?? []) putMessage(db, m)
    for (const u of ev['messages.update'] ?? []) applyUpdate(db, u)
    for (const r of ev['message-receipt.update'] ?? []) if (r.key?.fromMe && r.key.id) markDraft(db, r.key.id, 'sent')
    const del = ev['messages.delete']
    if (del && 'keys' in del) {
      for (const k of del.keys) if (k.remoteJid && !skipJid(k.remoteJid)) q(db, 'DELETE FROM messages WHERE chat = ? AND id = ?').run(canon(db, k.remoteJid, k.remoteJidAlt), k.id)
    } else if (del?.all && del.jid) {
      q(db, 'DELETE FROM messages WHERE chat = ?').run(canon(db, del.jid))
    }
    for (const j of ev['chats.delete'] ?? []) dropChat(db, j)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  if (h && state) {
    state.lastHistory = Date.now()
    if (state.history) state.history.stored = state.history.emitted
    state.onHistory?.(h)
  }
}

// Baileys sends the receipt of a history chunk before it downloads the chunk, and its event buffer merges
// the chunks into one event. Count each chunk when its download starts and when its event is made.
// After stopAfterChunk, stop in the event of the last started chunk: the closed socket then stops
// the offline queue of Baileys before the next node and its receipt.
export function trackHistory(ev: any, history: any, stop: () => void) {
  const emit = ev.emit.bind(ev)
  ev.emit = (event: string, data: any) => {
    // At each connect, Baileys also sends the full creds, with the old processedHistoryMessages.
    if (event === 'creds.update' && data && Object.keys(data).join() === 'processedHistoryMessages') history.started++
    if (event !== 'messaging-history.set') return emit(event, data)
    history.emitted++
    const r = emit(event, data)
    if (history.stopAfterChunk && !history.stopped && history.emitted >= history.started) {
      history.stopped = true
      stop()
    }
    return r
  }
}

const historyBusy = (state: any) => !!state.history && state.history.started > state.history.stored
const historyDownloading = (state: any) => !!state.history && state.history.started > state.history.emitted

// ---------- connection

function hasModules() {
  return fs.existsSync(path.join(HERE, 'node_modules', '.package-lock.json'))
}

function install() {
  const r = spawnSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: HERE, stdio: ['ignore', 2, 2] })
  if (r.status !== 0) throw new Error(`npm ci failed: ${r.error?.message ?? `exit code ${r.status}`}`)
}

const CLOSE: Record<number, string> = {
  401: 'WhatsApp logged the device out', 403: 'WhatsApp refused the connection (403)',
  405: 'WhatsApp refused the client version (405)', 408: 'time-out (408)', 428: 'connection closed (428)',
  440: 'connection replaced by another client with the same credentials (440)', 500: 'bad session (500)',
  503: 'WhatsApp unavailable (503)', 515: 'restart required (515)',
}

const closeText = (code: any) => CLOSE[code] ?? `connection closed (${code ?? 'no code'})`

export function sentProto(B: any, db: DatabaseSync, id?: string) {
  const row = id && q(db, 'SELECT proto FROM sent WHERE id = ?').get(id)
  return row ? B.proto.Message.decode(row.proto) : undefined
}

export async function connect(p: Paths, db: DatabaseSync, link?: { phone?: string, onCode: (code: string) => void, onQr: (qr: string) => void }) {
  const B: any = await import('@whiskeysockets/baileys')
  const auth = await B.useMultiFileAuthState(p.auth)
  const linked = !!auth.state.creds.account
  if (!linked && !link) throw new NeedLink(`not linked. The user must run "node ${path.join(HERE, 'wa.ts')} link" in a terminal for a QR code, or with "--phone NUMBER" for a pairing code`)
  if (linked && link) fail(`already linked. To link again, delete ${p.auth}, then run link`)
  const version = await Promise.race([B.fetchLatestBaileysVersion().then((r: any) => r.version), sleep(VERSION_LIMIT_MS)])
    .catch(() => undefined)
  const state: any = { pending: false, pendingAt: 0, lastHistory: 0, closed: null, error: null, history: null }
  for (let attempt = 0; attempt < 2; attempt++) {
    const sock = B.makeWASocket({
      ...(version ? { version } : {}),
      auth: auth.state,
      logger: SILENT,
      browser: B.Browsers.macOS('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      shouldIgnoreJid: skipJid,
      getMessage: async (key: any) => sentProto(B, db, key?.id),
    })
    state.history = { started: 0, emitted: 0, stored: 0, stopAfterChunk: false, stopped: false }
    trackHistory(sock.ev, state.history, () => endSock(sock))
    sock.ev.on('creds.update', auth.saveCreds)
    sock.ev.process(async (events: any) => {
      try { applyEvents(db, events, state) } catch (e: any) { state.error = e.message }
    })
    let asked = false
    const r: any = await new Promise(resolve => {
      sock.ev.on('connection.update', (u: any) => {
        if (u.qr && link && !link.phone) {
          try { link.onQr(u.qr) } catch (error) { resolve({ error }) }
        } else if (u.qr && link && !asked) {
          asked = true
          sock.requestPairingCode(link.phone).then(link.onCode, (error: any) => resolve({ error }))
        }
        if (u.receivedPendingNotifications) {
          state.pending = true
          state.pendingAt = Date.now()
        }
        if (u.connection === 'open') resolve({ open: true })
        if (u.connection === 'close') {
          state.closed = u.lastDisconnect?.error?.output?.statusCode ?? -1
          resolve({ code: state.closed })
        }
      })
    })
    if (r.open) return { sock, B, state }
    if (r.error) {
      endSock(sock)
      throw r.error
    }
    if (r.code === 515) {
      state.closed = null
      continue
    }
    if (r.code === 408 && link) fail(`${closeText(408)}: WhatsApp closed the connection before a link. Run link again`)
    if (r.code === 401) throw new NeedLink(`${closeText(401)}. The user must delete ${p.auth}, then run link`)
    throw new Error(closeText(r.code))
  }
  throw new Error('WhatsApp asked for a restart two times')
}

function endSock(sock: any) {
  try { sock.ev.flush() } catch {}
  try { sock.end(undefined) } catch {}
}

async function closeSock(conn: any) {
  const state = conn.state
  if (state && !state.closed && historyDownloading(state)) {
    state.history.stopAfterChunk = true
    const end = Date.now() + CHUNK_WAIT_MS
    while (!state.history.stopped && !state.closed && historyDownloading(state) && Date.now() < end) await sleep(100)
  }
  endSock(conn.sock)
}

export async function waitSync(state: any, limitMs = SYNC_LIMIT_MS) {
  const end = Date.now() + limitMs
  while (Date.now() < end) {
    if (state.closed) return closeText(state.closed)
    if (state.pending && !historyBusy(state) && Date.now() - Math.max(state.pendingAt, state.lastHistory) >= QUIET_MS) return state.error
    await sleep(100)
  }
  return state.error ?? `${limitMs / 1000} s limit`
}

function recordSync(db: DatabaseSync, problem: string | null) {
  setKV(db, 'last_attempt', String(now()))
  if (problem) return setKV(db, 'last_error', problem)
  setKV(db, 'last_complete', String(now()))
  setKV(db, 'last_error', '')
}

function recover(db: DatabaseSync) {
  q(db, `UPDATE drafts SET state = 'unknown', state_ts = ?, error = 'the process stopped during the send' WHERE state = 'sending'`)
    .run(now())
}

export async function withSync(p: Paths, db: DatabaseSync, offline: boolean, work?: (conn: any) => Promise<any>, connectFn = connect) {
  const run = async (status: string, conn: any = null, needLink = false) => ({ status, needLink, result: await work?.(conn) })
  if (offline) return run('off (--offline)')
  const lock = takeLock(p.lock, 0)
  if (!lock) return run('skipped (another call holds the lock)')
  let conn: any = null
  try {
    if (connectFn === connect && !hasModules()) {
      try { install() } catch (e: any) { return await run(`failed (${e.message})`) }
    }
    recover(db)
    try {
      conn = await connectFn(p, db)
    } catch (e: any) {
      if (!(e instanceof NeedLink) && e instanceof UserError) throw e
      recordSync(db, e.message)
      return run(`failed (${e.message})`, null, e instanceof NeedLink)
    }
    const problem = await waitSync(conn.state)
    recordSync(db, problem)
    return await run(problem ? `incomplete (${problem})` : 'complete', conn)
  } finally {
    if (conn) await closeSock(conn)
    releaseLock(lock)
  }
}

// ---------- output

// U+200D stays, because emoji sequences use it.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩\u061c\u200b\u200c\u200e\u200f\u2060-\u2064\u206a-\u206f\ufeff]/g

export const clean = (t: any) => String(t ?? '').replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(/\t/g, ' ')
export const oneLine = (t: any) => clean(t).replace(/\n/g, ' ⏎ ')

const pad = (n: number) => String(n).padStart(2, '0')

export function fmtDate(ts?: number | null) {
  if (!ts) return '-'
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function parseDate(s: string, today = new Date()) {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime() / 1000
  m = /^(\d+)([dwm])$/.exec(s)
  if (!m) fail(`bad date "${s}". Use 2026-09-01, 7d, 3w or 6m`)
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  if (m[2] === 'd') d.setDate(d.getDate() - +m[1])
  if (m[2] === 'w') d.setDate(d.getDate() - 7 * +m[1])
  if (m[2] === 'm') d.setMonth(d.getMonth() - +m[1])
  return d.getTime() / 1000
}

function phoneOf(db: DatabaseSync, jid: string) {
  const j = mapped(db, jid)
  return isPn(j) ? `+${j.split('@')[0]}` : ''
}

function nameOf(db: DatabaseSync, jid: string) {
  const j = mapped(db, jid)
  const chat = q(db, 'SELECT name FROM chats WHERE jid = ?').get(j)
  const contact = q(db, 'SELECT name, notify FROM contacts WHERE jid = ?').get(j)
  return clean(contact?.name || chat?.name || contact?.notify || phoneOf(db, j) || j.split('@')[0])
}

function chatLabel(db: DatabaseSync, jid: string) {
  const phone = phoneOf(db, jid)
  return `${nameOf(db, jid)} (${phone ? `${phone}, ` : ''}${jid})`
}

function msgLine(db: DatabaseSync, m: any, withChat: boolean, query?: string) {
  const who = m.from_me ? 'me' : nameOf(db, m.sender ?? m.chat)
  const marker = m.kind === 'text' ? '' : `[${clean(m.kind)}]${m.text ? ' ' : ''}`
  const text = query === undefined ? oneLine(m.text) : snippet(m.text, query)
  return `#${m.id} ${fmtDate(m.ts)}${withChat ? ` [${nameOf(db, m.chat)}]` : ''} ${who}: ${marker}${text}`
}

function snippet(t: any, query: string, max = 300) {
  const s = oneLine(t)
  if (s.length <= max) return s
  const word = query.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  const at = word ? Math.max(0, s.toLowerCase().indexOf(word)) : 0
  const start = Math.max(0, Math.min(at - 100, s.length - max))
  return `${start > 0 ? '…' : ''}${s.slice(start, start + max)}${start + max < s.length ? '…' : ''}`
}

export function statusLine(db: DatabaseSync, status: string) {
  const last = getKV(db, 'last_complete')
  return `sync: ${status}. Last complete sync: ${last ? fmtDate(+last) : 'never'}.`
}

// ---------- commands

function chatRows(db: DatabaseSync) {
  return q(db, `SELECT c.jid, c.is_group,
      (SELECT min(ts) FROM messages m WHERE m.chat = c.jid) AS oldest,
      coalesce((SELECT max(ts) FROM messages m WHERE m.chat = c.jid), c.last_ts, 0) AS last
    FROM chats c ORDER BY last DESC`).all()
    .map((r: any) => ({ ...r, name: nameOf(db, r.jid), phone: phoneOf(db, r.jid) }))
}

const chatRow = (c: any) => `${c.jid}  ${c.is_group ? 'group' : 'user'}  ${c.name}  ${c.phone || '-'}  oldest ${fmtDate(c.oldest).slice(0, 10)}`

export function resolveChat(db: DatabaseSync, arg: string): { jid?: string, phone?: string, matches?: any[] } {
  const a = arg.trim()
  const known = (j: string) => !!q(db, 'SELECT 1 FROM chats WHERE jid = ?').get(j)
  if (a.includes('@')) {
    const j = mapped(db, normJid(a)!)
    return known(j) ? { jid: j } : {}
  }
  const digits = a.replace(/[\s()+.-]/g, '')
  if (/^\d{6,15}$/.test(digits)) {
    const j = `${digits}@s.whatsapp.net`
    return known(j) ? { jid: j } : { phone: digits }
  }
  const low = a.toLowerCase()
  const hits = chatRows(db).filter((c: any) => c.name.toLowerCase().includes(low))
  return hits.length === 1 ? { jid: hits[0].jid } : hits.length ? { matches: hits } : {}
}

function chatOrFail(db: DatabaseSync, arg: string) {
  const r = resolveChat(db, arg)
  if (r.jid) return r.jid
  if (r.matches) fail(`more than one chat matches "${arg}". Give the JID:\n${r.matches.map(chatRow).join('\n')}`)
  fail(`no chat in the store matches "${arg}"`)
}

const int = (v: string | undefined, dflt: number, name: string) => {
  if (v === undefined) return dflt
  if (!/^\d+$/.test(v)) fail(`${name} must be a number`)
  return +v
}

export function chatsLines(db: DatabaseSync, o: any) {
  const limit = int(o.limit, 50, '--limit')
  if (o.type && o.type !== 'user' && o.type !== 'group') fail('--type must be user or group')
  const low = o.search?.toLowerCase()
  const rows = chatRows(db).filter((c: any) =>
    (!o.type || (o.type === 'group') === !!c.is_group) &&
    (!low || c.name.toLowerCase().includes(low) || c.phone.includes(low.replace(/[\s+]/g, '')) || c.jid.includes(low)))
  const lines = rows.slice(0, limit).map(chatRow)
  if (rows.length > limit) lines.push(`${rows.length - limit} more chats. Use --limit.`)
  if (!rows.length) lines.push('no chats')
  return lines
}

export function searchLines(db: DatabaseSync, query: string, o: any) {
  const limit = int(o.limit, 20, '--limit')
  const where: string[] = []
  const args: any[] = []
  if (query.trim()) {
    where.push('m.rid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)')
    args.push(`"${query.trim().replace(/"/g, '""')}"*`)
  }
  const chats = (o.chat ?? []).map((c: string) => chatOrFail(db, c))
  if (chats.length) {
    where.push(`m.chat IN (${chats.map(() => '?').join(', ')})`)
    args.push(...chats)
  }
  if (o.since) { where.push('m.ts >= ?'); args.push(parseDate(o.since)) }
  if (o.before) { where.push('m.ts < ?'); args.push(parseDate(o.before)) }
  const rows: any[] = db.prepare(`SELECT m.* FROM messages m ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY m.ts DESC, m.rid DESC LIMIT ?`).all(...args, limit + 1)
  const lines = rows.slice(0, limit).map(m => msgLine(db, m, chats.length !== 1, query))
  if (rows.length > limit) lines.push(`more messages match. Use --limit or a narrower search.`)
  if (!rows.length) lines.push('no messages')
  if (chats.length === 1) lines.unshift(chatHeader(db, chats[0]))
  return lines
}

function chatHeader(db: DatabaseSync, jid: string) {
  const r = q(db, 'SELECT min(ts) AS oldest, count(*) AS n FROM messages WHERE chat = ?').get(jid)
  return `chat: ${chatLabel(db, jid)}, ${r.n} stored messages since ${fmtDate(r.oldest).slice(0, 10)}`
}

export function contextLines(db: DatabaseSync, id: string, o: any) {
  const around = int(o.around, 5, '--around')
  let rows = q(db, 'SELECT * FROM messages WHERE id = ?').all(id)
  if (o.chat?.length) {
    const jid = chatOrFail(db, o.chat[0])
    rows = rows.filter((r: any) => r.chat === jid)
  }
  if (!rows.length) fail(`message ${id} is not in the store`)
  if (rows.length > 1) fail(`message ${id} is in more than one chat. Give --chat: ${rows.map((r: any) => r.chat).join(', ')}`)
  const t = rows[0]
  const before = q(db, `SELECT * FROM messages WHERE chat = ? AND (ts < ? OR (ts = ? AND rid < ?))
    ORDER BY ts DESC, rid DESC LIMIT ?`).all(t.chat, t.ts, t.ts, t.rid, around).reverse()
  const after = q(db, `SELECT * FROM messages WHERE chat = ? AND (ts > ? OR (ts = ? AND rid > ?))
    ORDER BY ts, rid LIMIT ?`).all(t.chat, t.ts, t.ts, t.rid, around)
  return [chatHeader(db, t.chat), ...[...before, t, ...after].map((m: any) => `${m.rid === t.rid ? '>' : ' '} ${msgLine(db, m, false)}`)]
}

export function draftLines(db: DatabaseSync, n: number, fresh = false) {
  const d = q(db, 'SELECT * FROM drafts WHERE n = ?').get(n)
  return [
    `draft ${d.n}: ${d.state}${d.error ? ` (${d.error})` : ''}`,
    `to: ${chatLabel(db, d.chat)}`,
    ...(fresh ? ['new chat, no history. A phone number can be wrong or belong to a new owner: check it with the user.'] : []),
    '----- text -----',
    ...clean(d.text).split('\n'),
    '----- end -----',
  ]
}

export function draftsLines(db: DatabaseSync) {
  const rows = q(db, `SELECT * FROM drafts WHERE state != 'sent' ORDER BY n`).all()
  return rows.length
    ? rows.map((d: any) => `#${d.n} ${d.state} ${fmtDate(d.created_ts)} to ${nameOf(db, d.chat)}: ${snippet(d.text, '', 200)}`)
    : ['no drafts']
}

const BAD_DRAFT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩\u061c\u200b\u200c\u200e\u200f\u2060-\u2064\u206a-\u206f\ufeff]/

export function checkDraftText(raw: string) {
  const t = raw.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  if (!t.trim()) fail('the draft text is empty. Give the text on stdin.')
  if (BAD_DRAFT.test(t)) fail('the draft text has control characters')
  return t
}

export async function makeDraft(db: DatabaseSync, arg: string, text: string, conn: any) {
  let r = resolveChat(db, arg)
  let fresh = false
  if (r.phone) {
    if (!conn) fail(`+${r.phone} has no chat in the store, and the script cannot ask WhatsApp now. See the sync line.`)
    const [w] = (await conn.sock.onWhatsApp(r.phone)) ?? []
    if (!w?.exists) fail(`+${r.phone} has no WhatsApp account`)
    r = { jid: normJid(w.jid) }
    fresh = true
  }
  const jid = r.jid ?? chatOrFail(db, arg)
  const info = q(db, 'INSERT INTO drafts(chat, text, created_ts) VALUES (?, ?, ?)').run(jid, text, now())
  return draftLines(db, Number(info.lastInsertRowid), fresh)
}

function checkDraft(db: DatabaseSync, n: number) {
  const d = q(db, 'SELECT * FROM drafts WHERE n = ?').get(n)
  if (!d) fail(`there is no draft ${n}`)
  if (d.state !== 'draft') fail(`draft ${n} has the state ${d.state}. The script does not send it again.`)
  return d
}

export async function sendDraft(db: DatabaseSync, n: number, conn: any, ackMs = ACK_MS) {
  const d = checkDraft(db, n)
  const { sock, B } = conn
  const id = B.generateMessageIDV2(sock.user?.id)
  const r = q(db, `UPDATE drafts SET state = 'sending', state_ts = ?, message_id = ? WHERE n = ? AND state = 'draft'`).run(now(), id, n)
  if (r.changes !== 1) fail(`draft ${n} changed its state. It is not sent.`)
  let ack: string | null = null
  const onAck = (node: any) => {
    if (node?.attrs?.id === id) ack = node.attrs.error ? `error ${node.attrs.error}` : 'ok'
  }
  sock.ws.on('CB:ack,class:message', onAck)
  const setState = (state: string, error: string | null) =>
    q(db, `UPDATE drafts SET state = ?, state_ts = ?, error = ? WHERE n = ? AND state = 'sending'`).run(state, now(), error, n)
  try {
    let msg: any
    try {
      msg = await withTimeout(sock.sendMessage(d.chat, { text: d.text }, { messageId: id }), SEND_LIMIT_MS, 'send')
    } catch (e: any) {
      setState('unknown', e.message)
      return draftLines(db, n)
    }
    if (msg?.message) {
      q(db, 'INSERT OR REPLACE INTO sent(id, chat, proto) VALUES (?, ?, ?)').run(id, d.chat, B.proto.Message.encode(msg.message).finish())
      putMessage(db, msg)
    }
    const end = Date.now() + ackMs
    while (!ack && Date.now() < end) await sleep(50)
    if (ack === 'ok') setState('sent', null)
    else if (ack) setState('failed', `WhatsApp refused the message: ${ack}`)
    else setState('unknown', `no server acknowledgement in ${ackMs / 1000} s`)
    return draftLines(db, n)
  } catch (e: any) {
    try { setState('unknown', e.message) } catch {}
    fail(`draft ${n}: the send state is unknown (${e.message}). The message can be out already: look at the chat on the phone.`)
  } finally {
    sock.ws.off('CB:ack,class:message', onAck)
  }
}

export async function sendCommand(p: Paths, db: DatabaseSync, n: number, connectFn = connect, ackMs = ACK_MS) {
  if (connectFn === connect && !hasModules()) fail('the packages are not installed. Run a read command first, for example "chats".')
  const lock = takeLock(p.lock, LOCK_WAIT_MS)
  if (!lock) fail(`another call holds the lock for more than ${LOCK_WAIT_MS / 1000} s`)
  let conn: any = null
  try {
    recover(db)
    checkDraft(db, n)
    conn = await connectFn(p, db)
    const problem = await waitSync(conn.state)
    recordSync(db, problem)
    return [statusLine(db, problem ? `incomplete (${problem})` : 'complete'), ...await sendDraft(db, n, conn, ackMs)]
  } finally {
    if (conn) await closeSock(conn)
    releaseLock(lock)
  }
}

export async function qrRenderer() {
  const lib: any = (await import(QR_MODULE)).default
  return (data: string) => {
    let text = ''
    lib.generate(data, { small: true }, (s: string) => { text = s })
    return text.trimEnd().split('\n').map(line => `${QR_COLORS}${line}\x1b[0m`).join('\n')
  }
}

async function linkCommand(p: Paths, db: DatabaseSync, phone?: string) {
  const lock = takeLock(p.lock, 0)
  if (!lock) fail('another call holds the lock')
  let conn: any = null
  try {
    // Modules from before the QR link do not have the QR module.
    if (!hasModules() || !fs.existsSync(path.join(HERE, 'node_modules', QR_MODULE))) install()
    const render = phone ? null : await qrRenderer()
    let codes = 0
    conn = await connect(p, db, {
      phone,
      onCode: code => console.log(`Pairing code: ${code}\nOn the phone: WhatsApp > Settings > Linked devices > Link a device > Link with phone number instead. Type the code.`),
      onQr: qr => console.log(`${render!(qr)}\nQR code ${++codes}, valid for ${codes === 1 ? 60 : 20} s. On the phone: WhatsApp > Settings > Linked devices > Link a device. Scan the code.`),
    })
    console.log(`Linked. The script now writes the history sync to the store. It stops when no history comes for ${LINK_QUIET_MS / 1000} s.`)
    const B = conn.B
    const start = Date.now()
    let last = Date.now()
    let stop = false
    process.once('SIGINT', () => { stop = true })
    conn.state.onHistory = (h: any) => {
      last = Date.now()
      const type = B.proto.HistorySync.HistorySyncType[h.syncType] ?? h.syncType
      console.error(`history: ${type}, progress ${h.progress ?? '-'}%, ${h.chats?.length ?? 0} chats, ${h.messages?.length ?? 0} messages`)
    }
    let problem: string | null = null
    for (;;) {
      if (stop) problem = 'stopped with Ctrl+C'
      else if (conn.state.closed) problem = closeText(conn.state.closed)
      else if (Date.now() - start >= LINK_LIMIT_MS) problem = `${LINK_LIMIT_MS / 60_000} min limit`
      else if (historyBusy(conn.state) || Date.now() - last < LINK_QUIET_MS) { await sleep(500); continue }
      break
    }
    problem = problem ?? conn.state.error
    recordSync(db, problem)
    const c = q(db, 'SELECT (SELECT count(*) FROM chats) AS chats, count(*) AS messages, min(ts) AS oldest FROM messages').get()
    return [statusLine(db, problem ? `incomplete (${problem})` : 'complete'),
      `store: ${c.chats} chats, ${c.messages} messages, oldest ${fmtDate(c.oldest)}`]
  } finally {
    if (conn) await closeSock(conn)
    releaseLock(lock)
  }
}

export async function main(argv: string[]) {
  let parsed: any
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        offline: { type: 'boolean' }, search: { type: 'string' }, type: { type: 'string' }, limit: { type: 'string' },
        chat: { type: 'string', multiple: true }, since: { type: 'string' }, before: { type: 'string' },
        around: { type: 'string' }, phone: { type: 'string' }, help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (e: any) {
    fail(`${e.message}\n${USAGE}`)
  }
  const { values: o, positionals } = parsed
  const [cmd, ...args] = positionals
  const out = (lines: string[]) => process.stdout.write(`${lines.join('\n')}\n`)
  if (!cmd || o.help) return out([USAGE])
  const p = paths()
  prepareState(p)
  const db = openStore(p.db)
  const read = async (lines: () => string[]) => {
    const s = await withSync(p, db, !!o.offline)
    out([statusLine(db, s.status), ...lines()])
    if (s.needLink) process.exitCode = 2
  }
  switch (cmd) {
    case 'chats': return read(() => chatsLines(db, o))
    case 'search': return read(() => searchLines(db, args.join(' '), o))
    case 'read':
      if (args.length !== 1 || o.chat) fail('usage: wa.ts read CHAT [--since D] [--before D] [--limit 20]')
      return read(() => searchLines(db, '', { ...o, chat: args }))
    case 'context':
      if (args.length !== 1) fail('usage: wa.ts context ID [--chat CHAT] [--around 5]')
      return read(() => contextLines(db, args[0], o))
    case 'drafts': return read(() => draftsLines(db))
    case 'draft': {
      if (args.length !== 1) fail('usage: wa.ts draft CHAT, with the text on stdin')
      if (process.stdin.isTTY) fail('give the draft text on stdin')
      const text = checkDraftText(fs.readFileSync(0, 'utf8'))
      const s = await withSync(p, db, !!o.offline, conn => makeDraft(db, args[0], text, conn))
      return out([statusLine(db, s.status), ...s.result])
    }
    case 'send':
      if (args.length !== 1 || !/^\d+$/.test(args[0])) fail('usage: wa.ts send N')
      return out(await sendCommand(p, db, +args[0]))
    case 'link': {
      const phone = o.phone?.replace(/[\s()+.-]/g, '')
      if (phone !== undefined && !/^\d{6,15}$/.test(phone)) fail('--phone needs the phone number of the account with the country code, for example --phone 34600000000')
      return out(await linkCommand(p, db, phone))
    }
    default: fail(`unknown command "${cmd}"\n${USAGE}`)
  }
}

const self = fileURLToPath(import.meta.url)
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(self)) {
  main(process.argv.slice(2))
    .catch((e: any) => {
      console.error(e instanceof UserError ? `error: ${e.message}` : e?.stack ?? String(e))
      process.exitCode = e?.exitCode ?? 1
    })
    .finally(() => setTimeout(() => process.exit(), 3000).unref())
}
