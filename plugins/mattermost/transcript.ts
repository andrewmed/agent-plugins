export type Entry = { line: string; row: any; start: number }

const INTERRUPT_TEXTS = ['[Request interrupted by user]', '[Request interrupted by user for tool use]']
const BASH_OUTPUT_CHARS = 12_000

export function assistantTexts(jsonl: string): string[] {
  const texts: string[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    const row = JSON.parse(line)
    if (row.type !== 'assistant' || !Array.isArray(row.message?.content)) continue
    for (const block of row.message.content) {
      const text = block.type === 'text' ? String(block.text ?? '').trim() : ''
      if (text) texts.push(text)
    }
  }
  return texts
}

// At Stop the last message can still be missing from the transcript file.
export function withLast(texts: string[], last: string): string[] {
  return !last || texts.at(-1) === last ? texts : [...texts, last]
}

// Claude Code fires no Stop after an interrupt, so this transcript row is the only signal.
export function isInterrupt(row: any): boolean {
  const content = row.message?.content
  return row.type === 'user' && Array.isArray(content) && content.length === 1 && content[0].type === 'text' && INTERRUPT_TEXTS.includes(content[0].text)
}

export function commandOutput(jsonl: string): string | undefined {
  for (const line of jsonl.split('\n')) {
    if (!line.includes('local-command-stdout')) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const content = row.message?.content ?? row.content
    const match = typeof content === 'string' ? /^\s*<local-command-stdout>([\s\S]*)<\/local-command-stdout>\s*$/.exec(content) : null
    if (match) return match[1]!.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trim()
  }
  return undefined
}

export function bashOutput(jsonl: string): string | undefined {
  for (const line of jsonl.split('\n')) {
    if (!line.includes('bash-stdout')) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const content = row.message?.content
    const match = typeof content === 'string' ? /^\s*<bash-stdout>([\s\S]*)<\/bash-stdout><bash-stderr>([\s\S]*)<\/bash-stderr>\s*$/.exec(content) : null
    if (!match) continue
    const text = [match[1]!, match[2]!].map(part => part.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trim()).filter(Boolean).join('\n')
    return text.length > BASH_OUTPUT_CHARS ? `${text.slice(0, BASH_OUTPUT_CHARS)}\n[cut: ${text.length} characters in total]` : text
  }
  return undefined
}

export class TranscriptReader {
  path: string | undefined
  private offset = 0
  private queue: Promise<unknown> = Promise.resolve()

  // The first file starts at its end, because its rows are old. A later file is new, so it starts at its beginning.
  follow(path: string, fromStart = this.path !== undefined): void {
    if (path === this.path) return
    this.offset = fromStart ? 0 : Bun.file(path).size
    this.path = path
  }

  read(visit: (entry: Entry) => void): Promise<void> {
    const run = this.queue.then(() => this.scan(visit))
    this.queue = run.catch(() => {})
    return run
  }

  private async scan(visit: (entry: Entry) => void): Promise<void> {
    const path = this.path
    if (!path) return
    const text = await Bun.file(path).slice(this.offset).text().catch(() => '')
    if (path !== this.path) return
    let position = this.offset
    for (const line of text.split('\n').slice(0, -1)) {
      const start = position
      position += Buffer.byteLength(line) + 1
      // A row of an unknown form must not stop the reader.
      try {
        visit({ line, row: JSON.parse(line), start })
      } catch {}
    }
    this.offset = position
  }
}
