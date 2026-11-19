import { randomUUID } from 'crypto'
import { join } from 'path'
import { ApiError, type Post } from './mattermost.ts'
import { firstDue, hasClock, isLate, localZone, nextAt, normalizeTriggers, parseJob, readState, rezone, scheduleText, settle, timeText, userZone, writeState, type Job, type JobState, type Schedule, type Step, type StepKind } from './schedule.ts'
import { LOOP_LIMIT, STATE_DIR, Session, agentNotice, attachments, errorText, isNormalPost, preview, safeName, type Follow } from './session.ts'

export const JOB_COMMAND_RE = /^\/(every|job|stop|start|drop)(?=\s|$)/
export const JOB_TICK_MS = 30_000
export const HELP_RE = /^\/help$/
export const JOB_HELP = [
  'Job commands, only in the channel of the session:',
  '- `/every <schedule>` on line 1 and the steps from line 2: makes a job. The model reads the schedule. Examples of line 1: `/every 30 minutes`, `/every day at 14:00, 15:59 and 20`, `/every sunday at 14:00, wed 9am and 21, and every 48 hours`, `/every day 5 times at random times between 9 and 21`.',
  '- `/job`: shows the job.',
  '- `/stop`: stops the job.',
  '- `/start`: starts the job again.',
  '- `/drop`: deletes the job.',
].join('\n')
const QUIET_MS = 300_000
const PROMPT_START_MS = 30_000
const CAUSE_CHARS = 300

export function commandText(command: string, output: string): string {
  if (!output) return `:white_check_mark: \`${command}\``
  return `\`${command}\`\n\`\`\`\n${output.replace(/```/g, "'''")}\n\`\`\``
}

function stepCount(steps: number): string {
  return `${steps} ${steps === 1 ? 'step' : 'steps'}`
}

function jobText(schedule: Schedule, steps: number): string {
  return `${scheduleText(schedule.triggers)}${hasClock(schedule.triggers) ? ` (${schedule.zone})` : ''}, ${stepCount(steps)}`
}

function stepText(step: Step): string {
  return 'command' in step ? `\`${step.command}\`` : preview(step.prompt)
}

// The prompt that asks the model of the session for the schedule. It has line 1 of the job post and not the steps.
export function scheduleRequest(text: string, requestId: string, tool: string): string {
  return [
    'The owner made or changed a job post. Line 1 of the post gives the schedule of the job in free text:',
    '',
    text,
    '',
    `Call the Mattermost tool \`${tool}\` one time with the request_id "${requestId}" and the triggers of this schedule. Do no other work in this turn.`,
    '- An interval is a trigger with `every`: a number and a unit m, h or d. Example: "every 48 hours" is 48h.',
    '- Times of the day are a trigger with `times`, each as HH:MM of 24 hours, in the time zone of the owner. `days` limits the trigger to days of the week. With no `days`, the trigger applies to each day.',
    '- A number with no unit in a list of times is an hour: "14:00 15:59 and 20" is 14:00, 15:59 and 20:00. "9am" is 09:00, and "21pm" is 21:00.',
    '- A number of random times in a day is a trigger with `count`. Do not select the times: the plugin selects new ones each day. If the text gives a window for them, give it as `from` and `to`. Example: "5 times a day at random times between 9 and 21" is count 5, from 09:00, to 21:00. `days` applies as for `times`.',
    '- If the text gives no time, no interval and no number of random times, or if two readings of it give different times, give `error` with the cause and no triggers.',
    '- If the text has a task or an instruction and not only a schedule, give `error` with the cause and no triggers. The steps of the job start on line 2 of the post.',
  ].join('\n')
}

export class Mailbox {
  busy = false
  private waiter: ((text: string) => void) | undefined
  private queue: { text: string; report: boolean }[] = []
  private ownerPosts: (() => void)[] = []
  private fromAgents = 0
  private job: (() => boolean) | undefined
  agentTask = false
  // The posts of the last delivery to the model include a followed post that asks for a report to the owner.
  report = false
  // The start of the session counts as owner input, so the first run of a job after a start waits for the quiet time.
  ownerInputAt = Date.now()

  ownerActive(): void {
    this.ownerInputAt = Date.now()
  }

  userInput(): void {
    this.fromAgents = 0
    this.ownerActive()
  }

  // step gives true when the job has the session: it delivered a step, or a step is in progress. It gives false when the run is complete.
  startJob(step: () => boolean): void {
    this.fromAgents = 0
    this.job = step
    this.flush()
  }

  dropJob(): void {
    this.job = undefined
  }

  turnStarted(): void {
    this.busy = true
  }

  turnFailed(): void {
    this.busy = false
    this.flush()
  }

  wait(event: string, source: string, resolve: (text: string) => void): void {
    this.waiter?.('')
    this.waiter = resolve
    this.report = false
    if (!(event === 'SessionStart' && source === 'compact')) this.busy = false
    this.flush()
  }

  forget(resolve: (text: string) => void): void {
    if (this.waiter === resolve) this.waiter = undefined
  }

  // A followed post has its own limit for each hour, in Session.
  offer(text: string, follow?: { report: boolean }): boolean {
    if (!follow) {
      if (this.fromAgents >= LOOP_LIMIT) return false
      this.fromAgents++
    }
    this.queue.push({ text, report: follow?.report === true })
    this.flush()
    return true
  }

  // Claude Code marks a channel message that arrives during a turn as not from the user, so an owner post waits for the end of the turn.
  ownerPost(deliver: () => void): void {
    this.ownerActive()
    this.ownerPosts.push(deliver)
    this.flush()
  }

  close(): void {
    this.waiter?.('')
    this.waiter = undefined
  }

  private flush(): void {
    if (this.busy) return
    const deliver = this.ownerPosts.shift()
    if (deliver) {
      this.fromAgents = 0
      this.ownerActive()
      this.agentTask = false
      this.busy = true
      deliver()
      return
    }
    if (this.job) {
      this.busy = true
      if (this.job()) {
        this.agentTask = false
        return
      }
      this.busy = false
      this.job = undefined
    }
    if (!this.waiter || !this.queue.length) return
    const resolve = this.waiter
    this.waiter = undefined
    this.busy = true
    this.agentTask = true
    const posts = this.queue.splice(0)
    this.report = posts.some(post => post.report)
    resolve(posts.map(post => post.text).join('\n\n'))
  }
}

// schedule: the run is the request to the model for the schedule, not a run of the steps. It has line 1 of the job post and the number of steps.
export type Run = { id: string; postId: string; steps: Step[]; next: number; inCommand: boolean; schedule?: { text: string; steps: number } }

export type CommandResult = { output: string } | { failure: string }

type JobRead = { job: Job; editAt: number } | { failure: 'gone' | 'incorrect' | 'unreachable'; cause: string }

// The job code that does not depend on the harness. The harness gives the step kinds, the state of the session,
// the run of a command step and the send of a prompt step.
export abstract class JobSession extends Session {
  readonly mailbox = new Mailbox()
  protected commandDone: Promise<void> = Promise.resolve()
  protected startPost: { text: string; postId?: string } | undefined
  protected model: string | undefined
  protected job: JobState | undefined
  private jobPath: string | undefined
  private jobNote = ''
  private jobChecking = false
  // The job that replaced an old job, until the confirmation post tells the owner.
  private replaced: JobState | undefined
  protected run: Run | undefined
  protected promptWait: { runId: string; step: number; timer: ReturnType<typeof setTimeout> } | undefined
  protected quietMs = QUIET_MS
  protected promptStartMs = PROMPT_START_MS
  protected readonly toolPrefix: string = ''

  protected abstract stepKind(line: string): StepKind
  // The session can take the first step of a run. Mailbox.busy and the quiet time are checked apart.
  protected abstract sessionReady(): boolean
  protected abstract turnInProgress(): boolean
  protected abstract executeCommand(command: string): Promise<CommandResult>
  protected abstract deliverPrompt(run: Run, text: string, step: number): Promise<void>

  protected loadJob(): void {
    const path = join(STATE_DIR, 'schedules', `${this.id!.botId}.json`)
    this.jobPath = path
    this.job = readState(path)
    if (this.job) void this.showJobAtStart(this.job)
  }

  // The owner can change the job post while the session is stopped, so the start reads it.
  private async showJobAtStart(state: JobState): Promise<void> {
    const read = await this.readJob(state)
    this.applyRead(state, read)
    if (state !== this.job) return
    const schedule = state.schedule
    const job = 'failure' in read ? undefined : read.job
    const parts = [schedule ? scheduleText(schedule.triggers) : job && `\`${job.text}\``, job && stepCount(job.steps.length)].filter(Boolean)
    const condition = state.paused ? 'Stopped' : schedule ? `Next run: ${timeText(nextAt(schedule), schedule.zone)}` : 'The model reads the schedule'
    this.jobNote = `\n:alarm_clock: Job${parts.length ? `: ${parts.join(', ')}` : ''}. ${condition}`
    this.showStart()
  }

  protected showStart(): void {
    const start = this.startPost
    if (!start) return
    const message = `${start.text}${this.model ? `, model \`${this.model}\`` : ''}${this.jobNote}${this.followLine()}`
    this.enqueue(async () => {
      if (!start.postId) start.postId = (await this.post(this.id!.channelId, message))?.id
      else await this.api!.api('PUT', `/posts/${start.postId}/patch`, { message })
    })
  }

  protected async fromAgent(post: Post, follow?: Follow): Promise<void> {
    const sender = safeName(await this.userName(post.user_id))
    this.track(post)
    this.react(post.id, this.mailbox.offer(agentNotice(sender, post, attachments(post), follow?.purpose), follow) ? 'eyes' : 'no_entry_sign')
  }

  protected say(channelId: string, text: string, rootId = ''): void {
    this.enqueue(() => this.post(channelId, `@${this.id!.ownerUsername} ${text}`, rootId))
  }

  private saveJob(): boolean {
    try {
      writeState(this.jobPath!, this.job)
      return true
    } catch (err) {
      this.log(`the job state was not saved: ${errorText(err)}`)
      return false
    }
  }

  private examine(post: Post): JobRead {
    if (post.delete_at) return { failure: 'gone', cause: 'the job post was deleted' }
    if (post.user_id !== this.config!.ownerId || !isNormalPost(post) || post.channel_id !== this.id!.channelId || post.root_id) {
      return { failure: 'gone', cause: 'the job post is not a post of the owner in the channel of the session' }
    }
    const job = parseJob(post.message, line => this.stepKind(line))
    return typeof job === 'string' ? { failure: 'incorrect', cause: job } : { job, editAt: post.edit_at ?? 0 }
  }

  // The steps have the authority of the owner, so they come from the post of the owner each time, not from the state file.
  private async readJob(state: JobState): Promise<JobRead> {
    try {
      return this.examine(await this.api!.api<Post>('GET', `/posts/${state.postId}`))
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return { failure: 'gone', cause: 'the job post was deleted' }
      return { failure: 'unreachable', cause: errorText(err) }
    }
  }

  // Makes the state agree with the job post. The result is the job when the schedule of its line 1 is known, so a run can use it.
  private applyRead(state: JobState, read: JobRead): Job | undefined {
    if (state !== this.job) return undefined
    if ('failure' in read) {
      if (read.failure === 'gone') this.removeJob(read.cause)
      if (read.failure === 'incorrect' && !state.paused) {
        if (this.run?.schedule) this.cancelRun()
        state.paused = true
        this.saveJob()
        this.say(this.id!.channelId, `:warning: The job post is not correct: ${read.cause}. The job is stopped. Correct the post, then send \`/start\`.`, state.postId)
      }
      return undefined
    }
    // A read that started before an edit can arrive after the event of that edit.
    if (read.editAt < state.editAt) return undefined
    const { job } = read
    const edited = read.editAt !== state.editAt
    state.editAt = read.editAt
    const schedule = state.schedule
    if (schedule?.text !== job.text) {
      if (schedule || edited) {
        state.schedule = undefined
        this.saveJob()
      }
      const asked = this.run?.schedule
      if (asked && asked.text !== job.text) this.cancelRun()
      else if (asked) asked.steps = job.steps.length
      this.askSchedule(state, job)
      return undefined
    }
    if (edited) {
      this.saveJob()
      const text = `The job post changed. The job is now: ${jobText(schedule, job.steps.length)}.`
      this.enqueue(() => this.post(this.id!.channelId, text, state.postId))
    }
    return job
  }

  protected override async onPostEdited(post: Post): Promise<void> {
    const state = this.job
    if (state && post.id === state.postId) this.applyRead(state, this.examine(post))
  }

  // The request is a run with one prompt step. Thus the mailbox holds it during a turn, and a prompt that starts no turn fails as a step does.
  // It does not wait for the quiet time: the owner made or changed the post a moment ago.
  private askSchedule(state: JobState, job: Job): void {
    if (state !== this.job || state.paused || this.run || !this.sessionReady()) return
    const id = randomUUID().slice(0, 8)
    this.delivered.add(state.postId)
    this.run = {
      id,
      postId: state.postId,
      steps: [{ prompt: scheduleRequest(job.text, id, `${this.toolPrefix}schedule`) }],
      next: 0,
      inCommand: false,
      schedule: { text: job.text, steps: job.steps.length },
    }
    this.mailbox.startJob(() => this.nextJobStep())
  }

  private stopSchedule(state: JobState, cause: string): void {
    state.paused = true
    this.saveJob()
    this.say(this.id!.channelId, `:warning: The job is stopped: ${cause}. If line 1 of the job post is not clear, correct it. Then send \`/start\`.`, state.postId)
  }

  private async ownerZone(state: JobState): Promise<string> {
    try {
      return userZone(await this.api!.api('GET', `/users/${this.config!.ownerId}`)) ?? localZone()
    } catch (err) {
      this.log(`Mattermost did not give the time zone of the owner: ${errorText(err)}`)
      return state.schedule?.zone ?? localZone()
    }
  }

  override async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (name === 'schedule' && this.id) return this.setSchedule(args)
    return super.callTool(name, args)
  }

  // Only the open request of the plugin can set the schedule. Thus a turn that did not come from a job post of the owner cannot change the times of the job.
  private async setSchedule(args: Record<string, unknown>): Promise<string> {
    const run = this.run
    const state = this.job
    const asked = run?.schedule
    if (!run || !asked || !state || String(args.request_id ?? '') !== run.id) {
      throw new Error('no request for a schedule with this request_id is open. Only a `/every` post of the owner makes or changes a job.')
    }
    const error = String(args.error ?? '').trim()
    if (error) {
      this.stopSchedule(state, `the model cannot read the schedule \`${asked.text}\`: ${error.slice(0, CAUSE_CHARS).replace(/[.\s]+$/, '')}`)
      return 'The owner got the message. Write no text after this call.'
    }
    const triggers = normalizeTriggers(args.triggers)
    if (typeof triggers === 'string') throw new Error(triggers)
    const zone = await this.ownerZone(state)
    if (run !== this.run || state !== this.job || state.paused) throw new Error('the job changed during the call')
    const schedule: Schedule = { text: asked.text, zone, triggers, due: firstDue(triggers, Date.now(), zone, state.postId) }
    const old = state.schedule
    state.schedule = schedule
    if (!this.saveJob()) {
      state.schedule = old
      this.stopSchedule(state, 'the state file was not written')
      throw new Error('the state file was not written, and the owner got the message')
    }
    const replaced = this.replaced === state ? ' It replaces the old job.' : ''
    this.replaced = undefined
    const text = `:alarm_clock: Job: ${jobText(schedule, asked.steps)}. Next run: ${timeText(nextAt(schedule), zone)}.${replaced}`
    this.enqueue(() => this.post(this.id!.channelId, text, state.postId))
    return 'The schedule is set, and the owner got the confirmation. Write no text after this call.'
  }

  protected async jobCommand(name: string, post: Post): Promise<void> {
    const id = this.id!
    const say = (text: string): void => this.say(post.channel_id, text)
    if (post.channel_id !== id.channelId) return say('A job command works only in the channel of the session.')
    if (name === 'every') return this.makeJob(post)
    if (post.message.trim() !== `/${name}`) return say(`\`/${name}\` takes no text.`)
    const state = this.job
    if (!state) return say('This session has no job.')
    if (name === 'job') return say(await this.jobReport(state))
    if (name === 'drop') {
      this.cancelRun()
      this.job = undefined
      this.saveJob()
      return say(':white_check_mark: The job is deleted.')
    }
    if (name === 'stop') {
      this.cancelRun()
      state.paused = true
      this.saveJob()
      return say(':white_check_mark: The job is stopped. `/start` starts it again.')
    }
    if (!state.paused) return say('The job is not stopped.')
    const read = await this.readJob(state)
    if (state !== this.job) return
    if ('failure' in read) {
      if (read.failure === 'gone') return this.removeJob(read.cause)
      return say(`:warning: The job stays stopped: ${read.failure === 'incorrect' ? `the job post is not correct: ${read.cause}` : `Mattermost did not give the job post: ${read.cause}`}.`)
    }
    if (read.editAt < state.editAt) return say(':warning: The job stays stopped: the job post changed during the command. Send `/start` again.')
    const known = state.schedule?.text === read.job.text ? state.schedule : undefined
    const zone = known ? await this.ownerZone(state) : ''
    if (state !== this.job || !state.paused) return
    const old = { paused: state.paused, editAt: state.editAt, schedule: state.schedule }
    state.paused = false
    state.editAt = read.editAt
    state.schedule = known && { ...known, zone, due: firstDue(known.triggers, Date.now(), zone, state.postId) }
    if (!this.saveJob()) {
      Object.assign(state, old)
      return say(':warning: The job stays stopped: the state file was not written.')
    }
    if (state.schedule) return say(`:white_check_mark: The job runs again: ${jobText(state.schedule, read.job.steps.length)}. Next run: ${timeText(nextAt(state.schedule), zone)}.`)
    say(':white_check_mark: The job runs again when the model has read the schedule.')
    this.askSchedule(state, read.job)
  }

  private makeJob(post: Post): void {
    const id = this.id!
    const job = post.root_id ? 'write `/every` as a new post, not as an answer in a thread' : parseJob(post.message, line => this.stepKind(line))
    if (typeof job === 'string') {
      this.react(post.id, 'x')
      this.say(id.channelId, `:warning: No job was made: ${job}.`, post.root_id || post.id)
      return
    }
    const old = this.job
    this.cancelRun()
    const state: JobState = { postId: post.id, editAt: post.edit_at ?? 0, paused: false }
    this.job = state
    if (!this.saveJob()) {
      this.job = old
      this.react(post.id, 'x')
      this.say(id.channelId, ':warning: No job was made: the state file was not written.', post.id)
      return
    }
    this.replaced = old ? state : undefined
    const free = !this.mailbox.busy
    this.askSchedule(state, job)
    // The confirmation comes only after the model reads the schedule, so the reaction shows that the plugin has the post.
    this.react(post.id, this.run && free ? 'eyes' : 'hourglass_flowing_sand')
  }

  private async jobReport(state: JobState): Promise<string> {
    const run = this.run
    const schedule = state.schedule
    const condition = run?.schedule
      ? 'the model reads the schedule'
      : run
        ? `step ${run.next} of ${run.steps.length} of a run is in progress`
        : state.paused
          ? 'stopped'
          : schedule
            ? 'active'
            : 'the model did not read the schedule'
    const read = await this.readJob(state)
    const last = state.lastRun ? `${timeText(state.lastRun.at, schedule?.zone)}, ${state.lastRun.result}` : 'none'
    const steps = 'failure' in read ? [] : read.job.steps
    return [
      'failure' in read
        ? `:warning: Job: ${read.cause}`
        : `:alarm_clock: Job: ${schedule ? jobText(schedule, steps.length) : `\`${read.job.text}\`, ${stepCount(steps.length)}`}`,
      `State: ${condition}`,
      ...(state.paused || !schedule ? [] : [`Next run: ${timeText(nextAt(schedule), schedule.zone)}`]),
      `Last run: ${last}`,
      ...steps.map((step, i) => `${i + 1}. ${stepText(step)}`),
    ].join('\n')
  }

  private removeJob(cause: string): void {
    this.cancelRun()
    this.job = undefined
    this.saveJob()
    this.say(this.id!.channelId, `:warning: The job is deleted: ${cause}.`)
  }

  private canStartRun(): boolean {
    return this.sessionReady() && !this.mailbox.busy && Date.now() - this.mailbox.ownerInputAt >= this.quietMs
  }

  async jobTick(): Promise<void> {
    const state = this.job
    if (!this.id || !state || state.paused || this.run || this.jobChecking) return
    const known = state.schedule
    if (!known) {
      if (!this.sessionReady()) return
    } else if (Date.now() < nextAt(known) || !(this.canStartRun() || isLate(known, Date.now()))) return
    const id = this.id
    this.jobChecking = true
    try {
      // A session that is not free reads no post. It only gives a new time to a time of the day that is too late.
      let job: Job | undefined
      if (!known || this.canStartRun()) {
        job = this.applyRead(state, await this.readJob(state))
        if (!job) return
      }
      const schedule = state.schedule
      if (state !== this.job || state.paused || !schedule) return
      const zone = hasClock(schedule.triggers) ? await this.ownerZone(state) : schedule.zone
      if (state !== this.job || state.paused || state.schedule !== schedule || this.run) return
      const now = Date.now()
      const moved = zone === schedule.zone ? schedule : { ...schedule, zone, due: rezone(schedule, now, zone, state.postId) }
      const next = settle(moved, now, zone, job !== undefined && this.canStartRun(), state.postId)
      if (!next.run && !next.skipped.length && moved === schedule) return
      state.schedule = { ...moved, due: next.due }
      // The new times are on the disk before the first step, so a crash cannot start one run two times.
      if (!this.saveJob()) {
        state.schedule = schedule
        return
      }
      for (const at of next.skipped) {
        this.enqueue(() => this.post(id.channelId, `The run of ${timeText(at, zone)} did not start: it was more than 1 hour late.`, state.postId))
      }
      if (!next.run || !job) return
      this.delivered.add(state.postId)
      this.run = { id: randomUUID().slice(0, 8), postId: state.postId, steps: job.steps, next: 0, inCommand: false }
      this.mailbox.startJob(() => this.nextJobStep())
    } finally {
      this.jobChecking = false
    }
  }

  // Mailbox calls this when the session is free. Each end of a turn and each end of a command step comes here.
  private nextJobStep(): boolean {
    const run = this.run
    if (!run) return false
    if (run.inCommand) return true
    const step = run.steps[run.next]
    if (!step) {
      this.run = undefined
      const state = this.job
      if (run.schedule) {
        if (state && !state.schedule && !state.paused) this.stopSchedule(state, 'the model did not give the schedule')
      } else if (state) {
        state.lastRun = { at: Date.now(), result: 'ok' }
        this.saveJob()
      }
      return false
    }
    run.next++
    if ('command' in step) this.commandDone = this.runJobCommand(run, step.command)
    else this.sendJobPrompt(run, step.prompt)
    return true
  }

  private async runJobCommand(run: Run, command: string): Promise<void> {
    run.inCommand = true
    const result = await this.executeCommand(command)
    run.inCommand = false
    if ('failure' in result) this.failRun(run, result.failure)
    else this.enqueue(() => this.post(this.id!.channelId, commandText(command, result.output), run.postId))
    this.freeSession()
  }

  private sendJobPrompt(run: Run, text: string): void {
    const step = run.next
    const stop = (cause: string): void => {
      clearTimeout(timer)
      if (this.promptWait?.timer === timer) this.promptWait = undefined
      this.failRun(run, cause)
      this.freeSession()
    }
    const timer = setTimeout(() => stop(`the prompt of step ${step} started no turn in ${Math.round(this.promptStartMs / 1000)} seconds`), this.promptStartMs)
    timer.unref?.()
    this.promptWait = { runId: run.id, step, timer }
    this.deliverPrompt(run, text, step).catch(err => stop(`the prompt of step ${step} was not sent: ${errorText(err)}`))
  }

  // The tag of a job prompt. The harness compares it with the prompt of a new turn.
  protected promptStarted(prompt: string): boolean {
    const wait = this.promptWait
    if (!wait || tagValue(prompt, 'run_id') !== wait.runId || tagValue(prompt, 'step') !== String(wait.step)) return false
    clearTimeout(wait.timer)
    this.promptWait = undefined
    return true
  }

  // A turn from the terminal can start while a step has the session. Then the end of that turn frees the session.
  private freeSession(): void {
    if (!this.turnInProgress()) this.mailbox.turnFailed()
  }

  protected cancelRun(): void {
    this.run = undefined
    this.mailbox.dropJob()
  }

  // One mention for each failure period: a job with a short interval that fails at each run must not mention the owner each time.
  protected failRun(run: Run, cause: string): void {
    if (run !== this.run) return
    this.cancelRun()
    const id = this.id!
    const state = this.job
    if (run.schedule) {
      if (state && !state.schedule && !state.paused) this.stopSchedule(state, `the model did not give the schedule: ${cause}`)
      return
    }
    const first = !state?.lastRun || state.lastRun.result === 'ok'
    if (state) {
      state.lastRun = { at: Date.now(), result: cause }
      this.saveJob()
    }
    this.enqueue(() => this.post(id.channelId, `${first ? `@${id.ownerUsername} ` : ''}:warning: The run of the job stopped: ${cause}. The job stays.`, run.postId))
  }
}

export function tagValue(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]
}
