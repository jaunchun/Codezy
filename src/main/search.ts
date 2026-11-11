// ---------------------------------------------------------------------------
// search.ts — the web, for a chat that has no tools.
//
// The whole web core lives in codezy-cli/lib/search.mjs (one core, two shells: the
// terminal's /search, the agent's web_search tool and this app all share
// it). This file is the app's door onto it — the normal chat has no tools,
// so the main process searches FOR the model, reads the promising pages,
// digs out the lines that hold the answer, and hands the model a block it
// can answer from.
// ---------------------------------------------------------------------------

export {
  webSearch,
  looksLikeWebQuery,
  searchQueryFor,
  keyLines,
  answerToken,
  buildWebContext
} from '../../../codezy-cli/lib/search.mjs'
export type { WebContext } from '../../../codezy-cli/lib/search.mjs'
