# Mail skill roadmap: fewer calls per request

Goal: a mail request should need as few script calls as possible. One call costs
one process, one IMAP login and, above all, one model round trip. The script
time per call is small (0.5 s to 2 s measured on 2026-10-19); the round trips
are what makes a check slow.

## Why it got slower (2026-10-19)

Before, Gmail went through the claude.ai connector: one call returned 20
threads with subject and snippet, and it ran in parallel with the iCloud
script. Now Gmail goes through `mail.py` as well. `list` and `new` give sender,
subject and date only, and `SKILL.md` tells the agent to read a message before
it reports it. So the agent reads new mail one message per call, and the daily
check covers two accounts in one sequential run.

## Steps, in order

1. **`read` with several UIDs in one call.** One login for all of them. Each
   message is printed under its own header line with its UID. `--save DIR` and
   `--headers` apply to all. This removes one call per message on every check.
   Done on 2026-10-19: with several UIDs, `--save DIR` writes into `DIR/UID`.
2. **A limit on the text that `read` prints**, done on 2026-10-19 instead of
   a body excerpt in `list` and `new`. `read --max-chars N`, default 4,000,
   cuts each body at a line end and adds a `[cut: ...]` marker with the
   counts and the command for the rest. The cut is in the final text, so the
   shown part is always the start of the `read` output and no partial bytes
   are decoded. A read of all new mail is now cheap in context, so
   `SKILL.md` tells the agent to read all new INBOX and spam messages, one
   call per account and folder, in parallel. This does not remove a round
   trip. Bodies in `new`, full or none per message with a per-call budget,
   is the variant that removes the read round trip; it stays an option, but
   it needs a raw size limit, a text limit, a budget and a budget order.
3. **`new` runs the two accounts in parallel threads.** Saves about 2 s once
   a day. Output must stay grouped per account.

## Deferred from the Codex review of 2026-10-19

- The first `new` check of a folder shows its newest 20 messages and then
  moves the mark, so older mail in that folder never shows in a later check.
  `SKILL.md` no longer says this. Decided not to add it for now.
- `read` strips whitespace at the start and the end of a plain-text body,
  because `plain_text()` strips for the HTML case too. Harmless.
