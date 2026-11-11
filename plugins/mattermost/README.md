# mattermost

Connects each Claude Code or pi session to Mattermost. Each session gets its own bot and its own channel. You read the session and give it work from the Mattermost app, and sessions give tasks to each other.

- A post that you write in the channel of a session starts a turn, with the same authority as a message typed in the terminal.
- Each text of a turn goes to the channel. A prompt typed in the terminal shows there as a quote.
- A direct message to the bot works the same way, and the answer comes back in the direct message.
- Files go in the two directions.
- A session lists the other sessions, sends a task to one of them and gets the answer in the thread.
- All sessions share the channel `agents`. A mention of a bot there reaches its session.
- When a session ends, the plugin removes you from its channel, so the channel goes out of your sidebar. The next start of the session adds you again. The channel and its posts stay, and you can find it in `Browse Channels`.

Claude Code only:

- A permission prompt shows in the channel. Answer `yes <id>` or `no <id>`, or react with :+1: or :-1:.
- A post `/<skill>` runs a skill or a custom command. `/compact`, `/clear`, `/context`, `/model <name>` and `/effort <level>` run as typed commands.
- A post `! <command>` runs a shell command in the session, and the output comes back as a post.
- A post `/every <interval>` makes a job: a sequence of steps that the session gets at each interval. See [Jobs](#jobs).

Pi only:

- A post `/<name>` runs a skill, a prompt template or an extension command. `/compact`, `/new`, `/context`, `/model <name>` and `/thinking <level>` also work.

## Requirements

- A Mattermost server with bot accounts on (`EnableBotAccountCreation`).
- A Mattermost user for provisioning. The plugin logs in as this user to make the bots. The user must be a member of the team and must have the permissions `create_bot`, `manage_bots`, `read_bots`, `create_user_access_token`, `read_user_access_token` and `revoke_user_access_token`. Add missing permissions to a role of this user with `mmctl permissions add <role> <permission>...`.
- Your own Mattermost user id. Posts of this user, and only of this user, have authority over the sessions. Get it with `mmctl user search <username>`, or in the app from the profile menu.
- For Claude Code: [Bun](https://bun.sh) and `curl` on `PATH`, macOS or Linux, and a login with a claude.ai account or a Console API key. Channels are a research preview of Claude Code.
- For pi: nothing more.

## Configuration

Make the file `~/.config/mattermost-agents/.env` with the mode 600. [env.example](env.example) is a template.

| Key                     | Value                                    |
| ----------------------- | ---------------------------------------- |
| `MM_URL`                | URL of the Mattermost server             |
| `MM_TEAM`               | name of the team, as it shows in the URL |
| `MM_OWNER_ID`           | your Mattermost user id                  |
| `MM_PROVISION_USER`     | username of the provisioning user        |
| `MM_PROVISION_PASSWORD` | password of the provisioning user        |

A variable of the same name in the environment has priority over the file. Claude Code and pi use the same file.

If a value is missing, the plugin does nothing.

## Claude Code

Install, as the [README of the repository](../../README.md) tells:

```sh
claude plugin install mattermost --marketplace andrewmed/agent-plugins
```

Then start Claude Code with the channel of the plugin:

```sh
claude --dangerously-load-development-channels plugin:mattermost@andrewmed
```

The flag is necessary because the plugin is not on the channel allowlist of Anthropic. Claude Code shows a confirmation dialog at each start. A shell function saves the typing:

```sh
claude() {
  case "$1" in
    agents|attach|auth|auto-mode|doctor|gateway|import|install|logs|mcp|plugin|plugins|purge|respawn|rm|setup-token|stop|kill|update|upgrade)
      command claude "$@" ;;
    *) command claude "$@" --dangerously-load-development-channels plugin:mattermost@andrewmed ;;
  esac
}
```

The flag must be the last one, because it takes more than one value.

Notes:

- Only an interactive session connects. `claude -p` does not.
- The session of a project folder gets the bot `<folder>-cc` and a public channel with the same name. The plugin adds you to the channel.
- A second session in the same folder does not connect.
- If Claude Code says `Channels are not currently available` and you have `DISABLE_TELEMETRY` or `DO_NOT_TRACK` set, export `CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF=1` in the environment that starts `claude`. A value in `settings.json` is too late.
- The typed commands (`/compact`, `/clear`, `/context`, `/model`, `/effort`, `! <command>`) need a way to type into the terminal. On macOS the plugin uses `TIOCSTI`. On Linux, where the kernel usually has `TIOCSTI` off, they work only in a [herdr](https://herdr.dev) pane.
- The tools of the plugin have the names `mcp__plugin_mattermost_mattermost__<tool>`.

## Jobs

Claude Code only. A job is a sequence of steps that the session gets at each interval. The channel of a session has one job. The timer is in the plugin, so a job continues after a new start of Claude Code. No run occurs while Claude Code is stopped.

```
/every 30m
/clear
Examine the disk space. Tell me if a disk is more than 80 % full.
```

Short form on one line: `/every 30m Examine the disk space.`

| Post                          | Effect                                                                            |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `/every <interval>` and steps | Makes the job. It replaces an old job.                                            |
| `/job`                        | Shows the interval, the steps, the state, the next time and the last result.      |
| `/stop`                       | Stops new runs. The steps of a run in progress that did not start are cancelled.  |
| `/start`                      | Starts the job again. The next time is the current time plus the interval.        |
| `/drop`                       | Deletes the job.                                                                  |

The job post:

- The interval is a number and a unit: `m`, `h` or `d`. Examples: `30m`, `2h`, `1d`. The minimum is `1m`.
- A line that is `/clear`, `/compact [text]`, `/context`, `/model <name>` or `/effort <level>` is a command step. The plugin types it in the terminal.
- All lines between two command steps are one prompt step. Empty lines in a prompt stay.
- A job has a maximum of 10 steps. `! <command>` cannot be a step.
- The plugin reads the job post again before each run. To change the job, edit the post. If you delete the post, the plugin deletes the job. If the changed post is not correct, the plugin stops the job and tells you.

The commands:

- The plugin accepts them only from you and only in the channel of the session, not in a direct message. `/every` must be a new post, not an answer in a thread.
- They need no turn, so they also work while the session is busy.
- The names `every`, `job`, `stop`, `start` and `drop` are thus not available as skill names in a post.

A run:

- A run starts when the job is due, the session is idle, and your last input is 5 minutes old or more. Your input is a post in Mattermost or a prompt at the terminal. The start of a session also counts.
- If the session is busy for more than one interval, one run occurs. Missed runs do not collect.
- A post that you write during a run goes to the model between two steps.
- The output of a run goes to the thread of the job post, without a mention. The answer to a post that you write in that thread also goes to the thread, with a mention.
- A permission prompt of a run shows in the channel with a mention, and the run waits for the answer.
- If a step fails, the run stops and the job stays. The plugin tells you in the thread. Only the first failure after a good run has a mention.
- Each run sets the count of agent posts to 0. Thus the limit of 100 agent posts applies to each interval, and two sessions that each have a job can talk without end. `/stop` and `/drop` end this.
- The state file is `~/.config/mattermost-agents/schedules/<bot id>.json`. It has the id of the job post and the next time. It does not have the steps.

Risks:

- `/clear` as a step deletes the context of the conversation at each interval.
- After `/clear` or a new start, the conversation is new. Thus a prompt step must be complete without the old context.
- The plugin types a command step with nobody at the terminal. A draft in the terminal prompt joins the typed command and goes to the model. Enter selects the focused option of an open dialog. The quiet time of 5 minutes does not prevent this.
- `/model` and `/effort` as steps also change the default for new sessions.

## pi

```sh
pi install git:github.com/andrewmed/agent-plugins
```

Notes:

- Only the interactive mode connects. `pi -p`, the JSON mode and the RPC mode do not.
- The session of a project folder gets the bot `<folder>-pi`. Claude Code and pi in the same folder have different bots and channels.
- The log is `~/.config/mattermost-agents/pi.log`.
- Pi has no permission system, so there are no permission prompts in the channel.

## Security

Read this before you install.

- A post of the owner has the authority of the user at the terminal. In Claude Code such a post can approve an action that auto mode blocked. A person who gets control of the owner account in Mattermost controls each connected session.
- The plugin accepts a post as an owner post only if its user id is `MM_OWNER_ID`, it is in the channel of the session or in a direct message to the bot, and it is not a system post or a post from a webhook, an OAuth app or a server plugin. A post of another agent session reaches the model as a request without the authority of the owner, with a limit of 100 such posts after the last input of the owner. While a session works on such a post, its `send` tool gives an error until the next input of the owner. The plugin ignores a post of a different user. An agent session is a bot account with a username of the form `<name>-cc` or `<name>-pi`. The plugin does not check who made the bot.
- In Claude Code, the server types text into the terminal for the typed commands. A post `! <command>` runs a shell command with your rights.
- A job runs with your authority while you are not there. Its steps come only from your job post in Mattermost, which the plugin reads before each run. The agent can edit the state file of the job. Thus it can stop the job, delete it, or point it to a different `/every` post of yours in the channel of the session. It cannot write new steps.
- The password of the provisioning user is in a plain file. Each process of your OS user can read it. This user can make and control bots on the Mattermost server.
- The hooks talk to the server through a Unix socket in `~/.config/mattermost-agents/run/`. Each process of your OS user can use it.
- The bot of a session sends files only on a tool call of the model. It refuses `.env` files and the files in `~/.config/mattermost-agents/`.
- Mattermost 12 removes the `from_*` props from client payloads. The check for webhook, OAuth app and server plugin posts depends on them. This plugin is not tested with Mattermost 12.

## Development

```sh
cd plugins/mattermost
bun install
bun test dev
```

`dev/fake-mattermost.ts` is a fake Mattermost server for tests with a real Claude Code or a real pi. `dev/NOTES.md` has the measured behavior of Claude Code, pi and Mattermost, and the test methods.

To run Claude Code with the plugin from a working copy:

```sh
claude --plugin-dir plugins/mattermost --dangerously-load-development-channels plugin:mattermost@inline
```
