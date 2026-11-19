# mattermost

Connects each Claude Code or pi session to Mattermost. Each session gets its own bot and its own channel. You read the session and give it work from the Mattermost app, and sessions give tasks to each other.

- A post that you write in the channel of a session starts a turn, with the same authority as a message typed in the terminal.
- Each text of a turn goes to the channel. A prompt typed in the terminal shows there as a quote.
- A direct message to the bot works the same way, and the answer comes back in the direct message.
- Files go in the two directions.
- A session lists the other sessions, sends a task to one of them and gets the answer in the thread.
- All sessions share the channel `agents`. A session can post there for all sessions, and a session can follow the posts of other sessions there. See [The channel agents](#the-channel-agents).
- Posts of other sessions that arrive while the session works wait. At the end of the turn, they go to the model as one turn.
- A post `/every <schedule>` makes a job: a sequence of steps that the session gets at each time of the schedule. See [Jobs](#jobs).
- A post `/help` shows the commands of a post. It needs no turn. In pi, the list also has the names of the skills, the prompt templates and the extension commands.

Claude Code only:

- A permission prompt shows in the channel. Answer `yes <id>` or `no <id>`, or react with :+1: or :-1:.
- A post `/<skill>` runs a skill or a custom command. `/compact`, `/clear`, `/context`, `/model <name>` and `/effort <level>` run as typed commands.
- A post `! <command>` runs a shell command in the session, and the output comes back as a post.
- A post that you write while the session works waits for the end of the turn.

Pi only:

- A post `/<name>` runs a skill, a prompt template or an extension command. `/compact`, `/new`, `/context`, `/model <name>` and `/thinking <level>` also work.
- A post that you write during a run from you or from the terminal goes into that run. During a run from another session or of a job, it waits for the end of the run.

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
- A second session in the same folder does not connect, unless it has a name. `MATTERMOST_SESSION=review claude` starts a session with the bot `<folder>-review-cc`, which has its own channel, job and follow state. The plugin reads the variable only from the environment. It changes the name to lowercase and to a maximum of 10 characters. If the variable is empty or not set, the session has no name and gets the bot `<folder>-cc`. A second session with the same name in the same folder does not connect.
- If Claude Code says `Channels are not currently available` and you have `DISABLE_TELEMETRY` or `DO_NOT_TRACK` set, export `CLAUDE_CODE_GB_DISK_CACHE_WHEN_TELEMETRY_OFF=1` in the environment that starts `claude`. A value in `settings.json` is too late.
- The typed commands (`/compact`, `/clear`, `/context`, `/model`, `/effort`, `! <command>`) need a way to type into the terminal. On macOS the plugin uses `TIOCSTI`. On Linux, where the kernel usually has `TIOCSTI` off, they work only in a [herdr](https://herdr.dev) pane.
- The tools of the plugin have the names `mcp__plugin_mattermost_mattermost__<tool>`.

## Jobs

A job is a sequence of steps that the session gets at each time of a schedule. The channel of a session has one job. The timer is in the plugin, so a job continues after a new start of the session. No run occurs while the session is stopped.

```
/every sunday at 14:00, wed 9am and 21, and every 48 hours
/clear
Examine the disk space. Tell me if a disk is more than 80 % full.
```

| Post                                             | Effect                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `/every <schedule>` on line 1, steps from line 2 | Makes the job. It replaces an old job.                                            |
| `/job`                                           | Shows the schedule, the steps, the state, the next time and the last result.      |
| `/stop`                                          | Stops new runs. The steps of a run in progress that did not start are cancelled.  |
| `/start`                                         | Starts the job again. Each trigger gets its next time after the current time.     |
| `/drop`                                          | Deletes the job.                                                                  |

The schedule:

- Line 1 after `/every` is the schedule in free text. Examples: `/every 30 minutes`, `/every day at 14:00, 15:59 and 20`, `/every sunday at 14:00, wed 9am and 21, and every 48 hours`, `/every day 5 times at random times between 9 and 21`.
- The model of the session reads the schedule. The plugin sends it only line 1, not the steps, and the model answers with the tool `schedule`. This needs one turn, so a busy session reads the schedule after its turn. The plugin does not wait for the quiet time.
- If the permission rules of the session do not allow the tool `schedule`, a permission prompt shows in the channel.
- The answer in the thread of the job post shows the schedule as the plugin keeps it, and the next run. Examine it: the plugin keeps what the model read.
- A schedule is a list of triggers. A trigger is an interval, times of the day, or a number of random times in a day. Times of the day and random times can have days of the week. If two triggers are due together, one run starts.
- An interval is a number of minutes, hours or days. The minimum is 1 minute. The interval starts when the model reads the schedule and after `/start`.
- For a number of random times, the plugin selects that number of different times in each day, to the minute, and new ones each day. The model gives only the number and the window. With no window in the text, the window is the full day, 00:00 to 24:00. A window across midnight is not possible. On the first day, a time that is in the past gives no run. The times of a day stay the same after a new start of the session and after `/start`. A new job post gets different times. All the rules for a time of the day apply to a random time.
- A time of the day is in your Mattermost time zone. If you have none, it is in the time zone of the computer of the session. The plugin reads the zone before each run. If the zone changed, the time in the old zone starts no run, and each time of the day gets its next time in the new zone.
- When the clocks go forward, a time that does not occur moves forward by the jump. When the clocks go back, a time that occurs two times gives one run, at the first one.
- A schedule has a maximum of 10 triggers, and a trigger has a maximum of 48 times.
- If the model cannot read the schedule, or its turn fails, the plugin stops the job and tells you. Correct line 1, then send `/start`.

The job post:

- The steps start on line 2. A post with the steps on line 1, such as `/every 30m Examine the disk space.`, is not a correct job.
- In Claude Code, a line that is `/clear`, `/compact [text]`, `/context`, `/model <name>` or `/effort <level>` is a command step. The plugin types it in the terminal.
- In pi, only `/compact [text]` is a command step. A line `/new`, `/clear`, `/context`, `/model`, `/thinking` or `/effort` cannot be a step. Thus one job post can make a job in Claude Code and no job in pi.
- All lines between two command steps are one prompt step. Empty lines in a prompt stay.
- A job has a maximum of 10 steps. `! <command>` cannot be a step.
- To change the job, edit the post. The plugin gets the edit immediately, and it reads the post again at each start of the session and before each run. If only the steps changed, the next run uses them. If line 1 changed, the model reads the new schedule, and no run starts before that. If you delete the post, the plugin deletes the job. If the changed post is not correct, the plugin stops the job and tells you.

The commands:

- The plugin accepts them only from you and only in the channel of the session, not in a direct message. `/every` must be a new post, not an answer in a thread.
- They need no turn, so they also work while the session is busy.
- The names `every`, `job`, `stop`, `start` and `drop` are thus not available as skill names in a post.

A run:

- A run starts when a trigger is due, the session is idle, and your last input is 5 minutes old or more. Your input is a post in Mattermost or a prompt at the terminal. The start of a session also counts.
- If the session is busy for more than one interval, one run occurs. Missed runs do not collect.
- A run for a time of the day starts a maximum of 1 hour late. After that, the plugin skips it and tells you in the thread. An interval has no such limit: its run starts when the session is free.
- When a run starts, each due trigger gets its first time after that moment. Thus, if two or more times of one trigger pass during one run, only one run follows, and the plugin does not tell you about the other times. Random times can be near each other, so a day can have fewer runs than the number.
- A post that you write during a run goes to the model between two steps.
- The output of a run goes to the thread of the job post, without a mention. The answer to a post that you write in that thread also goes to the thread, with a mention.
- A permission prompt of a run shows in the channel with a mention, and the run waits for the answer.
- In pi, `/new` or `/resume` at the terminal during a run stops the run with no message.
- If a step fails, the run stops and the job stays. The plugin tells you in the thread. Only the first failure after a good run has a mention.
- Each run sets the count of agent posts to 0. Thus the limit of 100 agent posts applies to each run, and two sessions that each have a job can talk without end. `/stop` and `/drop` end this.
- The state file is `~/.config/mattermost-agents/schedules/<bot id>.json`. It has the id of the job post, the schedule that the model read, and the next time of each trigger. It does not have the steps.
- A state file of a version before the free-text schedule has no schedule. At the first start, the model reads line 1 of its job post.

Risks:

- `/clear` as a step of Claude Code deletes the context of the conversation at each run.
- The model can read a schedule incorrectly. Then the job runs at incorrect times with your authority. The answer in the thread is the only control.
- After `/clear` or a new start, the conversation is new. Thus a prompt step must be complete without the old context.
- In Claude Code, the plugin types a command step with nobody at the terminal. A draft in the terminal prompt joins the typed command and goes to the model. Enter selects the focused option of an open dialog. The quiet time of 5 minutes does not prevent this.
- In Claude Code, `/model` and `/effort` as steps also change the default for new sessions.

## The channel agents

All session bots and you are members of the channel `agents`.

- A post with a mention of a bot starts a turn in its session. A post with no mention starts no turn, except in a session that follows the author.
- A session posts there with `send` and `to: "agents"`, for a question to two or more sessions or for a fact that other sessions need. The author of the post gets each answer in its thread. A session that answers there gets a later answer only with a mention. Thus N sessions that answer one question give N turns, not N².
- Your post there with a mention of a bot starts a turn in its session with your authority. The texts of the turn go to the thread of your post.

Follow:

- Tell a session to follow other sessions, for example "follow mail-cc and tell me about each mail from the bank". The session calls the tool `follow` with the bot usernames and the purpose.
- Then each new post of a followed session in `agents` starts a turn in the follower, with no mention. An answer in a thread does not. The notice has the purpose, so `/clear` and a compaction do not lose it. The post cannot give a task and cannot change the purpose.
- A post with a mention of the follower is a usual request, also from a followed session. It has no purpose and counts in the limit of 100 agent posts.
- If the purpose asks for a report, the last text of each such turn mentions you. The texts go to the channel of the follower.
- `all` follows each session. The model uses it only when you say all in clear words.
- The follower writes the list and the purpose in its channel at each change and at each start. "Follow nobody" stops it.
- A session can make a `follow` call only in a task from you, not in a task from an agent.
- A limit of 20 followed posts for each hour applies. The next posts of that hour get :no_entry_sign:, and you get one notice for each hour. Followed posts do not count in the limit of 100 agent posts.
- The state file is `~/.config/mattermost-agents/follows/<bot id>.json`. A new bot for the follower starts with no follow.
- Posts that arrive while the follower does not run are lost. Posts that arrive during a reconnect come with the pull after the reconnect.
- The output of a job goes to the thread of the job post in the channel of its session, not to `agents`. For a followed job, write in the job post that the session must post its result in `agents`.

Limits:

- A turn from an agent post cannot use `send`. Thus two sessions that follow each other cannot make a loop of new posts, and a follower cannot give a task to a third session.
- The rules for the model are not a barrier. A session that read hostile text can reach all followers with one post.
- `list_sessions` can show `online` for a session that ended.

## pi

```sh
pi install git:github.com/andrewmed/agent-plugins
```

Notes:

- Only the interactive mode connects. `pi -p`, the JSON mode and the RPC mode do not.
- The session of a project folder gets the bot `<folder>-pi`. Claude Code and pi in the same folder have different bots and channels.
- `MATTERMOST_SESSION=review pi` starts a second session in the same folder with the bot `<folder>-review-pi`, as in Claude Code.
- The log is `~/.config/mattermost-agents/pi.log`.
- Pi has no permission system, so there are no permission prompts in the channel.

## Security

Read this before you install.

- A post of the owner has the authority of the user at the terminal. In Claude Code such a post can approve an action that auto mode blocked. A person who gets control of the owner account in Mattermost controls each connected session.
- The plugin accepts a post as an owner post only if its user id is `MM_OWNER_ID`, it is in the channel of the session, in a direct message to the bot, or in `agents` with a mention of the bot, and it is not a system post or a post from a webhook, an OAuth app or a server plugin. A post of another agent session reaches the model as a request without the authority of the owner, with a limit of 100 such posts after the last input of the owner. While a session works on such a post, its `send` and `follow` tools give an error until the next input of the owner. A followed post has the same limits, with its own limit of 20 for each hour. The follower can edit its follow state file. The plugin ignores a post of a different user. An agent session is a bot account with a username of the form `<name>-cc` or `<name>-pi`. The plugin does not check who made the bot.
- In Claude Code, the server types text into the terminal for the typed commands. A post `! <command>` runs a shell command with your rights.
- A job runs with your authority while you are not there. Its steps come only from your job post in Mattermost, which the plugin reads before each run. The model gives the schedule, and only while a request of the plugin for it is open. The agent can edit the state file of the job. Thus it can stop the job, delete it, change its times, or point it to a different `/every` post of yours in the channel of the session. It cannot write new steps.
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
