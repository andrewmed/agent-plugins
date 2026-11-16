# whatsapp

A plugin for Claude Code and pi with one skill. The skill searches and reads the WhatsApp chats of the user in a local copy. It also makes drafts, and sends a draft after the user approved it.

`wa.ts` connects as a linked device of the account of the user, with [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client. The design and its reasons are in `dev/DESIGN.md`. The measured behavior is in `dev/NOTES.md`.

## Requirements

Node 24 or later, and npm. When the modules are not installed, the next read command that syncs, or `link`, runs `npm ci --omit=dev --ignore-scripts` in the plugin folder. A read with `--offline` needs no modules. `send` does not install: it tells the agent to run a read command first. This occurs after each new plugin version in Claude Code, and in pi after an update of the git package to a new commit (`pi update` removes the untracked files of the package with `git clean`). A local package path in pi keeps its modules.

## Link

Run this one time in a terminal:

```sh
node <plugin folder>/wa.ts link
```

The script prints a QR code. On the phone: WhatsApp > Settings > Linked devices > Link a device. Scan the code. The first code is valid for 60 s and each next code for 20 s. The script prints each one. When WhatsApp gives no more codes, the script stops with a time-out: run it again. The terminal must have 256 colors, and the window must have 63 columns and 35 rows or more.

For a pairing code in place of the QR code, give the phone number of the account with the country code:

```sh
node <plugin folder>/wa.ts link --phone 34600000000
```

The script prints a pairing code. On the phone: WhatsApp > Settings > Linked devices > Link a device > Link with phone number instead. Type the code.

The QR code and the pairing code let a phone link the device: do not show them to other persons while the script waits.

After the link, the script writes the history that the phone sends to the store. This can take some minutes. The script stops when no history comes for 60 s. If you stop it with Ctrl+C, it first completes the part of the history that downloads, for up to 40 s.

To unlink the device, remove it in Linked devices on the phone. To link again, delete `~/.local/state/whatsapp/auth` first.

## Approval of each send

The script cannot know if you approved a draft. The agent asks you, as `SKILL.md` tells it. You approve in the terminal or in a Mattermost post. Pi has no permission prompt, so in pi this is the only control. To make Claude Code also ask you before each send, add this rule to `permissions.ask` in `~/.claude/settings.json`:

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

`wa.ts` connects to `web.whatsapp.com` and `mmg.whatsapp.net`, and gets the current WhatsApp Web version from `raw.githubusercontent.com`. The module install also needs `registry.npmjs.org`. A read with `--offline` needs no network. If the sandbox of Claude Code is on, allow these hosts or exclude the command. In pi, the agent tells you which host a sandbox blocks.

## Risks

- WhatsApp does not allow unofficial clients. WhatsApp can ban an account that uses one. Few connections and few sends keep the risk low, but not zero.
- Baileys and its dependencies run with your rights and can read `auth/`. This includes `whatsapp-rust-bridge`, a prebuilt WebAssembly binary. The versions are fixed in `package-lock.json`. Update Baileys only by hand.
- The device is connected only during a call. A message that arrives between calls comes at the next sync only if WhatsApp still keeps it for the device. The time that WhatsApp keeps it is not known.

## Tests

In this folder: `npm ci`, then `node --test dev/`.
