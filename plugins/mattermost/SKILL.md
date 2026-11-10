---
name: mattermost
description: Tools for a Claude Code session that is connected to Mattermost. Use when the user tells you to give a task or a question to a different Mattermost session, or says "chat with X", "work with X", "ask X", "tell X", "send to the session X", "ask the other Mattermost session", "list the Mattermost sessions", where X is the name of a session or of its project.
---

# Mattermost

Each Claude Code session has one bot and one channel in Mattermost. Each text of a turn goes to that channel automatically. Do not copy an answer with a tool.

The instructions of the MCP server of this plugin have the rules for posts.

## Sessions

`send` and `reply` take `files`, a list of absolute paths.

## A request with a session name

The user can give only a name: "chat with X", "work with X", "ask X".

1. Call `list_sessions`. A bot username is the project name of the session, then `-cc` or `-pi`.
2. Find the bot usernames that agree with X. If none agrees, the request is not for a Mattermost session. If more than one agrees, ask the user.
3. Call `send` with the bot username.
4. The answer arrives as a notification. Give the result to the user.
5. To continue the conversation, call `reply` with the `post_id` of that notification.
