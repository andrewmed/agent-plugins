# Notes

Each section has a date. An old section can disagree with the code.

## Access to the message history, 2026-11-19

Measured on macOS 27.2.1:

- The permission names in `tccd` (`strings /System/Library/PrivateFrameworks/TCC.framework/Support/tccd | grep kTCCService`) have Reminders, Calendar and Contacts, but no name for Messages.
- `/System/Applications/Messages.app/Contents/Resources/Messages.sdef` has `chat`, `participant`, `account`, `file transfer` and the command `send`. It has no class for a message, so AppleScript cannot read the history.
- The only Shortcuts action of Messages is a Focus filter (`MessagesActionExtension.appex/Contents/Resources/Metadata.appintents/extract.actionsdata`).
- `TelephonyMessagingKit` is not available on macOS (`@available(macOS, unavailable)` in the SDK).
- `reader/build.sh` works with only the Command Line Tools and an ad-hoc signature. The built reader runs in the sandbox: macOS made its container at the first start.
- The terminal started `reader grant` as a child process. The file panel opened at `~/Library/Messages`, and the reader saved the bookmark.
- A reader that the terminal starts as a child process reads `chat.db` through the bookmark, with no Full Disk Access for the terminal app. The user ran `msg.py chats --limit 5`, and it printed 5 of 282 chats. Thus the three statements of `load_chats` agree with the real tables.
- The user ran `msg.py read --limit 3`, and it printed 3 SMS messages with their text. Thus the columns of `MESSAGE` in `msg.py` and the statement for the attachment tables agree with the real tables.
- The user ran `msg.py setup` and then `msg.py chats --limit 5` again. The new build accepted the folder, saved the access and read the chats. `setup` saves a new bookmark after each build, so this does not show if an old bookmark stays valid.

The permission system of Claude Code refused each read of the real database by the agent, also a read of only the exit code. The user must run a check with the real database.

Not measured:

- The bookmark stays valid after a new build with an ad-hoc signature.
- `search` and `context` with the real `chat.db`.
- A real message that has its text only in `attributedBody`, and a real message with an attachment.
- The read when Messages is not open. SQLite needs the `-shm` file to exist for a WAL database in a folder with read-only access (sqlite.org/wal.html, "Read-Only Databases").

## The text of a message, 2026-11-19

Messages leaves `message.text` empty for many rows and puts the text in `message.attributedBody`, an `NSArchiver` archive of an attributed string.

Measured with `NSArchiver.archivedDataWithRootObject_` in PyObjC on macOS 27.2.1, for `NSAttributedString` and `NSMutableAttributedString`: after the class name `NSString` come the bytes `01 94 84 01 2b` or `01 95 84 01 2b`, then the length, then the UTF-8 text. The length is one byte up to 127, `81` and 2 bytes for 128 or more, `82` and 4 bytes for 65536 or more, least significant byte first. `body_text` in `msg.py` reads this, and `dev/test_msg.py` has two of these archives.

Not measured: an archive from the real `chat.db`.
