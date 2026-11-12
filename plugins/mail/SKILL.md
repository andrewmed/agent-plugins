---
name: mail
description: Read the user's email and save drafts, in both mailboxes over IMAP with the script in this skill. Use whenever a task needs the user's mailbox - "check my email", "any new mail", "search my inbox for X", "what did Y send me", "draft a reply", "forward me the receipt", or when a task needs a code, receipt, invoice, booking or confirmation that arrives by email. Covers the Gmail mailbox and the iCloud mailbox of the user, with each address on the mail domain of the user. Reads, drafts and, only on a direct order from the user, trashes - this skill never sends.
---

# Mail

`mail.py` in the directory of this file reads both mailboxes over IMAP, saves drafts
and trashes messages. Run it by its absolute path.
`python3 mail.py <command> --help` lists the options; this file only adds
what the help does not say.

## Accounts

- `--account gmail`: the address in the environment variable
  `MAIL_GMAIL_ADDRESS`.
- `--account icloud`: every address on the domain in the environment
  variable `MAIL_ICLOUD_DOMAIN`. They are aliases of one iCloud account, so
  one login reaches the whole domain.
- `printenv MAIL_GMAIL_ADDRESS MAIL_ICLOUD_DOMAIN` shows the two values.
- Another address: stop and ask. Do not guess a mailbox.
- No address in the request: use both accounts.

A Gmail connector can also be present. Use it only for what the script cannot
give, such as a web link to a message. Never use its send tools.

## Rules

- **Never send.** The skill has no SMTP path, on purpose. A finished message
  goes to the Drafts folder of its account and the user sends it from Mail.
  If the user asks to send, say that the skill does not send, and offer the
  draft.
- **Trash only on a direct order.** Run `trash` only when the request tells
  you to delete or trash those messages. Never trash on your own decision,
  for example to clean up after a check or because a message looks like
  spam. When the user names a group and not the UIDs, show the matches first
  and trash only what the user confirms.
- **Do not touch the passwords.** The script reads them from the
  environment variables `MAIL_ICLOUD_PASSWORD` and `MAIL_GMAIL_PASSWORD`.
  Never print one, pass it as an argument or write it to a file. If a
  variable is not set, stop and tell the user.

## New mail

The script checks each mailbox once a day, before any command except `new`,
and shares the mark between sessions. Two calls at the same time both run a
pending check, so run calls in parallel only after both accounts are
checked; `new --account X` checks only X. When the user asks for new mail,
run `new`, also when the check ran today: it shows the INBOX, spam and
robots messages since the last check that have no answered flag, and moves
the mark. Mail sets the flag when it sends a reply to the message; a reply from
another place does not set it, so a listed message can still be answered.

When a check ran, open the reply with the mail that needs attention: a
person writing to the user, a question or request, a deadline, a bill, a
security alert, a code, a booking or a delivery, or real mail in spam.
Give the sender and the point in one line each. Skip ads, newsletters and
routine notices. If nothing needs attention, say so in one line. Then
answer the request.

Read a message before you report it. Do not guess the point from the
subject. Read all new INBOX messages of an account in one `read` call, and
its spam and its robots mail each in another call with `--max-chars 800`;
the calls for different accounts and folders can run at the same time. A
cut body (`[cut: ...]`) is enough to skip a clear ad or routine notice.
Before you report a cut message, read it in full.

Earlier reports went wrong on these points:

- A person can write through the notification address of a platform, such
  as a recruiting system or LinkedIn. The display name shows the person.
- The read flag does not show that the user answered.
- When a message refers to an earlier message, find that message and give
  the action from it, for example a booking link.

## Drafts

Answer a message with `draft --reply-to UID`, never with a new message that
has the same subject. The script sets the threading headers, the `Re:`
subject, the quote and, on iCloud, the alias that received the original, so
the draft lands in the thread and keeps a case number in the subject.

Mail removes a script draft from Drafts when it sends it, also from the
other account when the user changes `From`, but a draft made by another tool
stays after Mail sends a copy. So the Drafts folder does not show whether a
message went out: search the Sent folders of both accounts for the
recipient.

## Script notes

- **Folders.** iCloud: `Sent Messages`, `Deleted Messages`, `Junk`, `robots`.
  Gmail: `[Gmail]/Sent Mail`, `[Gmail]/Spam`, `[Gmail]/Trash`,
  `[Gmail]/Drafts`, `robots`.
  `robots` on both accounts holds automated mail, so a code, receipt,
  invoice or confirmation that the task needs can be there: search INBOX
  and `robots`. The user does not archive mail. Mail stays in INBOX or in a
  label folder such as `robots`, and deleted mail goes to the trash folder.
  `[Gmail]/All Mail` is not enabled for IMAP, and the skill does not need
  it. A search, also an `X-GM-RAW` query with `in:`, reads only the selected
  folder, so search each folder that can have the message. Gmail shows only
  the labels enabled for IMAP. Run `folders` before you use a folder that is
  not listed here.
- **Search.** `list --search` takes raw IMAP criteria. Quote a value with a
  space. A non-ASCII value goes as an IMAP literal, so it must be the last
  term, and there can be only one. Gmail also takes its own query language:
  `--search 'X-GM-RAW "from:amy has:attachment"'`. `--since` and `--before`
  compare dates only: `--before 1d` excludes yesterday and today. Prefer a
  narrow search over a large `--limit`.
- **Attachments.** `read --save DIR` saves inline images such as signature
  logos too.
- **Sandbox.** The script opens raw TLS sockets, and the sandbox exclusion
  allows them only for this script as a simple command. Chain calls with
  `&&` or `;`, never in a `for` loop, subshell or `xargs`, and never from a
  helper that imports `mail`. If the script lacks a feature, add it there.
  Ask for elevated execution only when a call is blocked. Outside the
  sandbox `$TMPDIR` is the system temp directory, so pass scratch paths in
  full.
