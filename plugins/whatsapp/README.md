# whatsapp

A Claude Code plugin with one skill. The skill searches and reads the WhatsApp chats of the user in a local copy. It also makes drafts, and sends a draft after the user approved it.

`wa.ts` connects as a linked device of the account of the user, with [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client. The design and its reasons are in `dev/DESIGN.md`. The measured behavior is in `dev/NOTES.md`.

## Requirements

Node 24 or later, and npm. At the first run of each plugin version, `wa.ts` runs `npm ci --ignore-scripts` in the plugin folder.

## Link

Run this one time in a terminal, with the phone number of the account and the country code:

```sh
node <plugin folder>/wa.ts link --phone 34600000000
```

The script prints a pairing code. On the phone: WhatsApp > Settings > Linked devices > Link a device > Link with phone number instead. Type the code. Then the script writes the history that the phone sends to the store. This can take some minutes. The script stops when no history comes for 60 s. If you stop it with Ctrl+C, it first completes the part of the history that downloads, for up to 40 s.

To unlink the device, remove it in Linked devices on the phone. To link again, delete `~/.local/state/whatsapp/auth` first.

## Approval of each send

The script cannot know if you approved a draft. The agent asks you, as `SKILL.md` tells it. To make Claude Code also ask you before each send, add this rule to `permissions.ask` in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "ask": ["Bash(node *wa.ts send *)"]
  }
}
```

The rule has an effect also when `node` is allowed. It has no effect in the `bypassPermissions` mode.

## State

All state is in `~/.local/state/whatsapp/`, with mode 0700:

| File       | What it holds                                                               |
| ---------- | --------------------------------------------------------------------------- |
| `auth/`    | The credentials of the linked device. They give full access to the account. |
| `store.db` | The local copy of the chats, and the drafts. It is plain text on the disk.  |
| `lock.db`  | A lock, so that only one call at a time connects.                           |

Delete the folder to remove all of it.

## Network

`wa.ts` connects to `web.whatsapp.com` and `mmg.whatsapp.net`, and gets the current WhatsApp Web version from `raw.githubusercontent.com`. The first run of a plugin version also needs `registry.npmjs.org`. If the sandbox of Claude Code is on, allow these hosts or exclude the command.

## Risks

- WhatsApp does not allow unofficial clients. WhatsApp can ban an account that uses one. Few connections and few sends keep the risk low, but not zero.
- Baileys and its dependencies run with your rights and can read `auth/`. This includes `whatsapp-rust-bridge`, a prebuilt WebAssembly binary. The versions are fixed in `package-lock.json`. Update Baileys only by hand.
- The device is connected only during a call. A message that arrives between calls comes at the next sync only if WhatsApp still keeps it for the device. The time that WhatsApp keeps it is not known.

## Tests

In this folder: `npm ci`, then `node --test dev/`.
