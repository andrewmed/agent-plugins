# whatsapp: measured behavior

## Baileys in Node, without a link, 2026-11-15

Node 26.13.0 on macOS. `@whiskeysockets/baileys@7.0.0-rc13` and `pino@9`, installed with `npm install --ignore-scripts`: 70 packages, 49 MB, 14 s.

Method: a script made a socket with an empty `useMultiFileAuthState` folder and waited for the first `qr` in `connection.update`. It did not request a pairing code and did not link a device.

- `node:sqlite` has FTS5.
- `fetchLatestBaileysVersion()` gave `[2, 3000, 1043857760]` with `isLatest: true`, in 80 ms to 1.8 s.
- `browser: Browsers.macOS('Desktop')`: WhatsApp closed the connection with code 428 ("Connection Terminated") after the client payload. Same result with the default version of the library. With `syncFullHistory: true` and a `Desktop` name, Baileys sends `webSubPlatform: DARWIN` (`lib/Utils/validate-connection.js`).
- `browser: ['Hermes Agent', 'Chrome', '120.0']`: `qr` after 1.0 s.
- `browser: Browsers.macOS('Chrome')`: `qr` after 0.6 s.
- The Baileys default `shouldSyncHistoryMessage` returns `false` for `syncType` `FULL` (`lib/Defaults/index.js`).
- The library default version of rc13 is `[2, 3000, 1035194821]`. With it and `Browsers.macOS('Chrome')`, WhatsApp closed the connection with code 405. The fetched version worked.
- `sendMessage(jid, content, { messageId })` uses the given ID: `lib/Socket/messages-send.js` spreads `options` after its own `generateMessageIDV2`.
- npm 11.20.0.

Not tested: a link, a history sync, a send. These need the phone of the user.

## Checks during the implementation, 2026-11-15

Node 26.13.0, Claude Code 2.1.325, Baileys 7.0.0-rc13 source in `node_modules/@whiskeysockets/baileys/lib`.

- Server acknowledgement of a sent message: Baileys handles the node `CB:ack,class:message` in `handleBadAck` (`Socket/messages-recv.js`). It emits `messages.update` with status `ERROR` only when the node has an `error` attribute. An acknowledgement without an error gives no event. `wa.ts` listens to the node on `sock.ws`.
- Receipts from the recipient: `messages.update` with a status for a direct chat, `message-receipt.update` for a group.
- An edit and a revoke come as `messages.update` from `processMessage` (`Utils/process-message.js`): an edit as `update.message.editedMessage.message`, a revoke as `update.message: null` with `messageStubType` 1.
- `lid-mapping.update` gives one `{ lid, pn }` object. `messaging-history.set` gives `lidPnMappings`.
- `onWhatsApp` takes phone numbers and returns `{ jid, exists }` only for numbers with an account.
- `requestPairingCode` sends `should_show_push_notification: 'true'`: the phone of the number gets a notification. Do not test `link` with a number that is not the number of the user.
- FTS5 in `node:sqlite`: a phrase with no words (`""*`, `"***"*`, `"—"*`) finds nothing and gives no error.
- Lock: `BEGIN EXCLUSIVE` on an empty `lock.db`. A second process gets `database is locked` at once with `busy_timeout = 0`. After `kill -9` of the holder, the lock is free. A `DatabaseSync` object that nothing references is closed by garbage collection, and that releases the lock: keep the object until the release.
- Permission rule: `claude -p` with `allow: ["Bash(node:*)"]` and `ask: ["Bash(node *wa.ts send *)"]`, and a dummy `wa.ts`. `node <dir>/wa.ts chats` ran. `node <dir>/wa.ts send 1` was in `permission_denials`. Not tested in the interactive modes.
- The command line with `HOME` set to a temporary folder, not linked: `chats` printed `sync: failed (not linked. ...)` and exit code 2, in 0.2 s. The folder had mode 0700, `store.db` and `lock.db` mode 0600.

## History receipt and event buffer, 2026-11-15

Baileys 7.0.0-rc13 source in `node_modules/@whiskeysockets/baileys/lib`. Not measured with a real account.

- `handleMessage` (`Socket/messages-recv.js`) sends the delivery receipt and the `hist_sync` receipt before `upsertMessage`. `upsertMessage` (`Socket/chats.js`) downloads and processes the history chunk.
- `processMessage` (`Utils/process-message.js`) emits `creds.update` with `processedHistoryMessages` before the download, for each type except `ON_DEMAND`. After the download it emits `messaging-history.set`. These are the only emitters of the two.
- `upsertMessage` is a buffered function: `messaging-history.set` always goes into the event buffer. The buffer merges the chunks into one event (`Utils/event-buffer.js`). `creds.update` is not buffered.
- `end()` calls `ev.destroy()`, which discards the buffered events without a flush.
- The offline node queue (`Utils/offline-node-processor.js`) handles one node at a time, also after `receivedPendingNotifications`, and stops when the socket closes. A node that it did not start has no receipt.
- `B.makeEventBuffer` is exported. `dev/wa.test.ts` uses it to test the chunk count with the real buffer.
- `WebSocketClient.close()` (`Socket/Client/websocket.js`) calls `socket.close()` before its first `await`, so `isOpen` is false at once. `end()` calls it before its first `await` too. The offline queue checks `isWsOpen` before each node. A receipt sent on a closed `ws` socket does not go out.
- Nothing in `processMessage` after the `messaging-history.set` emit needs the socket. `wa.ts` closes the socket inside that emit.
- `ON_DEMAND` chunks have no `creds.update`, so `trackHistory` does not count them. `wa.ts` does not request them now.
- In the `Syncing` state, `upsertMessage` runs `doAppStateSync` and `processMessage` in one `Promise.all`. `end()` calls `signalRepository.close()` before its first `await`, so a close stops the app state sync. `Syncing` occurs only when `accountSyncCounter` is 0, that is, on the first connection after the link. Peer review, not measured.
