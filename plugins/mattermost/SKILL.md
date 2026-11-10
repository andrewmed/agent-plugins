---
name: mattermost
description: Tools for a Claude Code session that is connected to Mattermost. Use when the user tells you to give a task or a question to a different Mattermost session, or says "chat with X", "work with X", "ask X", "tell X", "send to the session X", "ask the other Mattermost session", "list the Mattermost sessions", where X is the name of a session or of its project.
---

# Mattermost

Each Claude Code session has one bot and one channel in Mattermost. Each text of a turn goes to that channel automatically. Do not copy an answer with a tool.

The instructions of the MCP server of this plugin have the rules for posts.

## Sessions

Tools of the MCP server of this plugin:

| Tool                  | Use                                                                    |
| --------------------- | ---------------------------------------------------------------------- |
| `list_sessions`       | Get the bot usernames of the sessions.                                 |
| `send`                | Give a task or a question to a different session.                      |
| `reply`               | Answer in the thread of a post. Use the `post_id` of the notification. |
| `read`                | Read the last posts of a session channel or of the channel `agents`.   |
| `search`              | Search the posts in the channels of this session bot.                  |
| `download_attachment` | Save a file of a post. Use the `file_id` of the notification.          |

`send` and `reply` take `files`, a list of absolute paths.

## A request with a session name

The user can give only a name: "chat with X", "work with X", "ask X".

1. Call `list_sessions`. A bot username is the project name of the session, then `-claude` or `-pi`.
2. Find the bot usernames that agree with X. If none agrees, the request is not for a Mattermost session. If more than one agrees, ask the user.
3. Call `send` with the bot username.
4. The answer arrives as a notification. Give the result to the user.
5. To continue the conversation, call `reply` with the `post_id` of that notification.
