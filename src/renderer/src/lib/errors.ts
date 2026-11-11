// ---------------------------------------------------------------------------
// errors.ts — raw engine errors are unreadable. "Ollama error 400:
// {\"error\":\"registry.ollama.ai/library/codellama:13b does not support
// tools\"}" is a wall of JSON that tells the user nothing to do. Every error
// toast goes through here: a short WHAT + a short FIX, with the raw text kept
// behind a "Technical details" disclosure.
// ---------------------------------------------------------------------------

export interface HumanError {
  /** One or two plain sentences — the toast headline. */
  text: string
  /** The original error, shown under "Technical details". */
  detail?: string
}

interface Rule {
  re: RegExp
  text: string
  fix?: string
}

const RULES: Rule[] = [
  {
    re: /does not support tools|tool calling.*not supported|tools? (are|is) not supported/i,
    text: 'This model can’t call tools, so agent mode can’t run.',
    fix: 'Pick a model marked “tools” in the model picker — qwen2.5-coder:7b, qwen3:8b or llama3.1:8b. CODEZY falls back to edit blocks for this turn, using your linked files.'
  },
  {
    re: /ECONNREFUSED|connect.*11434|ollama.*(not running|offline)|fetch failed/i,
    text: 'Can’t reach Ollama on 127.0.0.1:11434.',
    fix: 'Start Ollama (the desktop app, or `ollama serve` in a terminal), then send the message again.'
  },
  {
    re: /model .*(not found|does not exist)|pull (the )?model|file does not exist.*model/i,
    text: 'That model isn’t installed.',
    fix: 'Run `ollama pull <model>` — the model picker only lists models Ollama already has.'
  },
  {
    re: /context (length|window|size).*(exceed|too)|exceeds? (the )?(num_ctx|context)|too many tokens/i,
    text: 'The conversation is longer than the model’s context window.',
    fix: 'Start a new chat, or attach fewer / smaller files. Thinking mode and long transcripts use the most room.'
  },
  {
    re: /\b(401|403)\b|unauthorized|invalid api key|incorrect api key/i,
    text: 'The provider rejected the API key.',
    fix: 'Settings → Providers: check the key and the base URL, then save again.'
  },
  {
    re: /Unable to move the cache|Odmowa dostępu|Access is denied|EBUSY|EPERM.*cache/i,
    text: 'Windows locked Electron’s cache — another CODEZY is still running.',
    fix: 'Quit every CODEZY window (and any stale electron.exe in Task Manager), then relaunch.'
  },
  {
    re: /ENOSPC|no space left|disk is full/i,
    text: 'The disk is full.',
    fix: 'Free some space — model files and the Electron cache are the usual culprits.'
  },
  {
    re: /ETIMEDOUT|timed? ?out|timeout/i,
    text: 'The model took too long to respond.',
    fix: 'Try a smaller model, a lower effort, or a shorter question.'
  },
  {
    re: /Unexpected token|JSON\.parse|malformed json|invalid json/i,
    text: 'The engine returned a malformed response.',
    fix: 'Usually a crashed or half-updated Ollama. Restart Ollama and retry.'
  },
  {
    re: /outside the linked folders|path outside/i,
    text: 'That path is outside the folders linked to this chat.',
    fix: 'Link the project folder in the composer (or open the chat from that folder), then retry.'
  },
  {
    re: /EACCES|EPERM|permission denied|permission.*denied/i,
    text: 'Windows denied access to that file or folder.',
    fix: 'Close the file in another app, or choose a folder your user account owns.'
  },
  {
    re: /ENOENT|not recognized as an internal|command not found|spawn .*ENOENT/i,
    text: 'A required program is missing or not on PATH.',
    fix: 'Install Node.js (which provides node and npx) and reopen CODEZY so it picks up PATH.'
  },
  {
    re: /\b404\b.*(model|endpoint|not found)|model.*\b404\b/i,
    text: 'The provider doesn’t recognise that model or endpoint.',
    fix: 'Settings → Providers: verify the base URL and the exact model id.'
  }
]

/** Pull the message out of an Ollama-style `{"error":"…"}` body. */
function unwrap(raw: string): string {
  const m = raw.match(/"error"\s*:\s*"((?:[^"\\]|\\.)*)"/)
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`) as string
    } catch {
      return m[1]
    }
  }
  return raw
}

/**
 * Turn any thrown value into a short headline + a details payload.
 * Recognised errors get a fix; everything else keeps its first line and the
 * full text stays available instead of being truncated in the toast.
 */
export function humanizeError(input: unknown): HumanError {
  const raw = String(input ?? '').trim()
  if (!raw) return { text: 'Something went wrong.', detail: undefined }
  const msg = unwrap(raw)
  for (const rule of RULES) {
    if (!rule.re.test(msg) && !rule.re.test(raw)) continue
    return {
      text: rule.text,
      detail: rule.fix ? `${rule.fix}\n\n${raw}` : raw
    }
  }
  const first = msg.split('\n').find((l) => l.trim()) ?? msg
  if (first.length > 200) {
    return { text: `${first.slice(0, 197)}…`, detail: raw }
  }
  return {
    text: first,
    // Keep the original whenever it carries anything the headline does not -
    // multi-line stack traces, an unwrapped JSON wrapper, extra context.
    detail: raw !== first ? raw : undefined
  }
}
