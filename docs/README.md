# CODEZY docs

The manual is one self-contained file: **[`index.html`](index.html)**.

Open it directly in a browser (no server, no build, no network), or publish the `docs/` folder
with GitHub Pages. The page uses a three-column shell:

- **Left rail** — the eight categories, split into Guide and Reference; it follows the section
  you are reading and collapses on narrow screens;
- **Center** — the manual itself, capped at a comfortable reading width;
- **Right rail** — “On this page”, showing the subheadings of the current section only.

The top bar has one search field (`/` or `Ctrl+K`). It searches section titles, subheadings and
the whole error catalogue; choosing a result jumps to the section or opens that error. The
catalogue also keeps its own filter chips and `#errSearch` box. Everything is inline CSS and JS,
with no fonts, images or analytics, and no external requests. It is strict monochrome (dark only) and
works from `file://`.

The eight sections:

- **Start here** — install, pull one model, link a folder, make an edit;
- **Models that work** — tool calling, the recommended table, RAM guidance and `ollama show` checks;
- **Chat, files and agent mode** — classic vs agent, edit blocks, approvals, web search and preview;
- **Terminal** — CLI flags, the agent REPL and doctor;
- **Settings, data and shortcuts** — the controls that matter, MCP, data paths and privacy;
- **Known errors** — all 37, collapsed and searchable, each with a cause and a fix;
- **Short FAQ** and the **3.1.6 changelog**.

## Editing

Edit `index.html` directly. Keep the error catalogue complete: each entry needs an `E##` id, an
area, the exact text, a **Cause** and a **Fix**. Keep the page at eight sections unless there is a
strong reason to add one, and prefer shorter prose over new cards.

When you add or rename a subheading, give it an `id` and add it to the matching `.toc-group` in
the right rail. The left rail must keep its eight links in `.nav` so the category navigation,
scrollspy and the existing docs checks stay in sync.

Check the page at desktop and phone widths (about 1440 px and 430 px). Do not add external
assets — the file must keep working offline and from `file://`.

## Version

Docs version: **3.1.6** (October 2026).
