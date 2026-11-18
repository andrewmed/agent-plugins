# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Search and read the chats of the macOS Messages app (iMessage, SMS, RCS)."""

import argparse
import base64
import datetime
import json
import os
import re
import signal
import subprocess
import sys
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.expanduser("~/.local/state/messages/MessagesReader.app")
READER = os.path.join(APP, "Contents", "MacOS", "reader")
SETUP_HINT = f"the user must run `uv run {os.path.join(HERE, 'msg.py')} setup` in a terminal"
NO_ACCESS = 2
APPLE_EPOCH = 978307200
SNIPPET = 300
GROUP = 43
BATCH = 400
# U+200D stays, because emoji sequences use it. U+FFFC is the place of an attachment in the text.
BAD_TEXT = re.compile("[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩"
                      "؜​‌‎‏⁠-⁤⁪-⁯﻿￼]")
MESSAGE = ("SELECT m.ROWID AS id, m.date, m.is_from_me, m.text, m.attributedBody, m.error, h.id AS handle "
           "FROM message m LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE m.ROWID IN ({})")


def clean(text):
    return BAD_TEXT.sub("", text or "")


class Reader:
    """The sandboxed reader process. It has the read access to ~/Library/Messages that the user gave to it."""

    def __init__(self, command=None):
        try:
            self.process = subprocess.Popen(command or [READER, "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            stderr=subprocess.PIPE, encoding="utf-8")
        except FileNotFoundError:
            sys.exit(f"the reader is not built: {SETUP_HINT}")

    def execute(self, sql, args=()):
        """Return the rows as dictionaries."""
        try:
            self.process.stdin.write(json.dumps({"sql": sql, "args": list(args)}) + "\n")
            self.process.stdin.flush()
        except BrokenPipeError:
            pass
        line = self.process.stdout.readline()
        if not line:
            note = " ".join(self.process.stderr.read().split())
            sys.exit(f"{note}: {SETUP_HINT}" if self.process.wait() == NO_ACCESS else f"the reader stopped: {note}")
        answer = json.loads(line)
        if "error" in answer:
            sys.exit(f"Messages database error: {answer['error']}")
        return [{name: base64.b64decode(value["blob"]) if isinstance(value, dict) else value
                 for name, value in zip(answer["columns"], values)} for values in answer["rows"]]


def load_chats(db):
    """Return one chat for each `chat_identifier`. Messages keeps a row for each service of the same person."""
    people = {}
    for row in db.execute("SELECT j.chat_id, h.id FROM chat_handle_join j JOIN handle h ON h.ROWID = j.handle_id"):
        people.setdefault(row["chat_id"], []).append(clean(row["id"]))
    last = {row["chat_id"]: row["last"] for row in db.execute(
        "SELECT j.chat_id, MAX(m.date) AS last FROM chat_message_join j "
        "JOIN message m ON m.ROWID = j.message_id WHERE m.item_type = 0 GROUP BY j.chat_id")}
    chats = {}
    rows = db.execute("SELECT ROWID AS id, chat_identifier, service_name, display_name, style FROM chat")
    for row in sorted(rows, key=lambda row: last.get(row["id"]) or 0, reverse=True):
        chat = chats.get(row["chat_identifier"])
        if not chat:
            chat = chats[row["chat_identifier"]] = SimpleNamespace(
                id=row["id"], identifier=clean(row["chat_identifier"]), ids=[], services=[], title="", people=[],
                group=row["style"] == GROUP, last=last.get(row["id"]))
        chat.ids.append(row["id"])
        if row["service_name"] and row["service_name"] not in chat.services:
            chat.services.append(row["service_name"])
        chat.title = chat.title or " ".join(clean(row["display_name"]).split())
        chat.people += [handle for handle in people.get(row["id"], []) if handle not in chat.people]
    for chat in chats.values():
        chat.name = chat.title or (", ".join(chat.people) if chat.group else chat.identifier) or "?"
    return list(chats.values())


def stamp(value):
    if not value:
        return "-"
    seconds = value / 1e9 if abs(value) > 1e11 else value
    return datetime.datetime.fromtimestamp(seconds + APPLE_EPOCH).strftime("%Y-%m-%d %H:%M")


def label(chat):
    kind = f"group of {len(chat.people)}" if chat.group else chat.identifier
    return f"{chat.name} ({'' if kind == chat.name else kind + ', '}{'/'.join(chat.services) or '?'}, chat {chat.id})"


def row(chat):
    return f"{chat.id:>6}  {stamp(chat.last):<16}  {'/'.join(chat.services) or '?':<12}  {chat.name}" + (
        f"  (group of {len(chat.people)})" if chat.group else "")


def digits(value):
    return re.sub(r"\D", "", value)


def find_chat(chats, spec):
    wanted, number = spec.strip().casefold(), digits(spec)
    phone = len(number) >= 7 and re.fullmatch(r"[+\d\s().-]+", spec.strip())
    hits = [c for c in chats if wanted.isdigit() and int(wanted) in c.ids]
    hits += [c for c in chats if c not in hits and not c.group
             and (c.identifier.casefold() == wanted or (phone and digits(c.identifier) == number))]
    if not hits:
        hits = ([c for c in chats if c.name.casefold() == wanted]
                or [c for c in chats if wanted and wanted in f"{c.name} {c.identifier}".casefold()])
    if not hits:
        sys.exit(f"no chat matches {spec!r}: find it with `chats --search`")
    if len(hits) > 1:
        sys.exit(f"{spec!r} matches {len(hits)} chats, give the ID:\n" + "\n".join(map(row, hits)))
    return hits[0]


def day(value):
    """Accept 2026-09-01 or a 7d / 3w / 6m offset, return the local midnight of that day in the unit of the database."""
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
    return int((datetime.datetime.combine(date, datetime.time()).timestamp() - APPLE_EPOCH) * 1e9)


def body_text(blob):
    """Return the string of an NSAttributedString archive. Messages leaves `text` empty and fills `attributedBody`."""
    start = blob.find(b"NSString")
    mark = blob.find(b"\x01+", start) if start >= 0 else -1
    if mark < 0 or mark + 2 >= len(blob):
        return ""
    at, size = mark + 3, blob[mark + 2]
    if size in (0x81, 0x82):
        width = 2 if size == 0x81 else 4
        at, size = at + width, int.from_bytes(blob[at:at + width], "little")
    return blob[at:at + size].decode("utf-8", "replace")


def text_of(message):
    return clean(message["text"] or body_text(message["attributedBody"] or b"")).strip()


def content(db, message, full=False):
    """Return the text with a mark for each attachment. `full` gives the path of an attachment."""
    files = db.execute("SELECT COALESCE(a.filename, a.transfer_name, a.mime_type) AS name FROM message_attachment_join j "
                       "JOIN attachment a ON a.ROWID = j.attachment_id WHERE j.message_id = ?", (message["id"],))
    parts = [f"[file {clean(file['name'] if full else os.path.basename(file['name']))}]" for file in files if file["name"]]
    if message["is_from_me"] and message["error"]:
        parts.insert(0, f"[not delivered, error {message['error']}]")
    return " ".join(parts + [text_of(message)]).strip() or "[no text]"


def sender(message):
    return "me" if message["is_from_me"] else clean(message["handle"]) or "?"


def snippet(text, query):
    text = " ".join(text.split())
    if len(text) <= SNIPPET:
        return text
    at = max(text.casefold().find((query or "").casefold()), 0)
    start = max(0, min(at - SNIPPET // 3, len(text) - SNIPPET))
    end = start + SNIPPET
    return ("…" if start else "") + text[start:end] + ("…" if end < len(text) else "")


def fetch(db, ids):
    found = {message["id"]: message for message in db.execute(MESSAGE.format(", ".join("?" * len(ids))), ids)}
    return [found[message_id] for message_id in ids if message_id in found]


def messages(db, chats=None, since=None, before=None):
    """Yield (chat ID, message), newest first. The sort reads only IDs, because a sort of the message bodies is slow."""
    where, values = ["m.item_type = 0"], []
    if chats is not None:
        ids = [chat_id for chat in chats for chat_id in chat.ids]
        where.append(f"j.chat_id IN ({', '.join('?' * len(ids))})")
        values += ids
    for bound, test in ((since, "m.date >= ?"), (before, "m.date < ?")):
        if bound is not None:
            where.append(test)
            values.append(bound)
    keys = db.execute("SELECT m.ROWID AS id, j.chat_id FROM message m LEFT JOIN chat_message_join j "
                      f"ON j.message_id = m.ROWID WHERE {' AND '.join(where)} ORDER BY m.date DESC, m.ROWID DESC", values)
    for at in range(0, len(keys), BATCH):
        batch = keys[at:at + BATCH]
        found = {message["id"]: message for message in fetch(db, [key["id"] for key in batch])}
        yield from ((key["chat_id"], found[key["id"]]) for key in batch if key["id"] in found)


def print_messages(db, all_chats, chosen, query, args):
    by_id = {chat_id: chat for chat in all_chats for chat_id in chat.ids}
    needle, found = (query or "").casefold(), []
    for chat_id, message in messages(db, chosen, day(args.since), day(args.before)):
        if needle in text_of(message).casefold():
            found.append((chat_id, message))
            if len(found) > args.limit:
                break
    for chat in chosen or []:
        print(f"== {label(chat)}")
    for chat_id, message in found[:args.limit]:
        where = "" if chosen and len(chosen) == 1 else f"[{by_id[chat_id].name if chat_id in by_id else '?'}] "
        print(f"#{message['id']} {stamp(message['date'])} {where}{sender(message)}: "
              f"{snippet(content(db, message), query)}")
    if not found:
        print("no matches" if query else "no messages")
    elif len(found) > args.limit:
        print(f"more than {args.limit}: raise --limit or narrow the dates")


def cmd_setup(args, db=None):
    subprocess.run(["sh", os.path.join(HERE, "reader", "build.sh"), APP], check=True)
    print("A file panel opens. Select the folder Messages and click `Give read access`.")
    sys.exit(subprocess.run([READER, "grant"]).returncode)


def cmd_chats(args, db):
    needle = (args.search or "").casefold()
    found = [chat for chat in load_chats(db)
             if needle in f"{chat.name} {chat.identifier} {' '.join(chat.people)}".casefold()]
    print(f"{len(found)} chat(s), showing {min(len(found), args.limit)}")
    for chat in found[:args.limit]:
        print(row(chat))


def cmd_read(args, db):
    chats = load_chats(db)
    print_messages(db, chats, [find_chat(chats, args.chat)] if args.chat else None, None, args)


def cmd_search(args, db):
    chats = load_chats(db)
    print_messages(db, chats, [find_chat(chats, spec) for spec in args.chat] if args.chat else None, args.query, args)


def cmd_context(args, db):
    target = db.execute("SELECT m.date, j.chat_id FROM message m JOIN chat_message_join j "
                        "ON j.message_id = m.ROWID WHERE m.ROWID = ?", (args.id,))
    chat = next((chat for chat in load_chats(db) if target and target[0]["chat_id"] in chat.ids), None)
    if not chat:
        sys.exit(f"no message #{args.id} in a chat")
    near = ("SELECT m.ROWID AS id FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID "
            f"WHERE m.item_type = 0 AND j.chat_id IN ({', '.join('?' * len(chat.ids))}) "
            "AND (m.date, m.ROWID) {} (?, ?) ORDER BY m.date {}, m.ROWID {} LIMIT ?")
    key = (*chat.ids, target[0]["date"], args.id)
    older = db.execute(near.format("<=", "DESC", "DESC"), (*key, args.around + 1))
    newer = db.execute(near.format(">", "ASC", "ASC"), (*key, args.around))
    print(f"== {label(chat)}")
    for message in fetch(db, [key["id"] for key in older[::-1] + newer]):
        first, *rest = content(db, message, full=True).split("\n")
        print(f"{'>' if message['id'] == args.id else ' '} #{message['id']} {stamp(message['date'])} "
              f"{sender(message)}: {first}")
        for line in rest:
            print(f"    {line}")


def add_range(parser):
    parser.add_argument("--since", help="YYYY-MM-DD or an offset like 7d, 3w, 6m")
    parser.add_argument("--before", help="YYYY-MM-DD or an offset like 7d, 3w, 6m; without that day")
    parser.add_argument("--limit", type=int, default=20)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(required=True)
    chat_help = "an ID from `chats`, a phone number, an email address, or a part of the name"

    p = sub.add_parser("setup", help="build the reader and give it read access to Messages, one time, in a terminal")
    p.set_defaults(fn=cmd_setup)

    p = sub.add_parser("chats", help="list the chats, newest activity first")
    p.add_argument("--search", help="text in the name, the phone number or the email address")
    p.add_argument("--limit", type=int, default=50)
    p.set_defaults(fn=cmd_chats)

    p = sub.add_parser("read", help="print the newest messages of one chat, or of all chats when there is no CHAT")
    p.add_argument("chat", nargs="?", help=chat_help)
    add_range(p)
    p.set_defaults(fn=cmd_read)

    p = sub.add_parser("search", help="find a text in all chats, or in each --chat, newest first")
    p.add_argument("query")
    p.add_argument("--chat", action="append", help=chat_help + "; repeatable")
    add_range(p)
    p.set_defaults(fn=cmd_search)

    p = sub.add_parser("context", help="print a message in full with the messages around it")
    p.add_argument("id", type=int)
    p.add_argument("--around", type=int, default=5)
    p.set_defaults(fn=cmd_context)

    args = parser.parse_args()
    if getattr(args, "limit", 1) < 1 or getattr(args, "around", 0) < 0:
        sys.exit("--limit must be 1 or more, and --around 0 or more")
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    args.fn(args, None if args.fn is cmd_setup else Reader())


if __name__ == "__main__":
    main()
