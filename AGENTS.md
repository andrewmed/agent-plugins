# agent-plugins

A Claude Code plugin marketplace and a pi package. Each plugin is a folder in `plugins/`.

- `README.md`: the install and the automatic update.
- `plugins/mattermost/README.md`: the functions, the configuration and the security rules of the plugin.
- `plugins/mattermost/dev/NOTES.md`: the measured behavior of Claude Code, pi and Mattermost, and the test methods. Each section has a date. An old section can disagree with the code. Write new measured behavior in a new section with the date.

## Release

- `plugins/mattermost/.claude-plugin/plugin.json` has no `version`, so each commit is a new version. Claude Code with the automatic update on, and pi, get a pushed commit at a later start. Thus a push to `main` is a release.
- A running session keeps the code that it loaded at its start. The Mattermost connection of the session that edits this repository runs the installed copy, not the working copy.

## Bun and Node

- `plugins/mattermost/mattermost.ts` and `plugins/mattermost/session.ts` run in Bun (`server.ts`, Claude Code) and in Node (`pi.ts`, pi). Use only functions that Bun and Node both have. The `WebSocket` of Node has no `terminate()` and no `ping` event.
- `node` cannot load these files directly, because they use parameter properties. To run them in Node: `bun build <file> --target=node --outfile=<name>.mjs`, then `node <name>.mjs`.

## Tests

- In `plugins/mattermost`: `bun install`, then `bun test dev`.
- After a change in `mattermost.ts` or `session.ts`, also run the changed code in Node.
- For a test with a real Claude Code or a real pi, use `plugins/mattermost/dev/fake-mattermost.ts` and a method from `plugins/mattermost/dev/NOTES.md`. The project folder of the test must not be the folder of a running session.
- The tests do not use the production Mattermost server. In the report, tell what you did not test there.

## Diagnosis

Symptom: a post gets the `eyes` reaction, but no turn starts in Claude Code. The direction from the terminal to Mattermost works.

Cause: the `claude` process started without `--dangerously-load-development-channels plugin:mattermost@andrewmed`. The MCP log in the folder `mcp-logs-plugin-mattermost-mattermost` then has the line `Channel notifications skipped: server plugin:mattermost:mattermost not in --channels list for this session`. A shell that started before a change of the `claude` shell function keeps the old function.
