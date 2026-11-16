# telegram

A plugin for Claude Code and pi with one skill. The skill searches and reads the Telegram chats, groups and channels of the user, one chat at a time. It also makes drafts, and sends a draft after the user approved it. It does not mark messages as read.

`tg.py` connects with the account of the user, with [Telethon](https://github.com/LonamiWebs/Telethon).

## Requirements

[uv](https://docs.astral.sh/uv/), which gets Python, Telethon and qrcode from the inline metadata of the script.

## Sign in

Get `api_id` and `api_hash` at https://my.telegram.org > API development tools. Then run this one time in a terminal:

```sh
uv run <plugin folder>/tg.py login
```

The script asks for the API keys. Then there are two ways to sign in:

- A QR code: press Enter at the phone prompt. The script shows a QR code. In the Telegram app on the phone, open Settings > Devices > Link Desktop Device and scan it. The script shows a new QR code when the old one expires.
- A code: type the phone number. The script shows how Telegram sent the code, for example in the app or by SMS. If the code does not arrive, press Enter with no code: Telegram then sends a new code in the next way, when it has one. Telegram does not always deliver a code to a client that is not an official app. Then use the QR code.

After each way, the script asks for the 2FA password if the account has one.

To sign out, end the session in Telegram > Settings > Devices and delete the file `session`.

## Approval of each send

The script cannot know if you approved a draft. The agent asks you, as `SKILL.md` tells it. You approve in the terminal or in a Mattermost post. Pi has no permission prompt, so in pi this is the only control. To make Claude Code also ask you before each send, add this rule to `permissions.ask` in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "ask": ["Bash(uv run *tg.py send *)"]
  }
}
```

The rule has no effect in the `bypassPermissions` mode.

A message goes only to a chat that is in your chat list. It goes out as plain text, with no link preview. A message to a group or a channel is public for its members.

## State

All state is in `~/.local/state/telegram/`, with mode 0700:

| File        | What it holds                                                                      |
| ----------- | ---------------------------------------------------------------------------------- |
| `session`   | The API keys and the session, as plain text. They give full access to the account. |
| `drafts.db` | The drafts and their state. The script keeps no copy of the chats.                 |

Delete the folder to remove all of it.

## Network

`tg.py` opens raw TCP connections to the Telegram servers. If the sandbox of Claude Code is on, exclude the command from the sandbox, for example with `uv run */telegram/tg.py *` in `sandbox.excludedCommands`.

## Tests

In this folder: `uv run dev/test_tg.py`. The tests do not connect to Telegram.
