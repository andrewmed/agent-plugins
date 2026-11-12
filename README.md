# agent-plugins

Plugins for [Claude Code](https://code.claude.com) and [pi](https://pi.dev).

This repository is a Claude Code plugin marketplace and a pi package at the same time. Each plugin is a folder in `plugins/`.

| Plugin                           | Claude Code | pi  | What it does                                                         |
| -------------------------------- | ----------- | --- | -------------------------------------------------------------------- |
| [mattermost](plugins/mattermost) | yes         | yes | Connects each agent session to its own bot and channel in Mattermost |
| [mail](plugins/mail)             | yes         | no  | Reads two mailboxes over IMAP, saves drafts and trashes messages     |

Read the README of a plugin before you install it. A plugin can need its own configuration.

## Install in Claude Code

From a shell:

```sh
claude plugin install <plugin> --marketplace andrewmed/agent-plugins
```

Or at the prompt of a session:

```
/plugin marketplace add andrewmed/agent-plugins
/plugin install <plugin>@andrewmed
```

### Automatic update

Claude Code does not update a third-party marketplace by default. To turn the update on, open `/plugin`, select the marketplace `andrewmed` and select **Enable auto-update**.

Or declare the marketplace and the plugins in `~/.claude/settings.json`. Claude Code then installs them at the next start, so this is also a way to install on a new machine:

```json
{
  "extraKnownMarketplaces": {
    "andrewmed": {
      "source": { "source": "github", "repo": "andrewmed/agent-plugins" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": {
    "mattermost@andrewmed": true
  }
}
```

Claude Code gets the new version in the background during a session. The new version loads at the next start or after `/reload-plugins`.

The plugins have no version number. Each commit in this repository is a new version of each plugin.

## Install in pi

```sh
pi install git:github.com/andrewmed/agent-plugins
```

The package gives pi the extensions of all plugins. To load only some of them, use the object form in `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    {
      "source": "git:github.com/andrewmed/agent-plugins",
      "extensions": ["plugins/mattermost/pi.ts"]
    }
  ]
}
```

### Automatic update

Pi shows a notice when a package has a new commit, but it does not install it. The extensions in this repository do that: at the start of pi, the extension runs `pi update` for this package in the background. The new commit loads at the next start of pi.

To update by hand: `pi update git:github.com/andrewmed/agent-plugins`.

## Automatic update and trust

A plugin runs with your rights. With the automatic update on, each new commit on `main` of this repository runs on your machine at the next start, with no review by you. If you do not want that, do not turn on the update in Claude Code, and pin the pi package to a commit: `pi install git:github.com/andrewmed/agent-plugins@<commit>`.

## Structure

```
.claude-plugin/marketplace.json   list of the plugins for Claude Code
package.json                      pi package manifest: the pi extensions of all plugins
plugins/
  <name>/
    .claude-plugin/plugin.json    Claude Code plugin manifest
    .mcp.json                     MCP servers of the plugin
    hooks/hooks.json              hooks of the plugin
    SKILL.md                      skill of the plugin
    pi.ts                         pi extension
    dev/                          tests and development notes
```

A plugin needs only the files for the harness that it supports.

### Add a plugin

1. Make the folder `plugins/<name>` with `.claude-plugin/plugin.json`. Do not set `version` there.
2. Add the plugin to `plugins` in `.claude-plugin/marketplace.json` with `"source": "./plugins/<name>"`.
3. If the plugin has a pi extension, add its path to `pi.extensions` in the root `package.json`.
4. Add a row to the table in this file.
5. Run `claude plugin validate .` and `claude plugin validate plugins/<name>`.

A pi extension that runs `bun` or `npm` modules of its plugin folder does not work: pi installs only the dependencies of the root `package.json`.

## License

MIT. See [LICENSE](LICENSE).
