# messages

A plugin for Claude Code and pi with one skill. The skill searches and reads the chats of the macOS Messages app: iMessage, SMS and RCS. It does not send, and it does not read Contacts.

## Access without Full Disk Access

macOS has no permission for the message history only. A program can read `~/Library/Messages/chat.db` with Full Disk Access, or as a sandboxed app to which the user gave that folder in the standard file panel. This plugin uses the second way:

- `reader/` is a small Swift program in an app bundle. It runs in the App Sandbox, with read-only access to the folder that you select and with no network access.
- `msg.py setup` builds the reader and opens the file panel. You select the folder `Messages`. The reader keeps a bookmark for it in its container.
- For each command, `msg.py` starts the reader, sends SQL statements to it, and gets the rows. The reader refuses a statement that is not read-only.

The terminal app gets no permission.

After `setup`, each program that runs with your account can start the reader and read all your messages, and macOS does not ask. The reader accepts only the folder `~/Library/Messages`, and it has no access to your other folders.

## Requirements

- macOS. SMS and RCS messages are on the Mac only when Text Message Forwarding is on in the settings of the iPhone.
- [uv](https://docs.astral.sh/uv/), which gets Python.
- `swiftc` and `codesign`, from the Command Line Tools (`xcode-select --install`).

## Setup

Run this one time in a terminal:

```sh
uv run <plugin folder>/msg.py setup
```

Run it again when a later version of the plugin changes `reader/`. The reader gets an ad-hoc signature. To sign with an identity of your keychain, set `MESSAGES_SIGN_IDENTITY` to its name.

## State

| Path                                                       | What it holds                           |
| ---------------------------------------------------------- | --------------------------------------- |
| `~/.local/state/messages/MessagesReader.app`               | The reader that `setup` built.          |
| `~/Library/Containers/io.github.andrewmed.messages-reader` | The container of the reader, with the bookmark. |

Delete the two to remove the reader and its access. The script keeps no copy of the messages.

## Tests

In this folder: `uv run dev/test_msg.py`. The tests make their own database and build the reader with no sandbox. They do not read the real messages.
