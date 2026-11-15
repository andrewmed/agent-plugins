import { randomUUID } from 'crypto'
import { join } from 'path'
import { ApiError, type Post } from './mattermost.ts'
import { formatInterval, nextTime, parseJob, readState, writeState, type Job, type JobState, type Step, type StepKind } from './schedule.ts'
import { LOOP_LIMIT, STATE_DIR, Session, errorText, isNormalPost } from './session.ts'

export const JOB_COMMAND_RE = /^\/(every|job|stop|start|drop)(?=\s|$)/
export const JOB_TICK_MS = 30_000
const QUIET_MS = 300_000
const PROMPT_START_MS = 30_000
const STEP_PREVIEW_CHARS = 100

export function commandText(command: string, output: string): string {
  if (!output) return `:white_check_mark: \`${command}\``
  return `\`${command}\`\n\`\`\`\n${output.replace(/```/g, "'''")}\n\`\`\``
}

function timeText(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function jobText(job: Job): string {
  return `each ${formatInterval(job.intervalMs)}, ${job.steps.length} ${job.steps.length === 1 ? 'step' : 'steps'}`
}

function stepText(step: Step): string {
  if ('command' in step) return `\`${step.command}\``
  const line = step.prompt.split('\n')[0]!
  return line.length < step.prompt.length || line.length > STEP_PREVIEW_CHARS ? `${line.slice(0, STEP_PREVIEW_CHARS)}…` : line
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

export type Run = { id: string; postId: string; steps: Step[]; next: number; inCommand: boolean }

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
  protected run: Run | undefined
  protected promptWait: { runId: string; step: number; timer: ReturnType<typeof setTimeout> } | undefined
  protected quietMs = QUIET_MS
  protected promptStartMs = PROMPT_START_MS

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

  private async showJobAtStart(state: JobState): Promise<void> {
    const read = await this.readJob(state)
    const interval = 'failure' in read ? '' : ` each ${formatInterval(read.job.intervalMs)}`
    this.jobNote = `, job${interval}, ${state.paused ? 'stopped' : `next run ${timeText(state.nextAt)}`}`
    this.showStart()
  }

  protected showStart(): void {
    const start = this.startPost
    if (!start) return
    const message = `${start.text}${this.model ? `, model \`${this.model}\`` : ''}${this.jobNote}`
    this.enqueue(async () => {
      if (!start.postId) start.postId = (await this.post(this.id!.channelId, message))?.id
      else await this.api!.api('PUT', `/posts/${start.postId}/patch`, { message })
    })
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

  // The steps have the authority of the owner, so they come from the post of the owner each time, not from the state file.
  private async readJob(state: JobState): Promise<JobRead> {
    const id = this.id!
    let post: Post
    try {
      post = await this.api!.api<Post>('GET', `/posts/${state.postId}`)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return { failure: 'gone', cause: 'the job post was deleted' }
      return { failure: 'unreachable', cause: errorText(err) }
    }
    if (post.delete_at) return { failure: 'gone', cause: 'the job post was deleted' }
    if (post.user_id !== this.config!.ownerId || !isNormalPost(post) || post.channel_id !== id.channelId || post.root_id) {
      return { failure: 'gone', cause: 'the job post is not a post of the owner in the channel of the session' }
    }
    const job = parseJob(post.message, line => this.stepKind(line))
    return typeof job === 'string' ? { failure: 'incorrect', cause: job } : { job, editAt: post.edit_at ?? 0 }
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
    const old = { ...state }
    state.paused = false
    state.editAt = read.editAt
    state.nextAt = Date.now() + read.job.intervalMs
    if (!this.saveJob()) {
      Object.assign(state, old)
      return say(':warning: The job stays stopped: the state file was not written.')
    }
    say(`:white_check_mark: The job runs again: ${jobText(read.job)}. Next run: ${timeText(state.nextAt)}.`)
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
    this.job = { postId: post.id, editAt: post.edit_at ?? 0, nextAt: Date.now() + job.intervalMs, paused: false }
    if (!this.saveJob()) {
      this.job = old
      this.react(post.id, 'x')
      this.say(id.channelId, ':warning: No job was made: the state file was not written.', post.id)
      return
    }
    const next = timeText(this.job.nextAt)
    this.enqueue(() => this.post(id.channelId, `:alarm_clock: Job: ${jobText(job)}. Next run: ${next}.${old ? ' It replaces the old job.' : ''}`, post.id))
  }

  private async jobReport(state: JobState): Promise<string> {
    const run = this.run
    const condition = run ? `step ${run.next} of ${run.steps.length} of a run is in progress` : state.paused ? 'stopped' : 'active'
    const read = await this.readJob(state)
    const last = state.lastRun ? `${timeText(state.lastRun.at)}, ${state.lastRun.result}` : 'none'
    return [
      'failure' in read ? `:warning: Job: ${read.cause}` : `:alarm_clock: Job: ${jobText(read.job)}`,
      `State: ${condition}`,
      ...(state.paused ? [] : [`Next run: ${timeText(state.nextAt)}`]),
      `Last run: ${last}`,
      ...('failure' in read ? [] : read.job.steps.map((step, i) => `${i + 1}. ${stepText(step)}`)),
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
    if (!this.id || !state || state.paused || this.run || this.jobChecking || Date.now() < state.nextAt || !this.canStartRun()) return
    const id = this.id
    this.jobChecking = true
    try {
      const read = await this.readJob(state)
      if (state !== this.job || state.paused) return
      if ('failure' in read) {
        if (read.failure === 'gone') this.removeJob(read.cause)
        if (read.failure === 'incorrect') {
          state.paused = true
          this.saveJob()
          this.say(id.channelId, `:warning: The job post changed and is not correct: ${read.cause}. The job is stopped. Correct the post, then send \`/start\`.`, state.postId)
        }
        return
      }
      if (read.editAt !== state.editAt) {
        state.editAt = read.editAt
        this.saveJob()
        this.enqueue(() => this.post(id.channelId, `The job post changed. The job is now: ${jobText(read.job)}.`, state.postId))
      }
      if (!this.canStartRun()) return
      // The new time is on the disk before the first step, so a crash cannot start one run two times.
      state.nextAt = nextTime(state.nextAt, read.job.intervalMs, Date.now())
      if (!this.saveJob()) return
      this.delivered.add(state.postId)
      this.run = { id: randomUUID().slice(0, 8), postId: state.postId, steps: read.job.steps, next: 0, inCommand: false }
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
      if (this.job) {
        this.job.lastRun = { at: Date.now(), result: 'ok' }
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
