// ---------------------------------------------------------------------------
// learn.ts — auto-learning into memory.md (the "remembers you after restart"
// feature). After every completed exchange, if Learning is ON, the model is
// asked ONE tiny question: are there durable facts about the user in this
// exchange? The facts are deduped and appended to ~/.codezy/memory.md, which
// prompt.ts injects into EVERY future conversation — across app restarts and
// across chats.
//
// Design rules:
// - Fire-and-forget: runs AFTER the reply is streamed and emitted, so the
//   user never waits for it. Failures are swallowed — learning must never
//   break chatting.
// - Cheap: temperature 0, capped output, skips its turn if another chat is
//   still streaming (Ollama queues requests one at a time).
// ---------------------------------------------------------------------------

import { streamChat, type ChatTarget } from './ollama'
import { readMemory, writeMemory } from './store'
import type { ChatMessage } from '../shared/types'

const SYSTEM = `You extract durable facts about the user for a long-term memory file.
Rules:
- Output ONE bullet per durable fact: "- fact"
- Durable = name, tools, preferences, projects, recurring context. Not the current task, not small talk.
- Paraphrase briefly as a plain statement (e.g. "- Name is Kajetan, uses VSCode").
- If there are no durable facts, output exactly NONE.
- At most 3 bullets. No other text.`

const HEADER = '# What CODEZY knows about you'
const MAX_MEMORY_CHARS = 6000

/** Appends deduped facts to memory.md. Returns nothing — best effort only. */
export async function learnFromExchange(
  target: ChatTarget,
  userText: string,
  assistantText: string
): Promise<void> {
  try {
    if (!userText.trim() || !assistantText.trim()) return

    const probe: ChatMessage[] = [
      { id: 'learn-sys', role: 'system', content: SYSTEM, ts: Date.now() },
      {
        id: 'learn-user',
        role: 'user',
        content: `User: ${userText.slice(0, 1500)}\nAssistant: ${assistantText.slice(0, 800)}`,
        ts: Date.now()
      }
    ]

    let acc = ''
    await streamChat(target, probe, {
      signal: new AbortController().signal,
      onDelta: (t) => {
        acc += t
      }
    })

    const facts = acc
      .split('\n')
      .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
      .filter((l) => l.length > 2 && l.length < 200 && !/^none\.?$/i.test(l))
      .slice(0, 3)
    if (!facts.length) return

    const existing = readMemory()
    const known = existing.toLowerCase()
    const fresh = facts.filter((f) => !known.includes(f.toLowerCase().slice(0, 60)))
    if (!fresh.length) return

    const base = existing.trim()
      ? existing.replace(/\s*$/, '\n')
      : `${HEADER}\n\n`
    let next = base + fresh.map((f) => `- ${f}`).join('\n') + '\n'

    // keep the file bounded: trim oldest bullets first, never the header
    if (next.length > MAX_MEMORY_CHARS) {
      const lines = next.split('\n')
      const head = lines[0] === HEADER ? lines.slice(0, 2) : []
      const bullets = lines.filter((l) => l.startsWith('- '))
      let kept = bullets
      while (kept.join('\n').length + head.join('\n').length > MAX_MEMORY_CHARS && kept.length > 1) {
        kept = kept.slice(1)
      }
      next = [...head, ...kept].join('\n') + '\n'
    }

    writeMemory(next)
  } catch {
    /* model busy / offline — memory just doesn't grow this turn */
  }
}
