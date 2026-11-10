# Stage 1 notes

## Admin setup, 2026-11-09

- `EnableBotAccountCreation` is `true` (public client config).
- The provisioning user can log in (HTTP 200).
- The provisioning user is a team admin, not a system admin. It gets the bot rights from the role `system_user`.
- `mmctl permissions add` worked on Team Edition. Role `system_user` has `create_bot`, `manage_bots`, `read_bots` and `create_user_access_token`.
- The design also needs `read_user_access_token` and `revoke_user_access_token`, to revoke the old tokens of a bot (`server/channels/api4/user.go:2915` and `:2988`). With no such permission, the provisioning user gets HTTP 403. They were added after that test. List and revoke now give HTTP 200, and a revoked token leaves the list.

## Items 3 and 4, Mattermost, 2026-11-09

Bot `mm-probe-claude`, channel `mm-probe-claude`.

- As the provisioning user: make bot 201, make bot credential 200, add to team 201. The same request for the owner gives 403.
- WebSocket: `authentication_challenge` with the bot credential gives `OK` and `hello`.
- The bot makes a public channel (201) and adds the owner (201).
- `posted` from the bot: `type` empty, props `from_bot`. `posted` from the provisioning user: `type` empty, no props, `user_id` is that user.
- `eyes` reaction 200. Bot status while connected: `online`.
- Second run, with the values of a `.env` file in the plugin folder: same results. Bun loads that file from the working directory. The probe found the existing bot and channel, and the revoke gave HTTP 200.

## Item 1, Claude Code

Self-test with no Claude Code:

- Mirror hook line: exit 0 with a socket and with no socket.
- Rewake hook line: the newest waiter gets the text on stderr and exits 2. The older waiter exits 0. With no socket, exit 0.
- `/channel` writes `notifications/claude/channel` to stdout.
- A closed stdin pipe stops the probe at once and removes the socket. A FIFO test did not show this. Test with a pipe.

Results in `mm-test`, Claude Code 2.1.319, Claude Max:

- **Channels do not register.** At start: `--dangerously-load-development-channels ignored (server:mattermost)` and `Channels are not currently available`. The MCP entry connects, and the hooks reach the socket.
- Source of the message, in the binary: `disabled` is `W6t()`. It is true when the flag `tengu_harbor` reads false, or when the policy limit `allow_channels` denies. `cachedGrowthBookFeatures.tengu_harbor` in `~/.claude.json` is `true`. `~/.claude/settings.json` sets `DISABLE_TELEMETRY` and `CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF`. The cause is not proved.
- **Root cause.** `DO_NOT_TRACK` (shell profile) and `DISABLE_TELEMETRY` (`~/.claude/settings.json`) turn off the feature flags, so `tengu_harbor` reads as its default `false`. The account is not the block.
- Starts that show this:
  - Both variables unset: the gate opens and the development-channel dialog shows.
  - Both set, `CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF=1` in the process environment: the gate opens, with telemetry off.
  - Both set, that variable only in `~/.claude/settings.json`: `Channels are not currently available`. A fresh flag cache does not change this.
- To keep telemetry off, export that variable in the environment that starts `claude`.
- The development-channel dialog shows at each start.
- Not tested, because channels are off: an approval in a channel message, and `UserPromptSubmit` for a channel message. `Force push` is in `autoMode.hard_deny` of `~/.claude/settings.json`, so compare with the same approval typed at the terminal.
- Rewake hook: it starts a turn, and the agent answered.
- `UserPromptSubmit` fires for the rewake turn. `prompt` starts with `<task-notification>` and has the text in a `<system-reminder>`: `Stop hook blocking error from command "Stop": <text>`. The mirror must ignore such a prompt. The comment in `Waiter` that says this turn fires no `UserPromptSubmit` is not correct here.
- `prompt` does not have the words "NOT USER INPUT".
- `Stop` input has `last_assistant_message`.

## Item 5, agterm session id

Read in the source, not run. `SessionSnapshot.id` (`agtermCore/Sources/agtermCore/Snapshot.swift:149`) is saved, and `AppStore+Snapshot.swift:86` restores it with `Session(id: snapshot.id, ...)`. The session id stays the same after agterm starts again. The key stays `AGTERM_SESSION_ID`.

## Item 1, end of the test, with the variable in the environment

- `server:mattermost` from `~/.claude.json` registers. The dialog shows at each start.
- `UserPromptSubmit` fires for a channel message. `prompt` starts with `<channel source="mattermost" user="owner">`. The mirror must ignore such a prompt.
- Auto mode blocked `git push --force origin main` with `[Git Destructive]`. An approval in a channel message cleared the block, and the push ran. A channel message has user authority for the classifier.

## Session key, in place of AGTERM\_\*

- The MCP server has `CLAUDE_PROJECT_DIR`. The session key is this directory. The lock file name comes from it.
- A hook's `$PPID` and the first ancestor of the MCP server that is not `bun` are the same `claude` process. The socket is `run/<that pid>.sock`. This works in each terminal, and each `claude` process has its own socket.
- A second `claude` in the same directory does not get the lock. It is passive and has no socket, so its hooks do nothing.

## Tests with dev/fake-mattermost.ts, real Claude Code

The prompt of the implementation session had no password for the provisioning user. These tests use `MM_URL` of the fake server in the process environment, so the values of `.env` are not used. Not tested on the production server.

- Stage 2 passed: owner post with `eyes` and mention, terminal prompt as a quote, webhook and system posts with the owner id ignored, agent post by rewake and treated as data, permission relay. A verdict from a different user and from a webhook with the owner id did not answer the prompt. The verdict of the owner did.
- Stage 4 passed: one session gave a task to a different session and got the result in the thread. 8 posts gave 6 `eyes` and 2 `no_entry_sign`. An owner post resets the count. A mention in `agents` is delivered, and a post with no mention is not. A second session in the same folder is passive.
- The limit test uses scripted posts, because the agents stop on their own and do not make a loop.
- Before an upgrade to Mattermost 12: that version removes the `from_*` props from client payloads, and `isNormalPost` depends on them.
- Stage 5 passed on the fake server: direct message with the answer in the same channel, typing, a file in the two directions, `read`, `search`, thumbs-up verdict (a thumbs-up from a different user does nothing), session notices, dialog notice, cleanup. `reply` refuses a post that the session did not receive, and `send` refuses a name that is not a live session.
- `AskUserQuestion`: a `PreToolUse` hook on a turn from Mattermost posts the question and waits. The answer goes back in `updatedInput.answers` with `permissionDecision: allow`, and Claude Code accepts it with no dialog. On a turn from the terminal the hook answers at once and the normal dialog shows.

## The production server, with the values of `.env`, 2026-11-09

The server in a test session loads `.env` through the MCP entry. Passed: login, bot and channel made, `agents` channel, online status in `list_sessions`, session notices, terminal prompt as a quote, `read`, `send`, a task from one session to a different session, and the answer in the thread.

Not tested on this server, because the agent had no password for the provisioning user and cannot post as the owner: an owner post, a verdict, a thumbs-up, `AskUserQuestion`, a direct message, a file, and the security tests with posts from the provisioning user, from a bot and from a webhook. These passed on the fake server only. The provisioning user cannot make a token for the owner: passed here in items 3 and 4.

## Review with Codex

Fixed: order of the token revoke, cleanup checks (lock and channel creator), scope of `send` and `reply`, order of inbound events, tracking in `read`, a failed post of a question.

Later change, 2026-11-09: the wait in `PreToolUse` for `AskUserQuestion` left only a spinner in the terminal, so the hook now denies the tool on a turn from Mattermost and the agent writes the question as text. An answer can come from the terminal or from Mattermost. `Stop` posts all assistant text of the turn, read from `transcript_path`. In a `PreToolUse` hook the transcript does not have the current message. Tested on the fake server only.

Not changed: posts during a WebSocket reconnect are not fetched (plan, Risks). The hook socket trusts the same OS user. While a question is open, the next owner post in that channel is the answer. `assertSendable` refuses only `.env*` files and the state directory. Shutdown waits at most 1.5 s for the last post.

## Slash commands from a post, 2026-11-09

- Claude Code 2.1.319 gives each channel message `skipSlashCommands: true`. The MCP server cannot change this.
- The MCP server has the controlling terminal of `claude`. A `perl` child can use `TIOCSTI` on `/dev/tty`. Hook processes and Bash tool processes have no controlling terminal, and `TIOCSTI` gives errno 13 there.
- Results in a throwaway `claude` in a pty:
  - `/compact`, `/clear`, `/context`, `/model X` and `/effort X` run with text, a pause of 150 ms and Enter. `/cost` also ran with text and Enter in one write.
  - Each command writes `<local-command-stdout>` to the transcript. `/context` and `/clear` use a row with `type: system`, `subtype: local_command` and the text in `content`. The others use `message.content`.
  - `/cost` and `/usage` open a dialog ("Esc to cancel"). The dialog takes all typed text. They are not in the allowlist.
  - A local command fires no `UserPromptSubmit` and no `Stop`. `/compact` fires `PreCompact` and `SessionStart` with source `compact`. `/clear` fires `SessionEnd` and `SessionStart` with source `clear`, and the transcript path changes.
  - `/model X` and `/effort X` save the value in `~/.claude/settings.json` as the default for new sessions. A test that runs them must restore these values.
- A nested `claude` does not save a transcript if `CLAUDE_CODE_CHILD_SESSION` is set. Unset it and set `CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1`. Use `--strict-mcp-config`, so that only the `mattermost` server starts.
- End to end, real Claude Code and the fake server: refusal during a turn, a normal post, `/context`, `/compact`, `/clear` and an unknown name passed. `/model` and `/effort` did not run through the server. Not tested on the production server.
- Accepted risk, decision of the owner: the hooks do not show the state of the terminal prompt. A draft joins the command and goes to the model. Enter can select an item in a dialog that the user opened. The review with Codex recommended no terminal input until a signal for an empty prompt exists.

## Pi version, 2026-11-09

`pi.ts` is a pi extension. `session.ts` has the code that `server.ts` and `pi.ts` share. The link `~/.pi/agent/extensions/mattermost` points to this folder. `package.json` has the manifest `pi.extensions`.

- Pi 0.99.1 on Node 26. The extension runs in the pi process. It needs no `bun install`, MCP server, hooks or agterm.
- `pi.ts` reads `.env` with `util.parseEnv` and does not change `process.env`. Thus the bash tool does not get the password. A value in the process environment has priority.
- Only `ctx.mode === 'tui'` connects. `pi -p`, JSON mode and RPC mode are passive. A second pi in the same folder is passive.
- A pi bot has the name `<folder>-pi`, the marker `mm-agent-pi host=... session=...` and the lock key `pi:<folder>`. Claude Code and pi in the same folder have different bots and channels. Each harness removes only its own gone bots. `list_sessions`, `send` and `read` work across the two harnesses.
- Text on stderr corrupts the pi terminal. The log is `~/.config/mattermost-agents/pi.log`.
- Pi gives no result for `pi.sendUserMessage`. During compaction it rejects the prompt and shows the error only in the terminal. `deliver` holds a post while the session is not idle and has no abort signal. Busy and no signal occurs only during compaction and between retries.
- `ctx.newSession` exists only in a command context. A post `/new` runs the extension command `/mattermost-new`.
- Pi has no permission system. A dialog of an extension gives only the notice `A dialog waits at the terminal`. The dialog cannot be answered from Mattermost.
- Session replacement (`/new`, `/resume`, `/fork`, `/reload`) replaces the extension runtime. Each one makes a new connection and a new bot token. `stop` waits for a running provision, because a late provision can revoke the token of the new runtime.

Method: real pi in a tmux pane with `AGTERM_*` unset. `PI_CODING_AGENT_DIR` is an empty folder that has only the link in `extensions/`. All `MM_*` values are in the process environment and point to `dev/fake-mattermost.ts`, so `.env` is not used. `pi -e dev/fake-provider.ts --provider fake --model echo` uses no model tokens. The fake model echoes the last message. `TOOL <name> <json>` makes it call a tool, `SLOW` waits 3 s, `FAIL` gives an error.

Passed on the fake server:

- Owner post with `eyes` and mention, terminal prompt as a quote, agent post as data, direct message with the answer in the same channel, typing.
- A post during a run steers the run. Three posts with no pause all reach the model. A post during `/compact` waits and then runs, after a compaction that succeeds and after one that fails.
- `/context`, `/model`, `/thinking`, `/compact`, `/new`, a skill by its short name, a refusal of an unknown name, a path that starts with `/` stays a message, `/compact` during a run is refused.
- All six tools. A file in the two directions. `read` and `search`. A refused name in `send`.
- 6 agent posts delivered, 2 with `no_entry_sign`, and an owner post resets the count.
- `/reload` and `/new` give one reply per post, so the old socket is closed.
- A terminal dialog gives the notice. A failed connection shows a warning in the terminal, and pi continues.
- `/quit` posts `Session ended` and frees the lock. A new start in the same folder finds the same bot.
- `bun server.ts` after the move to `session.ts`: tools, `list_sessions` shows the pi bots, `send` with a file reaches a pi session.

Not tested on the production server. The agent cannot read `.env`, and a test there makes a bot and a channel.

If a post arrives while pi prepares a run, pi runs the two prompts one after the other. The first run ends the reply state, so the second answer has no mention and goes to the channel of the session.

## Post `! <command>`, 2026-11-09

The server types the post into the terminal, the same as `/context`. Measured on Claude Code 2.1.319 with the fake server:

- Rows: `<bash-input>...</bash-input>`, then one user row `<bash-stdout>...</bash-stdout><bash-stderr>...</bash-stderr>` when the command ends. The rows have no exit status.
- The text `! cmd` in one TIOCSTI write gives bash mode and the input `! cmd`, so the shell negates `cmd`. The server types `!`, waits 150 ms, then types `cmd`.
- Bash mode moves a command to the background at 120 s and writes a row with that message. The server waits 150 s for the row and keeps the lock during this time.
- Output of 340 KB gives `<persisted-output>` with a 2 KB preview. The server cuts the post at 12000 characters.
- A `!` command fires no `UserPromptSubmit`. Claude Code starts a model turn after the output. `Stop` posts the reply with no mention, to the channel of the session.
- Text typed while a `!` command or a model turn runs goes to the Claude Code queue. It does not go to the command.
- A draft in the prompt: the input `draft!echo joined` goes to the model. No shell command runs. No row appears, so terminal commands are refused for 150 s.
- An open dialog: the text does not go to a shell, but Enter selects the focused option. Tested on `Switch model?` with `2. No, go back` focused.

Not tested on the production server.

## Linux, herdr and one transcript reader, 2026-11-09

- `O_EXLOCK` does nothing on Linux. A second open with flag `0x20` succeeded on Debian 13. Linux now uses an abstract Unix socket, which the kernel frees when the process ends. Tested with bun and Node in a Linux container and with Node on Debian. macOS keeps `O_EXLOCK`.
- `/proc/sys/dev/tty/legacy_tiocsti` is 0 on both Debian hosts, so `TIOCSTI` cannot type there. In a herdr pane the server uses `herdr pane send-text <pane> <text>`. A carriage return in the text submits the prompt.
- `herdr pane send-text` has no `--` separator. It types `--` as text.
- Before each write, the server reads `herdr pane process-info --pane <pane>`. `agentPid()` must be in `foreground_processes`.
- `.env` is now `~/.config/mattermost-agents/.env`. While the old file is in this folder, `bun run --cwd` still loads it for the Claude Code server. Pi reads only the new path.
- `hook.sh` has the same exit codes and output as the inline strings in `~/.claude/settings.json`, tested with a stub socket. The hooks in `settings.json` do not call it yet. A hook must pass `"$PPID"` from its own shell.

Method: real Claude Code and real pi in a temporary herdr workspace with `--no-focus`. `--env` gives the `MM_*` values of `dev/fake-mattermost.ts`. Claude Code: `command claude --strict-mcp-config --mcp-config <file> --dangerously-load-development-channels server:mattermost --model haiku`. The project folder must not be the folder of a running session, or the server is passive.

Passed on the fake server, macOS, Claude Code 2.1.319: `/context`, `! echo` in bash mode, a reply with the mention, typing and its stop after Esc, `! echo` after Esc (busy is clear), `/clear`, a reply after `/clear`. Pi: reply with the mention, `/context`, `/quit`, and the same bot after a new start.

Not tested live: a permission dialog (auto mode opened none), and herdr on Linux. Not tested on the production server.

## Plugin for Claude Code and package for pi, 2026-11-09

Claude Code 2.1.321, pi 0.99.1.

- A folder in `~/.claude/skills/` that has `.claude-plugin/plugin.json`, `.mcp.json` or `hooks/hooks.json` loads as the plugin `<name>@skills-dir` in each new session. `claude plugin list` shows it. Do not link the plugin folder there while the plugin is also installed: each hook then runs two times and two servers start.
- Plugin files: `.claude-plugin/plugin.json` with only `name` and `description`, `.mcp.json` with `bun run --cwd ${CLAUDE_PLUGIN_ROOT} --shell=bun --silent start`, and `hooks/hooks.json` with the hooks of `settings.json` and the command `"${CLAUDE_PLUGIN_ROOT}/hook.sh" "$PPID" <mode>`. `SKILL.md` in the root of the plugin loads as its skill. `claude plugin validate` passed.
- With no `version` in `plugin.json`, the version is the commit, so each commit is an update.
- The server name is `plugin:mattermost:mattermost`, the tools are `mcp__plugin_mattermost_mattermost__<tool>` and the tag is `<channel source="plugin:mattermost:mattermost" ...>`.
- The channel flag is `--dangerously-load-development-channels plugin:mattermost@<marketplace>`. For `--plugin-dir` the marketplace is `inline`. No user setting replaces the flag: `allowedChannelPlugins` is a managed setting.
- `"$PPID"` in a plugin hook is the `claude` process, the same as in a hook of `settings.json`.
- `--strict-mcp-config` also stops the MCP server of a plugin. To keep the server `mattermost` of `~/.claude.json` out of a test, use `--settings '{"deniedMcpServers":[{"serverName":"mattermost"}]}'`. It does not stop the plugin server.
- `autoUpdate: true` in the `extraKnownMarketplaces` entry turns on the update of a marketplace. Claude Code has no command for it. The update runs some minutes after the first message, and the new version loads at the next start or after `/reload-plugins`.
- Pi refuses a git source whose path has one part, such as `git@host:repo`. The path must be `<owner>/<repo>` or longer.
- `pi install git:<host>/<owner>/<repo>` clones to `<agent dir>/git/<host>/<owner>/<repo>` and runs `npm install` there. `package-lock.json` and `node_modules` appear in the clone. An update runs `git reset --hard` and `git clean -fdx`.
- Pi only shows `Package Updates Available` at the start. `pi.ts` now runs `pi update <source>` in the background at `session_start` with the reason `startup`, when its folder is in `<agent dir>/git/`. The new commit loads at the next start. The notice of pi still shows at the start that gets the update.

Method for Claude Code: `dev/fake-mattermost.ts` on a free port and a real `claude` in tmux, in a new project folder: `env -u CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF=1 MM_...=... claude --setting-sources project,local --settings '{"deniedMcpServers":[{"serverName":"mattermost"}]}' --plugin-dir <plugin folder> --dangerously-load-development-channels plugin:mattermost@inline --model haiku --debug`. `--setting-sources project,local` keeps the hooks of `~/.claude/settings.json` out.

Passed on the fake server with `--plugin-dir`: `Session started`, an owner post with `eyes`, a tool call and the reply with the mention, a terminal prompt as a quote and its answer, a post `/context`, `Session ended` after `/exit`.

Method for pi: a bare repository in a local folder, and a git config file in `GIT_CONFIG_GLOBAL` with `url.file://<folder>/.insteadOf = https://git.test/`. `PI_CODING_AGENT_DIR` is an empty folder. `pi install git:git.test/owner/repo`.

Passed: the install, the start with the fake provider, an owner post and the reply with the mention. After a push of a new commit, the next start moved the clone to that commit.

## Repository `agent-plugins`, 2026-11-10

The plugin is in `plugins/mattermost` of a repository that is a Claude Code marketplace and a pi package. The root `package.json` has `pi.extensions`. The `package.json` of the plugin has only the dependencies of the server.

Method for Claude Code: `CLAUDE_CONFIG_DIR` is an empty folder, and the git config file in `GIT_CONFIG_GLOBAL` also sends `git@github.com:` to the local folder. The `claude plugin` commands need no login.

- `claude plugin install mattermost --marketplace <owner>/<repo>` adds the marketplace and installs the plugin. It writes `extraKnownMarketplaces` and `enabledPlugins` to `settings.json`. Claude Code clones a GitHub source with SSH first.
- The copy is `plugins/cache/<marketplace>/mattermost/<12 characters of the commit>/`, with `node_modules`.
- The version is the last commit of the repository, also when that commit changed no file of the plugin.
- `claude plugin update` finds a new commit only after `claude plugin marketplace update <marketplace>`.
- Pi with this layout: install, an owner post and the update at the start passed.

Not tested: the automatic update of a marketplace in a session, and a session with the plugin from a marketplace.

## Size of the pi request, 2026-11-10

Pi 1.5.1. Method: the method of "Pi version, 2026-11-09", with two changes. `HOME` is an empty folder, so the lock and the log are not those of the real sessions. A copy of `dev/fake-provider.ts` writes the `context` of `streamSimple` to a file. `pi -e <folder>/pi.ts` loads the extension, one time from the working copy and one time from a copy of the commit f252072.

- `context` has only `messages`. The first message has the role `system`, with `sections` (the system prompt) and `toolsAdded` (the tool declarations).
- `toolsAdded` has 10 tools, 5176 bytes of JSON. The 6 Mattermost tools are 2084 bytes of that.
- `GUIDELINES` are in `sections.rules`, 1286 bytes. The tool descriptions are not in `sections`, so each description is in the request one time.
- Shorter parameter descriptions in `TOOLS`: the 6 Mattermost tools go from 2084 to 1958 bytes.
- All six tools passed after that change, with `TOOL <name> <json>` and two pi sessions: `list_sessions`, `read` with and without parameters, `search`, `send` with a file, `download_attachment`, `reply` with a file.

Not tested: a real model with the shorter descriptions. The fake model does not read them.
