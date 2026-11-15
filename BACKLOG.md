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
