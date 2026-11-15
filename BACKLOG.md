# Backlog

## whatsapp: no send after a closed connection, 2026-11-15

Aim: a draft keeps the state `draft` when the connection closes before the send.

Now: `sendCommand` in `plugins/whatsapp/wa.ts` calls `sendDraft` also when `waitSync` returns a close, for example code 440 or 401. Then `sendMessage` fails, and the draft gets the state `unknown`, but no message went out. The user must look at the phone and approve a new draft. `plugins/whatsapp/dev/DESIGN.md` says that a connection error keeps the state `draft`.

Change: in `sendCommand`, if `conn.state.closed` is set after `waitSync`, stop with an error before `sendDraft`. Add a test with a fake connection that closes during the sync. Estimate: 3 lines in `wa.ts`, 10 lines in `dev/wa.test.ts`.

## whatsapp: LID pairs from the history sync, 2026-11-15

Aim: a sender that WhatsApp gives as a LID shows with the phone number, when the history sync has the pair.

Now: Baileys 7.0.0-rc13 emits `messaging-history.set` inside `upsertMessage`, which always runs with the event buffer on (`Socket/chats.js`). The buffer merges the event and drops `lidPnMappings` (`append` and the flush map in `Utils/event-buffer.js`). Thus `applyEvents` in `plugins/whatsapp/wa.ts` never gets them. The pairs in `chat.pnJid` and `chat.lidJid` still come through `putChat`. The pairs from `phoneNumberToLidMappings` are lost, for example for the group members who have no chat with the user. The test in `dev/wa.test.ts` gives the event without the buffer, so it passes. `dev/NOTES.md` says that the event gives `lidPnMappings`: this is true only before the buffer.

Change: the `sock.ev.emit` wrapper in `trackHistory` sees each `messaging-history.set` before the buffer. Keep its `lidPnMappings` there, and write them with `addMap` in the next `applyEvents`. Test it with the real buffer (`B.makeEventBuffer`), as the chunk count test does. Correct `dev/NOTES.md`. Estimate: 5 lines in `wa.ts`, 15 lines in `dev/wa.test.ts`.

## whatsapp: older history for one chat, 2026-11-15

Aim: the agent finds a message that is older than the oldest message in the local store.

Now: the store has only the history sync after the link and the messages from later syncs. Design: `plugins/whatsapp/dev/DESIGN.md`.

Change: a command `wa.ts fetch CHAT [--count 50]`. It calls `sock.fetchMessageHistory(count, oldestKey, oldestTimestamp)` with the oldest stored message of the chat, and waits with a time limit for the `messaging-history.set` event of type `ON_DEMAND`. The phone must be online. Baileys emits no `creds.update` for an `ON_DEMAND` chunk, so `trackHistory` in `wa.ts` does not count it, and the close can cut its download: count these chunks in a different way. Do this only if test 1 of the design shows that the full history sync is too short. Estimate: about 40 lines in `wa.ts`.

## mattermost: status dot for each session, 2026-11-12

Aim: the owner sees a green dot when a session runs, as for a person.

Now: the Mattermost web client shows the status of a bot only in the "Members" panel of a channel (`webapp/channels/src/components/channel_members_rhs/member.tsx`). It shows no status for a bot in the sidebar (`sidebar_direct_channel.tsx`) or on posts (`post_profile_picture.tsx`). The bot goes `offline` when its socket closes.

Change: a normal user account for each session instead of a bot. Estimate: 40 to 60 lines in `mattermost.ts` and `session.ts`, 60 to 100 lines in the tests and `dev/fake-mattermost.ts`. All paths are in `plugins/mattermost`.

- `listBots` and `findOrCreateBot` in `mattermost.ts`: `GET /users` with the inactive users, and `POST /users`. A user has no `description`, so the session marker goes in `position` or `nickname`. A user needs a unique `email` and a `password`.
- A token of a normal user needs the role `system_user_access_token` (`PUT /users/<id>/roles`) and `EnableUserAccessTokens` on the server.
- `POST /bots/<id>/disable` and `/enable` become `PUT /users/<id>/active`.
- `session.ts` finds sessions with `is_bot` (`SESSION_BOT_RE` filters). Use the marker instead.
- Migration: a new user cannot get the username of a bot. Rename or delete each old bot, and move its channel `<username>` to the new user.

Result: a dot on posts, in a direct message in the sidebar, and in the "Members" panel. The sidebar shows no dot for the public session channel. Each session is a user in the user directory of the team.

Related defect: `shutdown` in `server.ts` sends the post `Session ended` with `set_online` before it closes the socket. If the post ends after the socket close, the bot stays `online`. Fix: send the end post with `set_online=false`, as `pi.ts` does.
