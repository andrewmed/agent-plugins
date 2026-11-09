import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const textOf = (content: any): string =>
  typeof content === 'string' ? content : (content ?? []).filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n')

const stripChannel = (text: string): string => text.replace(/^<channel [^>]*>\n/, '').replace(/\n<\/channel>$/, '')

export default function (pi: ExtensionAPI): void {
  pi.registerProvider('fake', {
    baseUrl: 'http://127.0.0.1:1',
    apiKey: 'fake',
    api: 'fake-api',
    models: [
      { id: 'echo', name: 'echo', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 },
    ],
    streamSimple(model: any, context: any) {
      const stream = createAssistantMessageEventStream()
      const last = context.messages.at(-1)
      const text = stripChannel(textOf(last?.content))
      const output: any = {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop',
        timestamp: Date.now(),
      }
      const tool = /TOOL (\S+) (\{.*\})/.exec(text)
      void (async () => {
        stream.push({ type: 'start', partial: output })
        if (text.includes('SLOW')) await new Promise(resolve => setTimeout(resolve, 3000))
        if (last?.role !== 'toolResult' && text.includes('FAIL')) {
          output.stopReason = 'error'
          output.errorMessage = 'scripted failure'
          stream.push({ type: 'error', reason: 'error', error: output })
          stream.end()
          return
        }
        if (last?.role !== 'toolResult' && tool) {
          output.content = [{ type: 'toolCall', id: 'call-1', name: tool[1], arguments: JSON.parse(tool[2]!) }]
          output.stopReason = 'toolUse'
        } else {
          output.content = [{ type: 'text', text: last?.role === 'toolResult' ? `tool said: ${text}` : `echo: ${text}` }]
        }
        stream.push({ type: 'done', reason: output.stopReason, message: output })
        stream.end()
      })()
      return stream
    },
  } as any)
}
