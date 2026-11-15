import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as wa from '../wa.ts'

const WA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'wa.ts')
const DM = '34600000001@s.whatsapp.net'
const LID = '99887766@lid'
const GROUP = '120363000000000001@g.us'

function store() {
  const p = wa.paths(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-')))
  wa.prepareState(p)
  return { p, db: wa.openStore(p.db) }
}

const msg = (chat: string, id: string, message: any, o: any = {}) => ({
  key: { remoteJid: chat, id, fromMe: !!o.fromMe, participant: o.participant, remoteJidAlt: o.alt },
  messageTimestamp: o.ts ?? 1_700_000_000,
  message,
  pushName: o.pushName,
})

const rows = (db: any, sql: string, ...a: any[]) => db.prepare(sql).all(...a)
const texts = (db: any) => rows(db, 'SELECT id, text, kind FROM messages ORDER BY id').map((r: any) => `${r.id}:${r.kind}:${r.text}`)

test('history sync stores chats, contacts and messages, and skips status, channels and duplicates', () => {
  const { db } = store()
  wa.applyEvents(db, {
    'messaging-history.set': {
      chats: [{ id: GROUP, name: 'Family' }, { id: 'status@broadcast' }],
      contacts: [{ id: DM, name: 'Anna Smith' }],
      messages: [
        msg(DM, 'A1', { conversation: 'hello invoice' }),
        msg(DM, 'A1', { conversation: 'duplicate' }),
        msg('status@broadcast', 'S1', { conversation: 'status' }),
        msg('123@newsletter', 'N1', { conversation: 'channel' }),
        msg(GROUP, 'G1', { extendedTextMessage: { text: 'group text' } }, { participant: DM }),
        msg(DM, 'P1', { protocolMessage: { type: 0 } }),
        msg(DM, 'R1', { reactionMessage: { text: '👍' } }),
      ],
    },
  })
  assert.deepEqual(texts(db), ['A1:text:hello invoice', 'G1:text:group text'])
  assert.deepEqual(rows(db, 'SELECT jid FROM chats ORDER BY jid').map((r: any) => r.jid), [GROUP, DM])
  const lines = wa.chatsLines(db, {})
  assert.match(lines.join('\n'), /Family/)
  assert.match(lines.join('\n'), /Anna Smith  \+34600000001/)
})

test('describe unwraps wrappers and marks media', () => {
  assert.deepEqual(wa.describe({ ephemeralMessage: { message: { viewOnceMessage: { message: { imageMessage: { caption: 'cap' } } } } } }), { kind: 'image', text: 'cap' })
  assert.deepEqual(wa.describe({ documentWithCaptionMessage: { message: { documentMessage: { fileName: 'a.pdf', caption: 'c' } } } }), { kind: 'document a.pdf', text: 'c' })
  assert.deepEqual(wa.describe({ audioMessage: { ptt: true } }), { kind: 'voice', text: null })
  assert.deepEqual(wa.describe({ senderKeyDistributionMessage: {}, conversation: 'x' }), { kind: 'text', text: 'x' })
  assert.equal(wa.describe({ senderKeyDistributionMessage: {}, messageContextInfo: {} }), null)
  assert.deepEqual(wa.describe({ somethingNew: {} }), { kind: 'other', text: null })
  assert.deepEqual(wa.describe({ pollCreationMessageV3: { name: 'Q', options: [{ optionName: 'a' }] } }), { kind: 'poll', text: 'Q\n- a' })
})

test('edit, revoke, delete and chat delete', () => {
  const { db } = store()
  wa.applyEvents(db, { 'messages.update': [{ key: { remoteJid: DM, id: 'X0' }, update: { message: { editedMessage: { message: { conversation: 'ghost' } } } } }] })
  assert.equal(rows(db, 'SELECT * FROM messages').length, 0)
  wa.applyEvents(db, {
    'messages.upsert': { type: 'notify', messages: [1, 2, 3, 4].map(i => msg(DM, `M${i}`, { conversation: `old text ${i}` })) },
  })
  wa.applyEvents(db, {
    'messages.update': [
      { key: { remoteJid: DM, id: 'M1' }, update: { message: { editedMessage: { message: { conversation: 'new words' } } } } },
      { key: { remoteJid: DM, id: 'M2' }, update: { message: null, messageStubType: 1 } },
    ],
  })
  assert.deepEqual(texts(db), ['M1:text:new words', 'M2:deleted:null', 'M3:text:old text 3', 'M4:text:old text 4'])
  assert.equal(wa.searchLines(db, 'old text 1', {}).at(-1), 'no messages')
  assert.equal(wa.searchLines(db, 'text 2', {}).at(-1), 'no messages')
  assert.match(wa.searchLines(db, 'new words', {})[0], /#M1 /)
  wa.applyEvents(db, { 'messages.delete': { keys: [{ remoteJid: DM, id: 'M3' }] } })
  assert.deepEqual(texts(db), ['M1:text:new words', 'M2:deleted:null', 'M4:text:old text 4'])
  wa.applyEvents(db, { 'messages.delete': { jid: DM, all: true } })
  assert.equal(rows(db, 'SELECT * FROM messages').length, 0)
  wa.applyEvents(db, { 'messages.upsert': { type: 'append', messages: [msg(GROUP, 'G1', { conversation: 'x' })] } })
  wa.applyEvents(db, { 'chats.delete': [GROUP] })
  assert.equal(rows(db, 'SELECT * FROM messages').length, 0)
  assert.deepEqual(rows(db, 'SELECT jid FROM chats').map((r: any) => r.jid), [DM])
})

test('an expired disappearing message is removed when the store opens', () => {
  const { p, db } = store()
  const old = Math.floor(Date.now() / 1000) - 1000
  wa.applyEvents(db, {
    'messages.upsert': {
      type: 'notify',
      messages: [
        msg(DM, 'E1', { ephemeralMessage: { message: { extendedTextMessage: { text: 'gone', contextInfo: { expiration: 60 } } } } }, { ts: old }),
        msg(DM, 'E2', { conversation: 'stays' }, { ts: old }),
      ],
    },
  })
  assert.equal(rows(db, 'SELECT * FROM messages').length, 2)
  db.close()
  assert.deepEqual(texts(wa.openStore(p.db)), ['E2:text:stays'])
})

test('a LID pair that comes after its messages moves them to the phone number', () => {
  const { db } = store()
  wa.applyEvents(db, {
    'messages.upsert': { type: 'notify', messages: [msg(LID, 'L1', { conversation: 'from lid' }, { pushName: 'Bob' })] },
    'chats.upsert': [{ id: DM, name: null }],
  })
  wa.applyEvents(db, { 'messages.upsert': { type: 'notify', messages: [msg(DM, 'L2', { conversation: 'from pn' })] } })
  assert.deepEqual(rows(db, 'SELECT DISTINCT chat FROM messages ORDER BY chat').map((r: any) => r.chat), [DM, LID])
  wa.applyEvents(db, { 'lid-mapping.update': { lid: LID, pn: DM } })
  assert.deepEqual(rows(db, 'SELECT chat, sender FROM messages ORDER BY id').map((r: any) => `${r.chat} ${r.sender}`), [`${DM} ${DM}`, `${DM} ${DM}`])
  assert.deepEqual(rows(db, 'SELECT jid FROM chats').map((r: any) => r.jid), [DM])
  assert.equal(wa.resolveChat(db, 'bob').jid, DM)
  assert.equal(wa.resolveChat(db, LID).jid, DM)
  assert.equal(wa.resolveChat(db, '+34 600 000 001').jid, DM)
  assert.equal(wa.resolveChat(db, '34600000002').phone, '34600000002')
})

test('the search query is literal text, and control characters are removed', () => {
  const { db } = store()
  wa.applyEvents(db, {
    'messages.upsert': {
      type: 'notify',
      messages: [
        msg(DM, 'Q1', { conversation: 'say "hi" OR not' }),
        msg(DM, 'Q2', { conversation: 'invoice‮\u0007 total\nline two' }),
      ],
    },
  })
  assert.match(wa.searchLines(db, '"hi" OR', {})[0], /#Q1 /)
  assert.match(wa.searchLines(db, 'invo*', {}).at(-1)!, /no messages|#Q2/)
  assert.match(wa.searchLines(db, 'invo', {})[0], /#Q2 .*: invoice total ⏎ line two$/)
  assert.deepEqual(wa.searchLines(db, '"*"', {}), ['no messages'])
  assert.equal(wa.oneLine('a\u001b[31mb\r\nc⁦'), 'a[31mb ⏎ c')
})

test('search filters by chat and date, and context shows the neighbours', () => {
  const { db } = store()
  const day = (d: string) => new Date(`${d}T12:00:00`).getTime() / 1000
  wa.applyEvents(db, {
    'messages.upsert': {
      type: 'notify',
      messages: [
        msg(DM, 'D1', { conversation: 'one' }, { ts: day('2026-01-01') }),
        msg(DM, 'D2', { conversation: 'two' }, { ts: day('2026-01-02') }),
        msg(DM, 'D3', { conversation: 'three' }, { ts: day('2026-01-03'), fromMe: true }),
        msg(GROUP, 'D4', { conversation: 'four' }, { ts: day('2026-01-02'), participant: DM }),
      ],
    },
  })
  const s = wa.searchLines(db, '', { chat: [DM], since: '2026-01-02', before: '2026-01-03' })
  assert.equal(s.length, 2)
  assert.match(s[0], /^chat: .*\(\+34600000001, 34600000001@s.whatsapp.net\), 3 stored messages since 2026-01-01/)
  assert.match(s[1], /^#D2 2026-01-02 12:00 \+34600000001: two$/)
  const c = wa.contextLines(db, 'D2', { around: '1' })
  assert.deepEqual(c.slice(1).map(l => l.slice(0, 5)), ['  #D1', '> #D2', '  #D3'])
  assert.match(c[3], /me: three$/)
  assert.throws(() => wa.searchLines(db, '', { since: 'yesterday' }), /bad date/)
})

test('drafts do not change, and an ambiguous chat stops the draft', async () => {
  const { db } = store()
  wa.applyEvents(db, { 'chats.upsert': [{ id: GROUP, name: 'Team A' }, { id: '120363000000000002@g.us', name: 'Team B' }] })
  await assert.rejects(wa.makeDraft(db, 'team', 'hi', null), /more than one chat matches "team"/)
  await assert.rejects(wa.makeDraft(db, '34600000009', 'hi', null), /cannot ask WhatsApp now/)
  const lines = await wa.makeDraft(db, 'Team A', 'hi\nthere', null)
  assert.deepEqual(lines, ['draft 1: draft', `to: Team A (${GROUP})`, '----- text -----', 'hi', 'there', '----- end -----'])
  assert.throws(() => db.prepare('UPDATE drafts SET text = ? WHERE n = 1').run('changed'), /a draft does not change/)
  assert.throws(() => wa.checkDraftText('a\u0007b'), /control characters/)
  assert.throws(() => wa.checkDraftText(' \n'), /empty/)
  assert.equal(wa.checkDraftText('a\r\nb\n\n'), 'a\nb')
})

test('a draft for a new phone number asks WhatsApp and warns', async () => {
  const { db } = store()
  const conn = { sock: { onWhatsApp: async (n: string) => (n === '34600000009' ? [{ jid: '34600000009@s.whatsapp.net', exists: true }] : []) } }
  await assert.rejects(wa.makeDraft(db, '34600000008', 'hi', conn), /has no WhatsApp account/)
  const lines = await wa.makeDraft(db, '+34 600 000 009', 'hi', conn)
  assert.equal(lines[1], 'to: +34600000009 (+34600000009, 34600000009@s.whatsapp.net)')
  assert.match(lines[2], /^new chat, no history/)
})

let ids = 0

function fakeConn(o: { ack?: string | null, throwSend?: boolean, echo?: (m: any) => void } = {}) {
  const ws = new EventEmitter()
  const calls: any[] = []
  const ack = o.ack === undefined ? 'ok' : o.ack
  const sock = {
    user: { id: '34600000000:5@s.whatsapp.net' },
    ws,
    end() {},
    async sendMessage(jid: string, content: any, opts: any) {
      calls.push({ jid, content, opts })
      if (o.throwSend) throw new Error('socket closed')
      const m = { key: { remoteJid: jid, id: opts.messageId, fromMe: true }, messageTimestamp: 1_700_000_100, message: { conversation: content.text } }
      o.echo?.(m)
      if (ack) setTimeout(() => ws.emit('CB:ack,class:message', { attrs: ack === 'ok' ? { id: opts.messageId } : { id: opts.messageId, error: ack } }), 5)
      return m
    },
  }
  const B = {
    generateMessageIDV2: () => `3EB0TEST${++ids}`,
    proto: { Message: { encode: (m: any) => ({ finish: () => new TextEncoder().encode(JSON.stringify(m)) }) } },
  }
  return { sock, B, calls, state: { pending: true, pendingAt: 0, lastHistory: 0, closed: null, error: null } }
}

async function draftIn(db: any, text = 'hello') {
  wa.applyEvents(db, { 'chats.upsert': [{ id: DM, name: 'Anna' }] })
  const lines = await wa.makeDraft(db, 'Anna', text, null)
  return Number(/^draft (\d+)/.exec(lines[0])![1])
}

const draft = (db: any, n: number) => db.prepare('SELECT * FROM drafts WHERE n = ?').get(n)

test('send: the socket gets the stored JID, the text and the stored ID; a second send is refused', async () => {
  const { p, db } = store()
  const n = await draftIn(db, 'line 1\nline 2')
  const conn = fakeConn({ echo: m => wa.applyEvents(db, { 'messages.upsert': { type: 'append', messages: [m] } }) })
  const lines = await wa.sendCommand(p, db, n, async () => conn, 1000)
  assert.match(lines[0], /^sync: complete\./)
  assert.equal(lines[1], `draft ${n}: sent`)
  assert.equal(conn.calls.length, 1)
  const d = draft(db, n)
  assert.deepEqual(conn.calls[0], { jid: DM, content: { text: 'line 1\nline 2' }, opts: { messageId: d.message_id } })
  assert.equal(rows(db, 'SELECT * FROM messages WHERE id = ?', d.message_id).length, 1)
  assert.equal(rows(db, 'SELECT * FROM sent WHERE id = ?', d.message_id).length, 1)
  await assert.rejects(wa.sendCommand(p, db, n, async () => fakeConn(), 1000), /has the state sent/)
})

test('send: no acknowledgement gives unknown, and a later receipt gives sent', async () => {
  const { p, db } = store()
  const n = await draftIn(db)
  const lines = await wa.sendCommand(p, db, n, async () => fakeConn({ ack: null }), 100)
  assert.equal(lines[1], `draft ${n}: unknown (no server acknowledgement in 0.1 s)`)
  await assert.rejects(wa.sendCommand(p, db, n, async () => fakeConn(), 100), /has the state unknown/)
  const id = draft(db, n).message_id
  wa.applyEvents(db, { 'messages.update': [{ key: { remoteJid: DM, id, fromMe: true }, update: { status: 3 } }] })
  assert.equal(draft(db, n).state, 'sent')
})

test('send: an error acknowledgement gives failed, and an exception gives unknown', async () => {
  const { p, db } = store()
  const a = await draftIn(db)
  assert.equal((await wa.sendCommand(p, db, a, async () => fakeConn({ ack: '463' }), 1000))[1], `draft ${a}: failed (WhatsApp refused the message: error 463)`)
  const b = await draftIn(db)
  assert.equal((await wa.sendCommand(p, db, b, async () => fakeConn({ throwSend: true }), 1000))[1], `draft ${b}: unknown (socket closed)`)
})

test('send: an error after sendMessage gives unknown, and the ack listener is removed', async () => {
  const { p, db } = store()
  const n = await draftIn(db)
  const conn = fakeConn()
  conn.B.proto.Message.encode = () => { throw new Error('disk full') }
  await assert.rejects(wa.sendCommand(p, db, n, async () => conn, 1000), /draft \d+: the send state is unknown \(disk full\)/)
  assert.equal(draft(db, n).state, 'unknown')
  assert.equal(conn.sock.ws.listenerCount('CB:ack,class:message'), 0)
})

test('send: a connection error keeps the draft, and a draft left in sending becomes unknown', async () => {
  const { p, db } = store()
  const a = await draftIn(db)
  await assert.rejects(wa.sendCommand(p, db, a, async () => { throw new Error('no network') }, 100), /no network/)
  assert.equal(draft(db, a).state, 'draft')
  db.prepare(`UPDATE drafts SET state = 'sending', message_id = 'X' WHERE n = ?`).run(a)
  const b = await draftIn(db)
  await wa.sendCommand(p, db, b, async () => fakeConn(), 1000)
  assert.equal(draft(db, a).state, 'unknown')
  assert.deepEqual(wa.draftsLines(db), [`#${a} unknown ${wa.fmtDate(draft(db, a).created_ts)} to Anna: hello`])
})

test('withSync: no link gives a failed sync, and the command still reads the store', async () => {
  const { p, db } = store()
  const s = await wa.withSync(p, db, false, async conn => conn, async () => { throw new wa.NeedLink('not linked') })
  assert.deepEqual(s, { status: 'failed (not linked)', needLink: true, result: null })
  const lock = wa.takeLock(p.lock, 0)!
  assert.equal((await wa.withSync(p, db, false, undefined, async () => fakeConn())).status, 'skipped (another call holds the lock)')
  wa.releaseLock(lock)
  assert.equal((await wa.withSync(p, db, true)).status, 'off (--offline)')
})

test('waitSync: the time limit gives an incomplete sync', async () => {
  assert.equal(await wa.waitSync({ pending: false, closed: null, error: null }, 200), '0.2 s limit')
  assert.equal(await wa.waitSync({ pending: false, closed: 440, error: null }, 200), 'connection replaced by another client with the same credentials (440)')
})

test('history chunks: count the chunks, and stop in the event of the last started chunk', () => {
  const { db } = store()
  const state: any = { historyStarted: 0, historyEmitted: 0, historyStored: 0, stopAfterChunk: false, stopped: false }
  const buffered: any[] = []
  let stops = 0
  const ev: any = { emit: (event: string, data: any) => buffered.push([event, data]) }
  wa.trackHistory(ev, state, () => stops++)
  ev.emit('creds.update', { processedHistoryMessages: [{}] })
  ev.emit('creds.update', { me: {} })
  assert.deepEqual([state.historyStarted, state.historyEmitted], [1, 0])
  ev.emit('messaging-history.set', { messages: [msg(DM, 'H1', { conversation: 'old' })] })
  ev.emit('creds.update', { processedHistoryMessages: [{}, {}] })
  assert.deepEqual([state.historyStarted, state.historyEmitted, state.historyStored], [2, 1, 0])
  wa.applyEvents(db, { 'messaging-history.set': buffered[2][1] }, state)
  assert.deepEqual([state.historyStarted, state.historyStored], [2, 1])
  state.stopAfterChunk = true
  ev.emit('creds.update', { processedHistoryMessages: [{}, {}, {}] })
  ev.emit('messaging-history.set', { messages: [] })
  assert.equal(stops, 0)
  ev.emit('messaging-history.set', { messages: [] })
  assert.deepEqual([stops, state.stopped], [1, true])
  ev.emit('messaging-history.set', { messages: [] })
  assert.equal(stops, 1)
  assert.equal(buffered.length, 8)
})

test('history chunks with the real Baileys event buffer: a buffered chunk is stored at the flush', async () => {
  const B: any = await import('@whiskeysockets/baileys')
  const { db } = store()
  const silent: any = { level: 'silent', child: () => silent, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} }
  const ev = B.makeEventBuffer(silent)
  const state: any = { historyStarted: 0, historyEmitted: 0, historyStored: 0 }
  wa.trackHistory(ev, state, () => {})
  ev.process((events: any) => wa.applyEvents(db, events, state))
  const chunk = (id: string) => ({ chats: [], contacts: [], messages: [msg(DM, id, { conversation: id })], syncType: 2 })
  ev.buffer()
  ev.emit('creds.update', { processedHistoryMessages: [{}] })
  ev.emit('messaging-history.set', chunk('H1'))
  ev.emit('creds.update', { processedHistoryMessages: [{}, {}] })
  assert.deepEqual([state.historyStarted, state.historyEmitted, state.historyStored], [2, 1, 0])
  assert.deepEqual(texts(db), [])
  ev.flush()
  assert.deepEqual([state.historyStored, texts(db)], [1, ['H1:text:H1']])
  ev.emit('messaging-history.set', chunk('H2'))
  assert.deepEqual([state.historyStored, texts(db)], [2, ['H1:text:H1', 'H2:text:H2']])
})

test('waitSync: no complete sync while a history chunk is not stored', async () => {
  const state: any = { pending: true, pendingAt: 0, lastHistory: 0, closed: null, error: null, historyStarted: 1, historyStored: 0 }
  assert.equal(await wa.waitSync(state, 300), '0.3 s limit')
  state.historyStored = 1
  assert.equal(await wa.waitSync(state, 300), null)
})

test('withSync: the Baileys event buffer is flushed before the socket closes', async () => {
  const { p, db } = store()
  const calls: string[] = []
  const conn: any = fakeConn()
  conn.sock.ev = { flush: () => calls.push('flush') }
  conn.sock.end = () => calls.push('end')
  await wa.withSync(p, db, false, undefined, async () => conn)
  assert.deepEqual(calls, ['flush', 'end'])
})

test('withSync: the close waits for the history chunk that downloads, and stops in its event', async () => {
  const { p, db } = store()
  const calls: string[] = []
  const conn: any = fakeConn()
  const ev: any = { emit: () => calls.push('emit'), flush: () => calls.push('flush') }
  conn.sock.ev = ev
  conn.sock.end = () => calls.push('end')
  Object.assign(conn.state, { historyStarted: 0, historyEmitted: 0, historyStored: 0, stopAfterChunk: false, stopped: false })
  wa.trackHistory(ev, conn.state, () => calls.push('stop'))
  const t = Date.now()
  await wa.withSync(p, db, false, async () => {
    ev.emit('creds.update', { processedHistoryMessages: [{}] })
    setTimeout(() => ev.emit('messaging-history.set', { messages: [] }), 300)
  }, async () => conn)
  assert.ok(Date.now() - t >= 300)
  assert.deepEqual(calls, ['emit', 'emit', 'stop', 'flush', 'end'])
})

function child(code: string) {
  const c = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  c.stdout.on('data', d => { out += d })
  c.stderr.on('data', d => { out += d })
  const done = new Promise<string>(resolve => c.on('close', () => resolve(out)))
  const line = (s: string) => new Promise<void>(resolve => { const t = setInterval(() => { if (out.includes(s)) { clearInterval(t); resolve() } }, 20) })
  return { c, done, line }
}

test('the lock: a second holder waits, and the lock goes when its process is killed', async () => {
  const { p } = store()
  const h = child(`import * as wa from ${JSON.stringify(WA)}; globalThis.lock = wa.takeLock(${JSON.stringify(p.lock)}, 0); console.log(globalThis.lock ? 'locked' : 'not locked'); setTimeout(() => {}, 60000)`)
  await h.line('locked')
  assert.equal(wa.takeLock(p.lock, 0), null)
  h.c.kill('SIGKILL')
  await h.done
  const lock = wa.takeLock(p.lock, 0)
  assert.ok(lock)
  wa.releaseLock(lock)
})

test('two send processes at the same time send one message', async () => {
  const { p, db } = store()
  const n = await draftIn(db)
  db.close()
  const code = `
    import { EventEmitter } from 'node:events'
    import * as wa from ${JSON.stringify(WA)}
    const p = wa.paths(${JSON.stringify(p.dir)})
    const db = wa.openStore(p.db)
    const ws = new EventEmitter()
    const sock = { user: {}, ws, end() {}, async sendMessage(jid, c, o) {
      console.log('CALLED'); await new Promise(r => setTimeout(r, 300))
      setTimeout(() => ws.emit('CB:ack,class:message', { attrs: { id: o.messageId } }), 5)
      return { key: { remoteJid: jid, id: o.messageId, fromMe: true }, message: { conversation: c.text } } } }
    const B = { generateMessageIDV2: () => 'ID' + process.pid, proto: { Message: { encode: m => ({ finish: () => new Uint8Array(1) }) } } }
    try { console.log((await wa.sendCommand(p, db, ${n}, async () => ({ sock, B, state: { pending: true, pendingAt: 0, lastHistory: 0 } }), 1000)).join('|')) }
    catch (e) { console.log('ERROR ' + e.message) }`
  const outs = await Promise.all([child(code).done, child(code).done])
  assert.equal(outs.join('').split('CALLED').length - 1, 1, outs.join('\n'))
  assert.equal(outs.filter(o => o.includes(`draft ${n}: sent`)).length, 1)
  assert.equal(outs.filter(o => o.includes('has the state sent')).length, 1)
})

test('getMessage: the stored proto decodes to the sent message', async () => {
  const B: any = await import('@whiskeysockets/baileys')
  const bytes = B.proto.Message.encode({ conversation: 'hi ünïcode' }).finish()
  const { db } = store()
  db.prepare('INSERT INTO sent(id, chat, proto) VALUES (?, ?, ?)').run('S1', DM, bytes)
  assert.equal(wa.sentProto(B, db, 'S1').conversation, 'hi ünïcode')
  assert.equal(wa.sentProto(B, db, 'S2'), undefined)
})
