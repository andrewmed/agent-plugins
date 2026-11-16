# /// script
# requires-python = ">=3.10"
# dependencies = ["telethon==1.45.0", "qrcode==8.2"]
# ///
"""Search the Telegram chats of the user's own account, one chat at a time, and send a draft that the user approved."""

import argparse
import asyncio
import datetime
import getpass
import os
import re
import sqlite3
import sys
import time

import qrcode
from telethon import TelegramClient, errors, types, utils
from telethon.sessions import StringSession

STATE_DIR = os.path.expanduser("~/.local/state/telegram")
LOGIN_HINT = "the user must run `uv run <skill-dir>/tg.py login` in a terminal"
SNIPPET = 300
# Telethon sends a request again after a lost connection, a server error or a short flood wait.
# The answer to a second copy does not tell if the first copy went out, so `send` makes one attempt.
# Telethon makes `request_retries + 1` attempts (`helpers.retry_range`).
ONE_ATTEMPT = {"auto_reconnect": False, "request_retries": 0, "flood_sleep_threshold": 0}
BAD_TEXT = re.compile(r"[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]")
SCHEMA = """
CREATE TABLE IF NOT EXISTS drafts(n INTEGER PRIMARY KEY AUTOINCREMENT, chat INTEGER NOT NULL, label TEXT NOT NULL,
  text TEXT NOT NULL, created_ts INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'draft', message_id INTEGER, error TEXT);
CREATE TRIGGER IF NOT EXISTS drafts_fixed BEFORE UPDATE OF chat, label, text ON drafts BEGIN
  SELECT RAISE(ABORT, 'a draft does not change');
END;
"""


def state_path(name):
    os.makedirs(STATE_DIR, exist_ok=True)
    os.chmod(STATE_DIR, 0o700)
    return os.path.join(STATE_DIR, name)


def read_secret():
    try:
        with open(state_path("session")) as file:
            return file.read().strip()
    except FileNotFoundError:
        return None


def save_secret(secret):
    new = state_path("session.new")
    fd = os.open(new, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as file:
        file.write(secret + "\n")
    os.replace(new, state_path("session"))


def new_client(api_id, api_hash, session="", **options):
    return TelegramClient(StringSession(session), int(api_id), api_hash, **{"receive_updates": False, **options})


async def connect(**options):
    secret = read_secret()
    if not secret:
        sys.exit(f"not signed in: {LOGIN_HINT}")
    client = new_client(*secret.split(":", 2), **options)
    await client.connect()
    return client


def day(value):
    """Accept 2026-09-01 or a 7d / 3w / 6m offset, return the local midnight of that day."""
    if not value:
        return None
    offset = re.fullmatch(r"(\d+)([dwm])", value)
    if offset:
        days = int(offset.group(1)) * {"d": 1, "w": 7, "m": 30}[offset.group(2)]
        date = datetime.date.today() - datetime.timedelta(days=days)
    else:
        try:
            date = datetime.date.fromisoformat(value)
        except ValueError:
            sys.exit(f"bad date {value!r}: want YYYY-MM-DD or an offset like 7d, 3w, 6m")
    return datetime.datetime.combine(date, datetime.time()).astimezone()


def kind(dialog):
    if dialog.is_user:
        return "bot" if dialog.entity.bot else "user"
    return "channel" if getattr(dialog.entity, "broadcast", False) else "group"


def title(dialog):
    if dialog.is_user and dialog.entity.is_self:
        return "Saved Messages"
    return dialog.name or "?"


def username(entity):
    if getattr(entity, "username", None):
        return entity.username
    return next((u.username for u in getattr(entity, "usernames", None) or [] if u.active), None)


def row(dialog):
    name = username(dialog.entity)
    return (f"{dialog.id:>15}  {kind(dialog):<7}  {title(dialog)}"
            + (f" @{name}" if name else "") + (" [archived]" if dialog.archived else ""))


def label(dialog):
    name = username(dialog.entity)
    text = f"{title(dialog)} ({kind(dialog)}{f', @{name}' if name else ''}, {dialog.id})"
    return BAD_TEXT.sub("", " ".join(text.split()))


def header(dialog):
    link = ""
    if isinstance(dialog.entity, types.Channel):
        name = username(dialog.entity)
        link = f" https://t.me/{name}" if name else f" https://t.me/c/{dialog.entity.id}"
    return f"== {title(dialog)} ({kind(dialog)}, {dialog.id}){link}"


def find_chat(dialogs, spec):
    wanted = spec.casefold()
    if re.fullmatch(r"-?\d+", spec):
        hits = [d for d in dialogs if d.id == int(spec)]
    elif wanted == "me":
        hits = [d for d in dialogs if d.is_user and d.entity.is_self]
    elif spec.startswith("@"):
        hits = [d for d in dialogs if (username(d.entity) or "").casefold() == wanted[1:]]
    else:
        hits = ([d for d in dialogs if title(d).casefold() == wanted]
                or [d for d in dialogs if wanted in title(d).casefold()])
    if not hits:
        sys.exit(f"no chat matches {spec!r}: find it with `chats --search`")
    if len(hits) > 1:
        sys.exit(f"{spec!r} matches {len(hits)} chats, give the ID:\n" + "\n".join(map(row, hits)))
    return hits[0]


def peer(dialog):
    # Telethon's iter_messages() runs messages.searchGlobal when the entity is empty.
    if not dialog.input_entity:
        sys.exit(f"no peer for {title(dialog)}")
    return dialog.input_entity


def stamp(message):
    return message.date.astimezone().strftime("%Y-%m-%d %H:%M")


def sender(message):
    return "me" if message.out else utils.get_display_name(message.sender) or "?"


def content(message):
    parts = []
    if message.fwd_from:
        parts.append("[forwarded]")
    if message.action:
        parts.append(f"[{type(message.action).__name__.removeprefix('MessageAction')}]")
    media = message.media
    if isinstance(media, types.MessageMediaDocument):
        file = message.file
        parts.append(f"[file {file.name or file.mime_type}]" if file else "[file]")
    elif media and not isinstance(media, types.MessageMediaWebPage):
        parts.append(f"[{type(media).__name__.removeprefix('MessageMedia').lower()}]")
    if message.text:
        parts.append(message.text)
    return " ".join(parts)


def snippet(text, query):
    text = " ".join(text.split())
    if len(text) <= SNIPPET:
        return text
    low = text.lower()
    at = next((i for i in (low.find(word) for word in (query or "").lower().split()) if i >= 0), 0)
    start = max(0, min(at - SNIPPET // 3, len(text) - SNIPPET))
    end = start + SNIPPET
    return ("…" if start else "") + text[start:end] + ("…" if end < len(text) else "")


def open_db():
    # Autocommit: the state `unknown` is on the disk before the send starts.
    db = sqlite3.connect(state_path("drafts.db"), isolation_level=None)
    db.row_factory = sqlite3.Row
    db.executescript(SCHEMA)
    return db


def get_draft(db, n):
    draft = db.execute("SELECT * FROM drafts WHERE n = ?", (n,)).fetchone()
    if not draft:
        sys.exit(f"there is no draft {n}")
    return draft


def draft_lines(draft):
    note = f" ({draft['error']})" if draft["error"] else ""
    sent = f", message #{draft['message_id']}" if draft["message_id"] else ""
    return [f"draft {draft['n']}: {draft['state']}{sent}{note}", f"to: {draft['label']}",
            "----- text -----", *draft["text"].split("\n"), "----- end -----"]


def check_text(raw):
    text = re.sub(r"\r\n?", "\n", raw).rstrip()
    if not text:
        sys.exit("the draft text is empty: give the text on stdin")
    if BAD_TEXT.search(text):
        sys.exit("the draft text has control characters")
    return text


def make_draft(db, dialog, text):
    return db.execute("INSERT INTO drafts(chat, label, text, created_ts) VALUES (?, ?, ?, ?)",
                      (dialog.id, label(dialog), text, int(time.time()))).lastrowid


async def send_draft(db, n, client):
    draft = get_draft(db, n)
    if draft["state"] != "draft":
        sys.exit(f"draft {n} has the state {draft['state']}. The script does not send it again.")
    dialog = next((d for d in await client.get_dialogs() if d.id == draft["chat"]), None)
    if not dialog:
        sys.exit(f"draft {n}: the chat is not in the chat list. It is not sent.")
    target = peer(dialog)
    claim = db.execute("UPDATE drafts SET state = 'unknown', error = 'the send did not complete' "
                       "WHERE n = ? AND state = 'draft'", (n,))
    if claim.rowcount != 1:
        sys.exit(f"draft {n} changed its state. It is not sent.")
    try:
        message = await client.send_message(target, draft["text"], parse_mode=None, link_preview=False)
        db.execute("UPDATE drafts SET state = 'sent', error = NULL, message_id = ? WHERE n = ?", (message.id, n))
    except (Exception, asyncio.CancelledError) as error:
        refused = isinstance(error, errors.RPCError) and 400 <= (error.code or 0) < 500
        db.execute("UPDATE drafts SET state = ?, error = ? WHERE n = ?",
                   ("failed" if refused else "unknown", str(error) or type(error).__name__, n))


def code_kind(value):
    name = re.sub(r"^(Sent)?CodeType", "", type(value).__name__)
    return "App (the service chat Telegram in the app)" if name == "App" else name


def show_qr(url):
    code = qrcode.QRCode()
    code.add_data(url)
    code.print_ascii(tty=True)


async def qr_sign_in(client, show):
    login = await client.qr_login()
    while True:
        show(login.url)
        print("In the Telegram app on the phone: Settings > Devices > Link Desktop Device. Scan the code.")
        try:
            return await login.wait()
        except asyncio.TimeoutError:
            await login.recreate()


async def code_sign_in(client, phone, ask):
    sent = await client.send_code_request(phone)
    while True:
        print(f"Telegram sent the code: {code_kind(sent.type)} {getattr(sent.type, 'email_pattern', '')}".rstrip())
        again = f", or nothing to get a new code by {code_kind(sent.next_type)}" if sent.next_type else ""
        code = ask(f"code{again}: ").strip()
        try:
            if code:
                return await client.sign_in(phone, code)
            # A second request for the same phone makes Telethon ask Telegram for the next kind of delivery.
            if sent.next_type:
                sent = await client.send_code_request(phone)
        except errors.SendCodeUnavailableError:
            print("Telegram has no other way to send the code")
        except (errors.PhoneCodeInvalidError, errors.PhoneCodeEmptyError):
            print("the code is wrong")


async def sign_in(client, ask=input, ask_hidden=getpass.getpass, show=show_qr):
    phone = ask("phone with the country code, or nothing for a QR code: ").strip()
    try:
        return await (code_sign_in(client, phone, ask) if phone else qr_sign_in(client, show))
    except errors.SessionPasswordNeededError:
        while True:
            try:
                return await client.sign_in(password=ask_hidden("2FA password (hidden): "))
            except errors.PasswordHashInvalidError:
                print("the password is wrong")


async def cmd_login(args):
    if not (sys.stdin.isatty() and sys.stdout.isatty()):
        sys.exit("run login in a terminal, because it shows a QR code and asks for the 2FA password")
    print("Get api_id and api_hash at https://my.telegram.org > API development tools.")
    api_id = input("api_id: ").strip()
    api_hash = getpass.getpass("api_hash (hidden): ").strip()
    if not api_id.isdigit() or not re.fullmatch(r"[0-9a-f]{32}", api_hash):
        sys.exit("api_id is digits and api_hash is 32 hex characters")
    # The QR login waits for an update from Telegram.
    client = new_client(api_id, api_hash, receive_updates=True)
    await client.connect()
    try:
        me = await sign_in(client)
        save_secret(f"{api_id}:{api_hash}:{client.session.save()}")
        print(f"signed in as {utils.get_display_name(me)}, the session is in {state_path('session')}")
    except errors.RPCError as error:
        sys.exit(f"Telegram error: {error}")
    finally:
        await client.disconnect()


async def cmd_chats(client, args):
    found = [d for d in await client.get_dialogs()
             if (not args.type or kind(d) == args.type)
             and (not args.search
                  or args.search.casefold() in f"{title(d)} @{username(d.entity) or ''}".casefold())]
    print(f"{len(found)} chat(s), showing {min(len(found), args.limit)}")
    for dialog in found[:args.limit]:
        print(row(dialog))


async def cmd_search(client, args):
    dialogs = await client.get_dialogs()
    chats = [find_chat(dialogs, spec) for spec in args.chat]
    since, before = day(args.since), day(args.before)
    for dialog in chats:
        print(header(dialog))
        found = []
        async for message in client.iter_messages(peer(dialog), limit=args.limit + 1,
                                                  search=args.query or None, offset_date=before):
            if since and message.date < since:
                break
            found.append(message)
        for message in found[:args.limit]:
            print(f"#{message.id} {stamp(message)} {sender(message)}: {snippet(content(message), args.query)}")
        if not found:
            print("no matches" if args.query else "no messages")
        elif len(found) > args.limit:
            print(f"more than {args.limit}: raise --limit or narrow the dates")


async def cmd_context(client, args):
    dialog = find_chat(await client.get_dialogs(), args.chat)
    older = [m async for m in client.iter_messages(peer(dialog), limit=args.around + 1,
                                                    offset_id=args.id + 1)]
    newer = [m async for m in client.iter_messages(peer(dialog), limit=args.around,
                                                    min_id=args.id, reverse=True)]
    print(header(dialog))
    messages = older[::-1] + newer
    if all(m.id != args.id for m in messages):
        print(f"no message #{args.id} in this chat")
    for message in messages:
        mark = ">" if message.id == args.id else " "
        reply = f" (reply to #{message.reply_to_msg_id})" if message.reply_to_msg_id else ""
        first, *rest = content(message).split("\n")
        print(f"{mark} #{message.id} {stamp(message)} {sender(message)}{reply}: {first}")
        for line in rest:
            print(f"    {line}")


async def cmd_draft(client, args):
    if sys.stdin.isatty():
        sys.exit("give the draft text on stdin")
    text = check_text(sys.stdin.read())
    dialog = find_chat(await client.get_dialogs(), args.chat)
    db = open_db()
    print(*draft_lines(get_draft(db, make_draft(db, dialog, text))), sep="\n")


async def cmd_drafts(args):
    rows = open_db().execute("SELECT * FROM drafts WHERE state != 'sent' ORDER BY n").fetchall()
    for draft in rows:
        made = datetime.datetime.fromtimestamp(draft["created_ts"]).strftime("%Y-%m-%d %H:%M")
        print(f"#{draft['n']} {draft['state']} {made} to {draft['label']}: {snippet(draft['text'], None)}")
    if not rows:
        print("no drafts")


async def cmd_send(client, args):
    db = open_db()
    await send_draft(db, args.n, client)
    print(*draft_lines(get_draft(db, args.n)), sep="\n")


async def run(args):
    if args.fn in (cmd_login, cmd_drafts):
        return await args.fn(args)
    client = await connect(**(ONE_ATTEMPT if args.fn is cmd_send else {}))
    try:
        await args.fn(client, args)
    except errors.UnauthorizedError:
        sys.exit(f"the Telegram session is not valid: {LOGIN_HINT}")
    except errors.RPCError as error:
        sys.exit(f"Telegram error: {error}")
    finally:
        await client.disconnect()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(required=True)

    sub.add_parser("login", help="sign in one time, in a terminal").set_defaults(fn=cmd_login)

    p = sub.add_parser("chats", help="list chats, groups and channels, newest activity first")
    p.add_argument("--search", help="text in the name or the @username")
    p.add_argument("--type", choices=("user", "bot", "group", "channel"))
    p.add_argument("--limit", type=int, default=50)
    p.set_defaults(fn=cmd_chats)

    p = sub.add_parser("search", help="search each --chat, newest first; without QUERY, list its newest messages")
    p.add_argument("query", nargs="?")
    p.add_argument("--chat", action="append", required=True,
                   help="ID, @username, me, or a part of the name; repeatable")
    p.add_argument("--since", help="YYYY-MM-DD or an offset like 7d, 3w, 6m")
    p.add_argument("--before", help="YYYY-MM-DD or an offset like 7d, 3w, 6m")
    p.add_argument("--limit", type=int, default=20, help="per chat")
    p.set_defaults(fn=cmd_search)

    p = sub.add_parser("context", help="print a message in full with the messages around it")
    p.add_argument("chat", help="ID, @username, me, or a part of the name")
    p.add_argument("id", type=int)
    p.add_argument("--around", type=int, default=5)
    p.set_defaults(fn=cmd_context)

    p = sub.add_parser("draft", help="make a draft for one chat, with the text on stdin")
    p.add_argument("chat", help="ID, @username, me, or a part of the name")
    p.set_defaults(fn=cmd_draft)

    sub.add_parser("drafts", help="list the drafts that are not sent").set_defaults(fn=cmd_drafts)

    p = sub.add_parser("send", help="send draft N, only after the user approved it")
    p.add_argument("n", type=int)
    p.set_defaults(fn=cmd_send)

    asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    main()
