# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
import contextlib
import io
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import msg  # noqa: E402

# Archives that NSArchiver made on macOS 27.2: an NSMutableAttributedString and an NSAttributedString.
HELLO = bytes.fromhex(
    "040b73747265616d747970656481e803840140848484194e534d757461626c6541747472696275746564537472696e67008484124e53"
    "41747472696275746564537472696e67008484084e534f626a6563740085928484840f4e534d757461626c65537472696e6701848408"
    "4e53537472696e67019584012b0568656c6c6f86840269490105928484840c4e5344696374696f6e6172790095840169008686")
CODE_TEXT = "Привет, код 4821 👍\nвторая строка"
CODE = bytes.fromhex(
    "040b73747265616d747970656481e803840140848484124e5341747472696275746564537472696e67008484084e534f626a65637400"
    "8592848484084e53537472696e67019484012b38d09fd180d0b8d0b2d0b5d1822c20d0bad0bed0b4203438323120f09f918d0ad0b2d1"
    "82d0bed180d0b0d18f20d181d182d180d0bed0bad0b086840269490121928484840c4e5344696374696f6e6172790094840169008686")
HEAD, TAIL = HELLO[:HELLO.index(b"+") + 1], HELLO[HELLO.index(b"hello") + 5:]

TABLES = """
CREATE TABLE chat(ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, service_name TEXT, display_name TEXT,
  style INTEGER);
CREATE TABLE handle(ROWID INTEGER PRIMARY KEY, id TEXT);
CREATE TABLE message(ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, handle_id INTEGER, date INTEGER,
  is_from_me INTEGER DEFAULT 0, error INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0);
CREATE TABLE chat_message_join(chat_id INTEGER, message_id INTEGER);
CREATE TABLE chat_handle_join(chat_id INTEGER, handle_id INTEGER);
CREATE TABLE attachment(ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT, transfer_name TEXT);
CREATE TABLE message_attachment_join(message_id INTEGER, attachment_id INTEGER);
INSERT INTO handle VALUES (1, '+34612345678'), (2, 'BBVA'), (3, 'bob@example.com'), (4, '+15550001111');
INSERT INTO chat VALUES
  (1, 'iMessage;-;+34612345678', '+34612345678', 'iMessage', NULL, 45),
  (2, 'SMS;-;+34612345678', '+34612345678', 'SMS', NULL, 45),
  (3, 'SMS;-;BBVA', 'BBVA', 'SMS', NULL, 45),
  (4, 'iMessage;+;chat777', 'chat777', 'iMessage', 'Family', 43),
  (5, 'iMessage;+;chat888', 'chat888', 'iMessage', NULL, 43),
  (6, 'SMS;-;+15550001111', '+15550001111', 'SMS', NULL, 45);
INSERT INTO chat_handle_join VALUES (1, 1), (2, 1), (3, 2), (4, 1), (4, 3), (5, 3), (5, 4), (6, 4);
"""


def at(day, hour=12):
    """Return the database time of a day of November 2026, in nanoseconds from 2001."""
    import datetime
    moment = datetime.datetime(2026, 11, day, hour)
    return int((moment.timestamp() - msg.APPLE_EPOCH) * 1e9)


def make_database(path):
    db = sqlite3.connect(path)
    db.executescript(TABLES)
    rows = [
        # id, text, body, handle, date, from me, error, item type, chat
        (1, "old sms", None, 1, at(1), 0, 0, 0, 2),
        (2, None, HELLO, 1, at(2), 0, 0, 0, 1),
        (3, "reply\nline 2", None, None, at(3), 1, 0, 0, 1),
        (4, None, CODE, 2, at(4), 0, 0, 0, 3),
        (5, "family news ‮evil", None, 3, at(5), 0, 0, 0, 4),
        (6, "renamed the group", None, 3, at(6), 0, 0, 2, 4),
        (7, "￼", None, 1, at(7), 0, 0, 0, 1),
        (8, "not sent", None, None, at(8), 1, 22, 0, 2),
        (9, "hi all", None, 4, at(9), 0, 0, 0, 5),
    ]
    for row in rows:
        db.execute("INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?, ?)", row[:8])
        db.execute("INSERT INTO chat_message_join VALUES (?, ?)", (row[8], row[0]))
    db.execute("INSERT INTO attachment VALUES (1, '~/Library/Messages/Attachments/ab/photo.jpg', 'image/jpeg', 'photo.jpg')")
    db.execute("INSERT INTO message_attachment_join VALUES (7, 1)")
    db.commit()
    db.close()


class Local:
    """The same interface as msg.Reader, on a SQLite file."""

    def __init__(self, path):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row

    def execute(self, sql, args=()):
        return [dict(row) for row in self.db.execute(sql, list(args))]


def options(**values):
    return SimpleNamespace(**{"since": None, "before": None, "limit": 20, "around": 5, "search": None, **values})


class MsgTest(unittest.TestCase):
    def setUp(self):
        self.path = os.path.join(tempfile.mkdtemp(), "chat.db")
        make_database(self.path)
        self.db = self.reader()

    def reader(self):
        return Local(self.path)

    def tearDown(self):
        self.db.db.close()

    def out(self, command, **values):
        with contextlib.redirect_stdout(io.StringIO()) as output:
            command(options(**values), self.db)
        return output.getvalue().splitlines()

    def exit_text(self, call, *args):
        with self.assertRaises(SystemExit) as caught:
            call(*args)
        return str(caught.exception)

    def test_body_text(self):
        self.assertEqual(msg.body_text(HELLO), "hello")
        self.assertEqual(msg.body_text(CODE), CODE_TEXT)
        self.assertEqual(msg.body_text(HEAD + b"\x7f" + b"a" * 127 + TAIL), "a" * 127)
        self.assertEqual(msg.body_text(HEAD + b"\x81\x80\x00" + b"b" * 128 + TAIL), "b" * 128)
        self.assertEqual(msg.body_text(HEAD + b"\x82\x70\x11\x01\x00" + b"z" * 70000 + TAIL), "z" * 70000)
        self.assertEqual(msg.body_text(b""), "")
        self.assertEqual(msg.body_text(b"no string here"), "")
        self.assertEqual(msg.body_text(HEAD), "")

    def test_chats(self):
        lines = self.out(msg.cmd_chats)
        self.assertEqual(lines[0], "5 chat(s), showing 5")
        self.assertEqual([line.split()[0] for line in lines[1:]], ["5", "2", "4", "3", "6"])
        self.assertEqual(lines[1], "     5  2026-11-09 12:00  iMessage      bob@example.com, +15550001111  (group of 2)")
        self.assertEqual(lines[2], "     2  2026-11-08 12:00  SMS/iMessage  +34612345678")
        self.assertEqual(lines[3], "     4  2026-11-05 12:00  iMessage      Family  (group of 2)")
        self.assertEqual(lines[5], "     6  -                 SMS           +15550001111")
        self.assertEqual(self.out(msg.cmd_chats, search="bbva")[1:], [lines[4]])
        self.assertEqual(self.out(msg.cmd_chats, limit=1)[:1], ["5 chat(s), showing 1"])
        self.assertEqual(len(self.out(msg.cmd_chats, limit=1)), 2)

    def test_find_chat(self):
        chats = msg.load_chats(self.db)
        for spec in ("1", "2", "+34612345678", "+34 612 345-678", "612345678"):
            self.assertEqual(msg.find_chat(chats, spec).ids, [2, 1], spec)
        self.assertEqual(msg.find_chat(chats, "family").id, 4)
        self.assertEqual(msg.find_chat(chats, "fam").id, 4)
        self.assertEqual(msg.find_chat(chats, "BBVA").id, 3)
        self.assertEqual(msg.find_chat(chats, "+15550001111").id, 6)
        self.assertIn("no chat matches 'nobody'", self.exit_text(msg.find_chat, chats, "nobody"))
        many = self.exit_text(msg.find_chat, chats, "1555")
        self.assertIn("'1555' matches 2 chats, give the ID:", many)
        self.assertIn("     6  ", many)

    def test_read_one_chat(self):
        lines = self.out(msg.cmd_read, chat="612345678")
        self.assertEqual(lines, [
            "== +34612345678 (SMS/iMessage, chat 2)",
            "#8 2026-11-08 12:00 me: [not delivered, error 22] not sent",
            "#7 2026-11-07 12:00 +34612345678: [file photo.jpg]",
            "#3 2026-11-03 12:00 me: reply line 2",
            "#2 2026-11-02 12:00 +34612345678: hello",
            "#1 2026-11-01 12:00 +34612345678: old sms",
        ])
        self.assertEqual(self.out(msg.cmd_read, chat="2", limit=2)[3], "more than 2: raise --limit or narrow the dates")
        self.assertEqual([line.split()[0] for line in self.out(msg.cmd_read, chat="2", since="2026-11-02",
                                                                before="2026-11-07")[1:]], ["#3", "#2"])
        self.assertEqual(self.out(msg.cmd_read, chat="6"), ["== +15550001111 (SMS, chat 6)", "no messages"])

    def test_read_all_chats(self):
        lines = self.out(msg.cmd_read, chat=None, limit=4)
        self.assertEqual(lines[0], "#9 2026-11-09 12:00 [bob@example.com, +15550001111] +15550001111: hi all")
        # A group change (item_type 2) is not a message.
        self.assertEqual(lines[3], "#5 2026-11-05 12:00 [Family] bob@example.com: family news evil")
        self.assertEqual(lines[4], "more than 4: raise --limit or narrow the dates")

    def test_search(self):
        self.assertEqual(self.out(msg.cmd_search, query="КОД", chat=None),
                         ["#4 2026-11-04 12:00 [BBVA] BBVA: Привет, код 4821 👍 вторая строка"])
        self.assertEqual(self.out(msg.cmd_search, query="e", chat=["family", "bbva"]), [
            "== Family (group of 2, iMessage, chat 4)", "== BBVA (SMS, chat 3)",
            "#5 2026-11-05 12:00 [Family] bob@example.com: family news evil"])
        self.assertEqual(self.out(msg.cmd_search, query="absent", chat=None), ["no matches"])

    def test_context(self):
        self.assertEqual(self.out(msg.cmd_context, id=3, around=1), [
            "== +34612345678 (SMS/iMessage, chat 2)",
            "  #2 2026-11-02 12:00 +34612345678: hello",
            "> #3 2026-11-03 12:00 me: reply",
            "    line 2",
            "  #7 2026-11-07 12:00 +34612345678: [file ~/Library/Messages/Attachments/ab/photo.jpg]",
        ])
        self.assertEqual(len(self.out(msg.cmd_context, id=1, around=0)), 2)
        self.assertEqual(self.exit_text(msg.cmd_context, options(id=99), self.db), "no message #99 in a chat")

    def test_snippet_and_day(self):
        long = "a" * 400 + " needle " + "b" * 400
        cut = msg.snippet(long, "NEEDLE")
        self.assertIn("needle", cut)
        self.assertTrue(cut.startswith("…") and cut.endswith("…") and len(cut) == msg.SNIPPET + 2)
        self.assertEqual(msg.day("2026-11-02"), at(2, 0))
        self.assertIn("bad date", self.exit_text(msg.day, "soon"))
        self.assertEqual(msg.stamp(at(2) // 10 ** 9), "2026-11-02 12:00")

    def test_batches(self):
        msg.BATCH, saved = 2, msg.BATCH
        try:
            self.assertEqual([message["id"] for _, message in msg.messages(self.db)], [9, 8, 7, 5, 4, 3, 2, 1])
        finally:
            msg.BATCH = saved


@unittest.skipUnless(shutil.which("swiftc"), "no swiftc")
class ReaderTest(MsgTest):
    """The same tests through the Swift reader, built with no sandbox so that it can open the test database."""

    @classmethod
    def setUpClass(cls):
        cls.binary = os.path.join(tempfile.mkdtemp(), "reader")
        subprocess.run(["swiftc", "-O", "-o", cls.binary, os.path.join(os.path.dirname(HERE), "reader", "main.swift")],
                       check=True)

    def reader(self):
        return msg.Reader([self.binary, "serve", self.path])

    def tearDown(self):
        for pipe in (self.db.process.stdin, self.db.process.stdout, self.db.process.stderr):
            pipe.close()
        self.db.process.wait()

    def test_refuses_a_write(self):
        self.assertEqual(self.exit_text(self.db.execute, "DELETE FROM message"),
                         "Messages database error: the statement is not read-only")
        self.assertEqual(self.db.execute("SELECT COUNT(*) AS n FROM message"), [{"n": 9}])

    def test_values(self):
        self.assertEqual(self.db.execute("SELECT ? AS a, ? AS b, ? AS c, ? AS d, x'00ff' AS e", ["ж\n", 5, 1.5, None]),
                         [{"a": "ж\n", "b": 5, "c": 1.5, "d": None, "e": b"\x00\xff"}])
        self.assertEqual(self.exit_text(self.db.execute, "SELECT ? AS a, ? AS b", [1]),
                         "Messages database error: the statement and the request have a different number of values")

    def test_no_access(self):
        self.tearDown()
        self.db = msg.Reader([self.binary, "serve", self.path + ".none"])
        text = self.exit_text(self.db.execute, "SELECT 1")
        self.assertIn("unable to open database file", text)
        self.assertIn("msg.py setup` in a terminal", text)

    def test_not_built(self):
        self.assertIn("the reader is not built", self.exit_text(msg.Reader, [self.binary + ".none", "serve"]))


if __name__ == "__main__":
    unittest.main()
