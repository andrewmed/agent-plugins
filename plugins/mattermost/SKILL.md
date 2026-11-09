---
name: mattermost
description: Tools for a Claude Code session that is connected to Mattermost. Use when a task needs a different Claude Code session, or when the user says "send to the session X", "ask the other session", "list the sessions".
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
