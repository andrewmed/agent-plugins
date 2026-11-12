# mail

A Claude Code plugin with one skill. The skill reads two mailboxes over IMAP, saves drafts and trashes messages with `mail.py`. It does not send.

## Configuration

`mail.py` reads the addresses and the passwords from environment variables.

| Variable               | Value                                                                          |
| ---------------------- | ------------------------------------------------------------------------------ |
| `MAIL_ICLOUD_ADDRESS`  | The login address of the iCloud account                                        |
| `MAIL_ICLOUD_PASSWORD` | An app-specific password of the iCloud account                                 |
| `MAIL_ICLOUD_DOMAIN`   | Optional. A custom domain whose addresses are aliases of the iCloud account    |
| `MAIL_GMAIL_ADDRESS`   | The address of the Gmail account                                               |
| `MAIL_GMAIL_PASSWORD`  | An app password of the Gmail account                                           |

Set the variables in the environment that starts `claude`.

`mail.py` opens TLS connections to `imap.mail.me.com` and `imap.gmail.com`. If the sandbox of Claude Code is on, allow these hosts or exclude the command from the sandbox.

`mail.py` keeps the time of the last check in `~/.local/state/mail/state.json`.
