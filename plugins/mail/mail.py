#!/usr/bin/env python3
"""Read iCloud and Gmail mail over IMAP, save drafts and trash messages. Addresses and passwords come from environment variables."""

import argparse
import contextlib
import datetime
import email
import email.policy
import email.utils
import html
import imaplib
import json
import mimetypes
import os
import pathlib
import re
import sys
import time
import uuid
from email.message import EmailMessage

ACCOUNTS = {
    "icloud": {
        "host": "imap.mail.me.com",
        "password": "MAIL_ICLOUD_PASSWORD",
        "address": "MAIL_ICLOUD_ADDRESS",
        "domain": os.environ.get("MAIL_ICLOUD_DOMAIN"),  # every address on it is an alias of the account
        "drafts": "Drafts",
        "trash": "Deleted Messages",
        "new": ("INBOX", "Junk", "robots"),
    },
    "gmail": {
        "host": "imap.gmail.com",
        "password": "MAIL_GMAIL_PASSWORD",
        "address": "MAIL_GMAIL_ADDRESS",
        "drafts": "[Gmail]/Drafts",
        "trash": "[Gmail]/Trash",
        "new": ("INBOX", "[Gmail]/Spam", "robots"),
    },
}
STATE = pathlib.Path.home() / ".local/state/mail/state.json"
# The default 78-column folder turns a long ASCII Message-ID in In-Reply-To
# into an encoded word, which mail clients do not decode, so threading breaks.
# RFC 5322 allows 998 columns.
DRAFT_POLICY = email.policy.default.clone(max_line_length=998)

# IMAP dates are always English, whatever the machine locale says.
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def connect(account):
    for key in ("address", "password"):
        if not os.environ.get(account[key]):
            sys.exit(f"the environment variable {account[key]} is not set")
    account["address"] = os.environ[account["address"]]
    password = os.environ[account["password"]]
    conn = imaplib.IMAP4_SSL(account["host"])
    conn.login(account["address"], password)
    return conn


def check(status, data, what):
    if status != "OK":
        sys.exit(f"{what} failed: {data}")
    return data


def load_state():
    try:
        return json.loads(STATE.read_text())
    except FileNotFoundError:
        return {}


def save_state(key, value):
    state = load_state()
    state[key] = value
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, indent=2) + "\n")


def checked_today(key):
    stamp = load_state().get(key)
    return stamp is not None and datetime.date.fromtimestamp(stamp) == datetime.date.today()


def imap_date(value):
    """Accept 2026-09-01 or a 7d / 3w / 6m offset, return 01-Sep-2026."""
    offset = re.fullmatch(r"(\d+)([dwm])", value)
    if offset:
        days = int(offset.group(1)) * {"d": 1, "w": 7, "m": 30}[offset.group(2)]
        day = datetime.date.today() - datetime.timedelta(days=days)
    else:
        try:
            day = datetime.date.fromisoformat(value)
        except ValueError:
            sys.exit(f"bad date {value!r}: want YYYY-MM-DD or an offset like 7d, 3w, 6m")
    return f"{day.day:02d}-{MONTHS[day.month - 1]}-{day.year}"


def search(conn, args):
    parts = []
    if args.since:
        parts.append(f"SINCE {imap_date(args.since)}")
    if args.before:
        parts.append(f"BEFORE {imap_date(args.before)}")
    criteria = " ".join(parts + args.search) or "ALL"
    # A non-ASCII value must go as an IMAP literal, the only form Gmail
    # accepts, and imaplib sends one literal per command, at its end.
    last = re.search(r'("([^"]*)"|\S+)\s*$', criteria)
    value = last.group(2) if last.group(2) is not None else last.group(1)
    if not value.isascii():
        if '"' in value or value.endswith(")"):
            sys.exit("a non-ASCII term must be last, outside parentheses, with no escaped quote")
        conn.literal = value.encode()
        criteria = criteria[:last.start()].strip()
    if not criteria.isascii():
        sys.exit("put the non-ASCII term last: a search takes one, at the end")
    found = check(*conn.uid("SEARCH", "CHARSET", "UTF-8", criteria.encode()), "search")[0]
    return found.split() if found else []


def cmd_folders(conn, account, args):
    for line in check(*conn.list(), "LIST"):
        print(line.decode())


def cmd_list(conn, account, args):
    check(*conn.select(args.folder, readonly=True), f"select {args.folder}")
    show(conn, search(conn, args), args.limit)


def show(conn, uids, limit):
    if not uids:
        print("no matches")
        return
    fields = "(FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])"
    data = check(*conn.uid("FETCH", b",".join(uids[-limit:]), fields), "fetch")
    parts = [part for part in data if isinstance(part, tuple)]
    print(f"{len(uids)} match(es), showing {len(parts)}")
    for meta, raw in reversed(parts):
        uid = re.search(rb"UID (\d+)", meta).group(1).decode()
        unread = "" if b"\\Seen" in meta else "* "
        head = email.message_from_bytes(raw, policy=email.policy.default)
        print(f"{uid:>8}  {unread}{head.get('date', '')}")
        print(f"          from: {head.get('from', '')}")
        print(f"          subj: {head.get('subject', '')}")


def list_new(conn, name, folder):
    check(*conn.select(folder, readonly=True), f"select {folder}")
    validity = conn.response("UIDVALIDITY")[1][0].decode()
    key = f"{name}:{folder}"
    mark = load_state().get(key)
    if mark and mark["uidvalidity"] == validity:
        found = check(*conn.uid("SEARCH", f"UID {mark['uid'] + 1}:* UNANSWERED"), "search")[0]
        # n:* always matches the newest message, even when its UID is below n.
        uids = [uid for uid in (found or b"").split() if int(uid) > mark["uid"]]
        limit = len(uids)
    else:
        found = check(*conn.uid("SEARCH", "UNANSWERED"), "search")[0]
        uids = (found or b"").split()
        limit = 20
    show(conn, uids, limit)
    if uids:
        save_state(key, {"uidvalidity": validity, "uid": max(int(uid) for uid in uids)})


def new_mail(conn, name):
    started = int(time.time())
    for folder in ACCOUNTS[name]["new"]:
        print(f"== {name} {folder}")
        list_new(conn, name, folder)
    save_state(name, started)


def fetch_message(conn, folder, uid):
    check(*conn.select(folder, readonly=True), f"select {folder}")
    msg = fetch_selected(conn, uid)
    if msg is None:
        sys.exit(f"no message with uid {uid} in {folder}")
    return msg


def fetch_raw(conn, uid):
    """The bytes of the message with this UID in the selected folder, or None."""
    data = check(*conn.uid("FETCH", uid, "(BODY.PEEK[])"), "fetch")
    return next((part[1] for part in data if isinstance(part, tuple)), None)


def fetch_selected(conn, uid):
    """The message with this UID in the selected folder, or None."""
    raw = fetch_raw(conn, uid)
    return None if raw is None else email.message_from_bytes(raw, policy=email.policy.default)


def uid_arg(value):
    if not re.fullmatch(r"[0-9]+", value):
        raise argparse.ArgumentTypeError(f"{value!r} is not one UID")
    return value


def count_arg(value):
    if not re.fullmatch(r"[0-9]+", value):
        raise argparse.ArgumentTypeError(f"{value!r} is not a whole number")
    return int(value)


def cmd_read(conn, account, args):
    check(*conn.select(args.folder, readonly=True), f"select {args.folder}")
    missing = False
    for n, uid in enumerate(args.uids):
        if n:
            print()
        print(f"== {args.folder} {uid}")
        raw = fetch_raw(conn, uid)
        if raw is None:
            print(f"no message with uid {uid} in {args.folder}")
            missing = True
            continue
        if args.eml:
            eml = pathlib.Path(args.eml)
            eml.mkdir(parents=True, exist_ok=True)
            (eml / f"{uid}.eml").write_bytes(raw)
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        save = args.save and pathlib.Path(args.save)
        if save and len(args.uids) > 1:
            save /= uid
        print_message(msg, args.headers, save, cut(plain_text(msg, args.html), args.max_chars, uid))
    if missing:
        sys.exit(1)


def cut(text, max_chars, uid):
    """The start of text, cut at a line end, with a marker that says how to get the rest."""
    if not max_chars or len(text) <= max_chars:
        return text
    end = text.rfind("\n", max_chars // 2, max_chars)
    shown = text[:end if end > 0 else max_chars].rstrip()
    return (f"{shown}\n[cut: {len(shown):,} of {len(text):,} characters; "
            f"read {uid} --max-chars 0 for all]")


def print_message(msg, headers, save_dir, text):
    if headers:
        for field, value in msg.items():
            print(f"{field}: {value}")
    else:
        for field in ("Date", "From", "To", "Cc", "Subject"):
            if msg.get(field):
                print(f"{field}: {msg[field]}")
    print(f"\n{text or '(no text body)'}")
    found = attachments(msg)
    if found:
        print()
    for part in found:
        print(f"[attachment: {part.get_filename()} {part.get_content_type()}]")
    if save_dir:
        save_dir.mkdir(parents=True, exist_ok=True)
        for part in found:
            target = save_dir / pathlib.Path(part.get_filename()).name
            target.write_bytes(part.get_payload(decode=True))
            print(f"saved {target} ({target.stat().st_size} bytes)")
        if not found:
            print("no attachments to save")


def attachments(msg):
    """Every part that carries a filename, wherever it sits in the MIME tree.

    EmailMessage.iter_attachments() returns nothing for a multipart/alternative
    root, which is how Apple Mail sends rich text with attachments, so walk the
    whole tree instead.
    """
    return [part for part in msg.walk()
            if part.get_filename() and not part.is_multipart()]


def plain_text(msg, prefer_html=False):
    """The text body, or a rough text rendering of an HTML-only body.

    prefer_html takes the HTML part first, for mail whose plain part is a stub.
    """
    body = msg.get_body(preferencelist=("html", "plain") if prefer_html else ("plain", "html"))
    if body is None:
        return ""
    text = body.get_content()
    if body.get_content_type() == "text/html":
        text = re.sub(r"(?is)<(style|script).*?</\1>", "", text)
        text = re.sub(r"(?i)<br\s*/?>|</(p|div|li|tr|h\d)>", "\n", text)
        text = html.unescape(re.sub(r"<[^>]+>", "", text))
        text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def received_alias(original, account):
    """The alias on the account's domain that received original, so the reply comes from it."""
    domain = account.get("domain")
    if not domain:
        return None
    # Cloudflare routing puts the alias in X-Forwarded-For, space separated,
    # and a BCC leaves it out of To, so scan the text rather than parse it.
    for name in ("To", "Cc", "Delivered-To", "X-Original-To", "X-Forwarded-For", "Envelope-To"):
        for value in original.get_all(name, []):
            found = re.search(rf"[\w.+-]+@{re.escape(domain)}\b", str(value), re.IGNORECASE)
            if found:
                return found.group(0).lower()
    return None


def reply_to(msg, original, args):
    """Make msg a reply to original: threading headers, subject, recipient, quote."""
    message_id = (original.get("Message-ID") or "").strip()
    references = (original.get("References") or "").split()
    if message_id:
        msg["In-Reply-To"] = message_id
        msg["References"] = " ".join(references + [message_id])
    subject = str(original.get("Subject") or "")
    if not re.match(r"(?i)\s*re:", subject):
        subject = f"Re: {subject}"
    msg["Subject"] = args.subject or subject
    msg["To"] = args.to or str(original.get("Reply-To") or original.get("From") or "")
    quote = "\n".join(f"> {line}" for line in plain_text(original).splitlines())
    return f"\nOn {original.get('Date')}, {original.get('From')} wrote:\n\n{quote}\n"


def cmd_draft(conn, account, args):
    if not args.reply_to and not (args.to and args.subject):
        sys.exit("--to and --subject are required unless --reply-to is given")
    folder = account["drafts"]
    original = fetch_message(conn, args.reply_folder, args.reply_to) if args.reply_to else None
    msg = EmailMessage(policy=DRAFT_POLICY)
    # Apple Mail deletes a draft on send only when the draft carries its own
    # draft headers; without them Mail sends a copy and leaves the draft.
    msg["Message-Id"] = email.utils.make_msgid(domain=account["address"].partition("@")[2])
    msg["X-Universally-Unique-Identifier"] = str(uuid.uuid4()).upper()
    msg["X-Uniform-Type-Identifier"] = "com.apple.mail-draft"
    msg["X-Apple-Base-Url"] = "x-msg://1/"
    msg["X-Apple-Mail-Remote-Attachments"] = "NO"
    msg["X-Apple-Mail-Plain-Text-Draft"] = "yes"
    msg["X-Apple-Windows-Friendly"] = "1"
    msg["X-Apple-Mail-Signature"] = ""
    msg["Date"] = email.utils.localtime()
    msg["From"] = args.sender or (original and received_alias(original, account)) or account["address"]
    text = sys.stdin.read() if args.body == "-" else args.body
    if original is not None:
        text = text.rstrip("\n") + "\n" + reply_to(msg, original, args)
    else:
        msg["To"] = args.to
        msg["Subject"] = args.subject
    if args.cc:
        msg["Cc"] = args.cc
    if args.bcc:
        msg["Bcc"] = args.bcc
    msg.set_content(text)
    for path in map(pathlib.Path, args.attach):
        mime, _ = mimetypes.guess_type(path.name)
        maintype, subtype = (mime or "application/octet-stream").split("/", 1)
        msg.add_attachment(path.read_bytes(), maintype=maintype, subtype=subtype, filename=path.name)
    raw = msg.as_bytes()
    if args.print:
        # as_string() would re-encode an 8-bit body as base64; show what is saved.
        sys.stdout.write(raw.decode("utf-8", "replace"))
        return
    check(*conn.append(folder, "\\Draft", None, raw), "append")
    print(f"draft saved to {folder}")
    if args.replace:
        remove_draft(conn, folder, args.replace)


def remove_draft(conn, folder, uid):
    if not uid.isdigit():
        sys.exit(f"{uid!r} is not one UID")
    check(*conn.select(folder), f"select {folder}")
    data = check(*conn.uid("FETCH", uid, "(FLAGS)"), "fetch")
    if not data or data[0] is None:
        sys.exit(f"no message with uid {uid} in {folder}")
    # UID EXPUNGE (UIDPLUS) removes only this message, not every \Deleted one.
    check(*conn.uid("STORE", uid, "+FLAGS", "(\\Deleted)"), "store")
    check(*conn.uid("EXPUNGE", uid), "expunge")
    print(f"draft {uid} removed from {folder}")


def cmd_delete(conn, account, args):
    remove_draft(conn, account["drafts"], args.uid)


def cmd_trash(conn, account, args):
    trash = account["trash"]
    if args.folder == trash:
        sys.exit(f"{trash} is the trash folder")
    check(*conn.select(args.folder), f"select {args.folder}")
    data = check(*conn.uid("FETCH", ",".join(args.uids), "(UID)"), "fetch")
    found = {re.search(rb"UID (\d+)", item).group(1).decode()
             for item in data if isinstance(item, bytes)}
    moving = [uid for uid in args.uids if uid in found]
    if moving:
        # uid() quotes the folder for COPY only; MOVE gets it as typed.
        check(*conn.uid("MOVE", ",".join(moving), f'"{trash}"'), "move")
    missing = False
    for uid in args.uids:
        if uid in found:
            print(f"{uid} moved from {args.folder} to {trash}")
        else:
            print(f"no message with uid {uid} in {args.folder}")
            missing = True
    if missing:
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(required=True)
    account = argparse.ArgumentParser(add_help=False)
    account.add_argument("--account", choices=list(ACCOUNTS), required=True, help="icloud or gmail")

    sub.add_parser("folders", parents=[account], help="list mailboxes").set_defaults(fn=cmd_folders)

    p = sub.add_parser("list", parents=[account], help="list messages, newest first")
    p.add_argument("--folder", default="INBOX")
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--search", action="append", default=[],
                   help="IMAP criteria, repeatable and ANDed: --search UNSEEN --search 'FROM apple'")
    p.add_argument("--since", help="YYYY-MM-DD or an offset like 7d, 3w, 6m")
    p.add_argument("--before", help="YYYY-MM-DD or an offset like 7d, 3w, 6m")
    p.set_defaults(fn=cmd_list)

    p = sub.add_parser("new", help="list unanswered INBOX, spam and robots mail since the last check")
    p.add_argument("--account", choices=list(ACCOUNTS), help="one mailbox; default is both")
    p.set_defaults(fn=None)

    p = sub.add_parser("read", parents=[account], help="print messages, each under a '== FOLDER UID' line")
    p.add_argument("uids", nargs="+", type=uid_arg, metavar="uid")
    p.add_argument("--folder", default="INBOX")
    p.add_argument("--save", metavar="DIR",
                   help="write every attachment into DIR, or into DIR/UID when several UIDs are given")
    p.add_argument("--headers", action="store_true", help="print every header, not only the main ones")
    p.add_argument("--eml", metavar="DIR",
                   help="also write each message unchanged, with every header, as DIR/UID.eml")
    p.add_argument("--html", action="store_true",
                   help="render the HTML part instead of the plain part, for mail whose plain part is a stub")
    p.add_argument("--max-chars", type=count_arg, default=4000, metavar="N",
                   help="print at most N characters of each body, then a [cut: ...] marker; 0 prints all")
    p.set_defaults(fn=cmd_read)

    p = sub.add_parser("draft", parents=[account], help="save a draft for the user to send from Mail")
    p.add_argument("--body", required=True, help="text, or - to read stdin")
    p.add_argument("--reply-to", metavar="UID",
                   help="answer this message: same thread, Re: subject, original quoted")
    p.add_argument("--reply-folder", default="INBOX", help="folder of the UID in --reply-to")
    p.add_argument("--to", help="required unless --reply-to is given")
    p.add_argument("--subject", help="required unless --reply-to is given")
    p.add_argument("--cc")
    p.add_argument("--bcc")
    p.add_argument("--sender", help="From address; default is the account address, "
                   "or for an iCloud reply the alias that received the original")
    p.add_argument("--attach", action="append", default=[], metavar="PATH",
                   help="attach this file; repeat for several")
    p.add_argument("--replace", metavar="UID", help="after saving, remove this earlier draft")
    p.add_argument("--print", action="store_true", help="show the message instead of saving it")
    p.set_defaults(fn=cmd_draft)

    p = sub.add_parser("delete", parents=[account], help="remove a draft from the Drafts folder")
    p.add_argument("uid")
    p.set_defaults(fn=cmd_delete)

    p = sub.add_parser("trash", parents=[account],
                       help="move messages to the trash folder; only on a direct order from the user")
    p.add_argument("uids", nargs="+", type=uid_arg, metavar="uid")
    p.add_argument("--folder", default="INBOX")
    p.set_defaults(fn=cmd_trash)

    args = parser.parse_args()
    with contextlib.ExitStack() as stack:
        conns = {}

        def conn_for(name):
            if name not in conns:
                conns[name] = stack.enter_context(connect(ACCOUNTS[name]))
            return conns[name]

        if args.fn is None:
            for name in [args.account] if args.account else ACCOUNTS:
                new_mail(conn_for(name), name)
            return
        for name in ACCOUNTS:
            if not checked_today(name):
                print("== daily new-mail check")
                new_mail(conn_for(name), name)
                print("== end of daily check\n")
        args.fn(conn_for(args.account), ACCOUNTS[args.account], args)


if __name__ == "__main__":
    main()
