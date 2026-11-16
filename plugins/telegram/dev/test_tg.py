# /// script
# requires-python = ">=3.10"
# dependencies = ["telethon==1.45.0", "qrcode==8.2"]
# ///
import asyncio
import os
import sqlite3
import stat
import sys
import tempfile
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import tg  # noqa: E402
from telethon import errors, helpers  # noqa: E402
from telethon.tl import types  # noqa: E402
from telethon.tl.types import auth  # noqa: E402

ANN = SimpleNamespace(id=7, is_user=True, name="Ann‮", input_entity="peer of Ann",
                      entity=SimpleNamespace(is_self=False, bot=False, username="ann"))


class Client:
    def __init__(self, error=None, dialogs=(ANN,)):
        self.error, self.dialogs, self.sent, self.state_at_send = error, dialogs, [], None

    async def get_dialogs(self):
        return list(self.dialogs)

    async def send_message(self, target, text, **options):
        with sqlite3.connect(tg.state_path("drafts.db")) as other:
            self.state_at_send = other.execute("SELECT state FROM drafts").fetchone()[0]
        self.sent.append((target, text, options))
        if self.error:
            raise self.error
        return SimpleNamespace(id=99)


class TgTest(unittest.TestCase):
    def setUp(self):
        tg.STATE_DIR = os.path.join(tempfile.mkdtemp(), "telegram")
        self.db = tg.open_db()
        self.n = tg.make_draft(self.db, ANN, "line 1\nline 2")

    def send(self, client):
        asyncio.run(tg.send_draft(self.db, self.n, client))
        return tg.get_draft(self.db, self.n)

    def test_session_file(self):
        os.chmod(tg.STATE_DIR, 0o755)
        tg.save_secret("1:hash:old")
        tg.save_secret("1:hash:session")
        self.assertEqual(tg.read_secret(), "1:hash:session")
        self.assertEqual(stat.S_IMODE(os.stat(tg.state_path("session")).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(tg.STATE_DIR).st_mode), 0o700)
        self.assertEqual(sorted(os.listdir(tg.STATE_DIR)), ["drafts.db", "session"])

    def test_text(self):
        self.assertEqual(tg.check_text("a\tb\r\nc \n\n"), "a\tb\nc")
        for bad in ("", " \n", "a\x00b", "a\x1bb", "a‮b", "a⁦b", "a\u200bb", "a\u200fb", "a\u061cb",
                    "a\u2060b", "a\u206ab", "a\ufeffb"):
            with self.assertRaises(SystemExit):
                tg.check_text(bad)
        self.assertEqual(tg.check_text("👨\u200d👩"), "👨\u200d👩")

    def test_output_has_no_control_characters(self):
        self.assertEqual(tg.title(ANN), "Ann")
        message = SimpleNamespace(out=False, sender=types.User(id=1, first_name="Bob\x1b[31m\u200e"),
                                  fwd_from=None, action=None, media=None, text="a\x1b[2Jb‮\nc\td")
        self.assertEqual((tg.sender(message), tg.content(message)), ("Bob[31m", "a[2Jb\nc\td"))

    def test_draft_is_fixed(self):
        draft = tg.get_draft(self.db, self.n)
        self.assertEqual(draft["label"], "Ann (user, @ann, 7)")
        self.assertEqual(tg.draft_lines(draft)[:2], [f"draft {self.n}: draft", "to: Ann (user, @ann, 7)"])
        for column in ("chat", "label", "text"):
            with self.assertRaises(sqlite3.DatabaseError):
                self.db.execute(f"UPDATE drafts SET {column} = 1")

    def test_sent(self):
        client = Client()
        draft = self.send(client)
        self.assertEqual((draft["state"], draft["message_id"], draft["error"]), ("sent", 99, None))
        self.assertEqual(client.sent, [("peer of Ann", "line 1\nline 2", {"parse_mode": None, "link_preview": False})])
        self.assertEqual(client.state_at_send, "unknown")

    def test_no_second_send(self):
        for error in (None, errors.ChatWriteForbiddenError(None), ConnectionError("lost")):
            with self.subTest(error=error):
                self.n = tg.make_draft(self.db, ANN, "text")
                self.send(Client(error))
                again = Client()
                with self.assertRaises(SystemExit):
                    self.send(again)
                self.assertEqual(again.sent, [])

    def test_failed(self):
        for error in (errors.ChatWriteForbiddenError(None), errors.FloodWaitError(None, 30)):
            with self.subTest(error=error):
                self.n = tg.make_draft(self.db, ANN, "text")
                self.assertEqual(self.send(Client(error))["state"], "failed")

    def test_unknown(self):
        for error in (errors.RandomIdDuplicateError(None), ConnectionError("lost"), asyncio.CancelledError()):
            with self.subTest(error=error):
                self.n = tg.make_draft(self.db, ANN, "text")
                draft = self.send(Client(error))
                self.assertEqual(draft["state"], "unknown")
                self.assertTrue(draft["error"])

    def test_chat_not_in_list(self):
        client = Client(dialogs=())
        with self.assertRaises(SystemExit):
            self.send(client)
        self.assertEqual((client.sent, tg.get_draft(self.db, self.n)["state"]), ([], "draft"))

    def test_sign_in_asks_for_the_next_kind_of_code(self):
        calls, answers = [], iter(["+1 555", "", "", "000", "123"])

        class Login:
            async def send_code_request(self, phone):
                calls.append(("code", phone))
                first = len(calls) == 1
                return auth.SentCode(auth.SentCodeTypeApp(5) if first else auth.SentCodeTypeSms(5), "hash",
                                     next_type=auth.CodeTypeSms() if first else None)

            async def sign_in(self, phone=None, code=None, password=None):
                calls.append(("sign in", phone, code, password))
                if code == "000":
                    raise errors.PhoneCodeInvalidError(None)
                if code:
                    raise errors.SessionPasswordNeededError(None)
                if password == "bad":
                    raise errors.PasswordHashInvalidError(None)
                return "me"

        prompts, passwords = [], iter(["bad", "2fa"])
        me = asyncio.run(tg.sign_in(Login(), lambda prompt: prompts.append(prompt) or next(answers),
                                    lambda prompt: next(passwords)))
        self.assertEqual(me, "me")
        self.assertEqual(calls, [("code", "+1 555"), ("code", "+1 555"), ("sign in", "+1 555", "000", None),
                                 ("sign in", "+1 555", "123", None), ("sign in", None, None, "bad"),
                                 ("sign in", None, None, "2fa")])
        self.assertEqual(prompts[1:], ["code, or nothing to get a new code by Sms: ", "code: ", "code: ", "code: "])

    def test_qr_sign_in(self):
        calls, shown = [], []

        class Qr:
            url = "tg://login?token=1"

            async def wait(self):
                calls.append("wait")
                raise asyncio.TimeoutError() if calls.count("wait") == 1 else errors.SessionPasswordNeededError(None)

            async def recreate(self):
                calls.append("recreate")
                self.url = "tg://login?token=2"

        class Login:
            async def qr_login(self):
                return Qr()

            async def sign_in(self, password=None):
                calls.append(password)
                return "me"

        me = asyncio.run(tg.sign_in(Login(), lambda prompt: "", lambda prompt: "2fa", shown.append))
        self.assertEqual((me, calls), ("me", ["wait", "recreate", "wait", "2fa"]))
        self.assertEqual(shown, ["tg://login?token=1", "tg://login?token=2"])
        self.assertTrue(tg.new_client(1, "hash")._no_updates)
        self.assertFalse(tg.new_client(1, "hash", receive_updates=True)._no_updates)

    def test_send_has_one_attempt(self):
        client = tg.new_client(1, "hash", **tg.ONE_ATTEMPT)
        self.assertEqual(list(helpers.retry_range(client._request_retries)), [1])
        self.assertEqual((client._auto_reconnect, client.flood_sleep_threshold), (False, 0))


if __name__ == "__main__":
    unittest.main()
