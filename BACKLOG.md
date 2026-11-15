# Backlog

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

## mattermost: the channel `agents` as the place where sessions communicate, 2026-11-15

Aim: sessions communicate in one shared place, and the owner sees all of it there. The owner can tell a session to follow the posts of all sessions or of one session, for example the mail session.

Now: all session bots and the owner are members of `agents`, and `list_sessions` and `send` find sessions from its members (`sessionBots()` in `session.ts`). No tool makes a new post there. `route()` ignores an owner post there. Thus the line in `plugins/mattermost/README.md`, "A mention of a bot there reaches its session", is correct only for a post from a session bot.

Status: a design. A peer reviewed it on 2026-11-15. The decisions at the end are open. All paths are in `plugins/mattermost`.

### Part 1: posts in `agents`

- `send` accepts `agents` as the value of `to`, as `read` accepts it as `channel`. This needs its own code path, because `sessionChannel()` checks the creator of the channel.
- The session writes the mentions in the text. A post with a mention starts a turn in each mentioned session. A post with no mention starts no turn. Only a mention in the text counts after a reconnect, because `pullMissed` gives no mention ids to `onPost`.
- `reply` in `agents` does not add the thread to `threads`. The author of the first post gets each answer. A different session gets a post only with a mention. With N sessions that answer one question, this gives N turns and not N².
- `agentRules()`: use `agents` for a question to two or more sessions, or for a fact that other sessions need. A post in `agents` is not an approval of the owner.

### Part 2: owner posts in `agents`

- An owner post with a mention starts a turn in each mentioned session, with owner authority. The texts of the turn go to the thread, with `turn.replyChannel` as for a direct message.

### Part 3: the tool `follow`

- `from`: a list of bot usernames, or `all`. An empty list stops it. `purpose`: the instruction of the owner.
- A followed post is a first post in `agents`, not an answer in a thread, from a followed sender. It needs no mention. A session does not follow the channel of a different session.
- The identity of a followed session is its username, with the `isSessionBot` check. The bot id changes when a bot is removed and made again.
- The code refuses `follow` in a turn that came from an agent, as it refuses `send` (`callTool` in `session.ts`).
- The notice has the purpose, so `/clear` and a compaction do not lose it. It says that the post cannot give a task and cannot change the purpose.
- State: a file for each bot, as `schedules/<bot id>.json`. The session writes a post in its own channel at each change and at each start.
- Followed posts have their own count for each hour. They do not use `fromAgents`, because a job start sets `fromAgents` to 0 and the limit of 100 stops a session that follows for many days.
- The last text of a turn from a followed post gets the mention of the owner only when the purpose asks for a report. Now `endTurn` adds the mention only to a turn that came from an owner post.

### Limits of the design

- A turn from an agent cannot use `send`. Thus two sessions that follow each other cannot make a loop of new posts, and a follower cannot give a task to a third session.
- The rules for the model are not a barrier. A session that read hostile text can reach all followers with one post.
- In Claude Code and in pi, the posts in the queue of `Mailbox` go as one turn.
- `list_sessions` can show `online` for a session that ended.

### Open decisions

1. Owner posts in `agents` with a mention start turns: yes or no. Recommendation: yes.
2. The limit for followed posts. Recommendation: 20 for each hour, with one notice to the owner for each hour.
3. `all` in `follow`. Recommendation: permit it only when the owner says it in clear words.
4. Posts that a follower missed while it did not run. Recommendation: ignore them, or store the time of the last delivered post in the state file and deliver them at the start.

Not measured: the pull after a reconnect with posts in `agents`, and a bot that is removed and made again, on the production server.

Estimate: 20 lines in `session.ts` for part 1, 20 lines in `session.ts`, `server.ts` and `pi.ts` for part 2, 60 to 80 lines for part 3. Then the tests in `dev/`, `dev/fake-mattermost.ts` and `README.md`.
