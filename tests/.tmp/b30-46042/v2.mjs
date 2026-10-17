// src/main/v2.ts
import { spawnSync as spawnSync2 } from "node:child_process";

// cli/lib/harness.mjs
import fs from "node:fs";
import path from "node:path";
import { exec, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";

// cli/lib/search.mjs
var ENDPOINT = "https://lite.duckduckgo.com/lite/";
var MAX_RESULTS = 8;
function text(html) {
  return html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
function cleanUrl(href) {
  try {
    const abs = new URL(href, ENDPOINT);
    const uddg = abs.searchParams.get("uddg");
    const url = uddg ?? abs.toString();
    if (!/^https?:\/\//.test(url)) return null;
    if (/(^|\.)(duckduckgo\.com)$/i.test(new URL(url).hostname)) return null;
    return url;
  } catch {
    return null;
  }
}
function parseLite(html) {
  const hits = [];
  const seen = /* @__PURE__ */ new Set();
  const linkRe = /<a[^>]*href=(["'])([^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const url = cleanUrl(m[2]);
    const title = text(m[3]);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    hits.push({ title, url, snippet: "" });
    if (hits.length >= MAX_RESULTS) break;
  }
  const snipRe = /<td[^>]*class=['"][^'"]*result-snippet[^'"]*['"][^>]*>([\s\S]*?)<\/td>/gi;
  const snippets = [];
  while ((m = snipRe.exec(html)) !== null) {
    const s = text(m[1]);
    if (s) snippets.push(s);
  }
  hits.forEach((h, i) => {
    if (snippets[i]) h.snippet = snippets[i];
  });
  return hits;
}
async function webSearch(query) {
  const q = query.trim().slice(0, 300);
  if (!q) return [];
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) CODEZY/1.0"
    },
    body: new URLSearchParams({ q }).toString(),
    signal: AbortSignal.timeout(1e4)
  });
  if (!res.ok) throw new Error(`DuckDuckGo responded ${res.status}`);
  return parseLite(await res.text());
}

// cli/lib/harness.mjs
var execP = promisify(exec);
var DEFAULT_MAX_ITER = 8;
var DANGEROUS_TOOLS = /* @__PURE__ */ new Set(["write_file", "edit_file", "run_command"]);
var PARALLEL_SAFE = /* @__PURE__ */ new Set(["list_dir", "read_file", "grep_search", "glob", "web_search", "web_fetch"]);
var DELEGATE_TOOL = {
  type: "function",
  function: {
    name: "delegate",
    description: "Hand a self-contained sub-task to a SUB-AGENT with its own fresh context: research something broad, summarize a folder, or implement a piece that would need many steps and would clutter this conversation. Returns the sub-agent\u2019s final answer. Its edits and commands still require user approval. Use sparingly \u2014 one focused brief per call.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "A complete brief: what to do, which folders/files matter, and what to return."
        }
      },
      required: ["task"]
    }
  }
};
var TOOLS = [
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List the files and folders inside a directory of the linked workspace.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Folder to list, relative to the workspace root. Defaults to the root." }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file from the linked workspace and return its content. Large files come back as head+tail \u2014 pass offset/limit (1-based lines) to page through the rest.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File to read, relative to the workspace root." },
          offset: { type: "number", description: "First line to read (1-based). Optional." },
          limit: { type: "number", description: "How many lines to return from offset. Optional, default 400." }
        },
        required: ["path"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a text file in the linked workspace. Requires explicit user approval. Use this whenever the user asks to save, create, or write a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File to write, relative to the workspace root." },
          content: { type: "string", description: "The complete new content of the file." }
        },
        required: ["path", "content"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "grep_search",
      description: "Search files in the workspace with a regular expression. Returns file:line: matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regular expression to search for." },
          path: { type: "string", description: "Folder to search, relative to the workspace root. Defaults to the root." }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command in the workspace and return its output. Requires explicit user approval. Destructive commands are rejected.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute." },
          background: {
            type: "boolean",
            description: "Start the command and return immediately with a task id \u2014 for servers, builds and watchers. Poll task_status for output. Default false."
          }
        },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web (DuckDuckGo) and return titles, URLs and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a URL and return its text \u2014 HTML is stripped to readable prose. Use it after web_search to open the promising links (docs, releases, issues). Read-only, http(s) only.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The http(s) URL to fetch." },
          maxChars: { type: "number", description: "Cap on returned characters. Optional, default 20000." }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "todo_write",
      description: "Save the current checklist for this task \u2014 the complete list, replacing the previous one. Call it when you make a plan and update it as each item finishes; the user watches the list, and it keeps long runs coherent.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description: "Every step, in order.",
            items: {
              type: "object",
              properties: {
                text: { type: "string", description: "One concrete step." },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "done"],
                  description: "State of this step."
                }
              },
              required: ["text", "status"]
            }
          }
        },
        required: ["items"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace text inside a file: pass the exact `old` text and the exact `new` text. The old text must appear exactly once unless replace_all is true. Requires explicit user approval. Prefer this over write_file when changing an existing file \u2014 it is cheaper and cannot lose content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File to edit, relative to the workspace root." },
          old: { type: "string", description: "The exact text to find \u2014 copy it verbatim, indentation included." },
          new: { type: "string", description: "The replacement text. Use an empty string to delete the old text." },
          replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one. Default false." }
        },
        required: ["path", "old", "new"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: 'Find files by name pattern and return their paths, sorted. ** crosses folders, * stays inside one segment: "**/*.ts", "src/**", "*.md". Skips node_modules, .git and other build folders.',
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "The glob pattern to match file paths against." },
          path: { type: "string", description: "Folder to search in, relative to the workspace root. Defaults to the root." }
        },
        required: ["pattern"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "task_status",
      description: 'Check on background tasks started with run_command {"background": true}. Pass an id for one task (add "kill": true to stop it), or omit the id to list every task.',
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "Task id. Optional \u2014 omit to list all tasks." },
          kill: { type: "boolean", description: "Stop the task if it is still running. Default false." }
        },
        required: []
      }
    }
  }
];
function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return (rel === "" || !rel.startsWith("..")) && !path.isAbsolute(rel);
}
function resolveInRoots(roots, raw) {
  const p = String(raw ?? "").trim();
  if (!p) throw new Error("empty path");
  if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\")) {
    const abs = path.normalize(p);
    if (roots.some((r) => inside(r, abs))) return abs;
    throw new Error(`path outside the linked folders: ${raw}`);
  }
  for (const root of roots) {
    const candidate = path.resolve(root, p);
    if (inside(root, candidate)) return candidate;
  }
  throw new Error(`path outside the linked folders: ${raw}`);
}
var DENY_PATTERNS = [
  /\bmkfs\b/i,
  /\brm\s+-rf\b/i,
  /\brm\s+-fr\b/i,
  /\bdel\b\s+\/[fsq]/i,
  /\bformat\s+[a-zA-Z]:/i,
  /\bshutdown\b/i,
  /\bdiskpart\b/i,
  /\breg\s+delete\b/i,
  /curl[^\n|]*\|\s*(ba)?sh/i,
  /powershell[^\n]*\s-enc/i,
  /Remove-Item\b[^\n]*-Recurse[^\n]*-Force/i,
  />\s*\/dev\/sd/i
];
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", "dist", "build", "venv", ".venv", "__pycache__", ".cache"]);
function globToRegExp(pattern) {
  let out = "";
  const src = String(pattern);
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "*") {
      if (src[i + 1] === "*") {
        out += ".*";
        i++;
        if (src[i + 1] === "/") i++;
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (c === "{") out += "(?:";
    else if (c === "}") out += ")";
    else if (c === ",") out += "|";
    else if ("\\^$.|+()[]{}".includes(c)) out += "\\" + c;
    else out += c;
  }
  return new RegExp(`^${out}$`);
}
function makeRegistry({ roots = [], cwd, execTimeoutMs = 15e3, allowMutations = true } = {}) {
  if (!roots.length) throw new Error("makeRegistry: at least one root folder required");
  const workCwd = cwd ?? roots[0];
  const refuse = (name) => allowMutations ? null : `plan mode: ${name} is disabled \u2014 present the plan first; the user switches to build/auto when they want changes`;
  const state = { todos: [], tasks: /* @__PURE__ */ new Map(), nextTaskId: 1 };
  const list_dir = {
    check: (a) => {
      try {
        resolveInRoots(roots, a.path ?? ".");
        return null;
      } catch (e) {
        return e.message;
      }
    },
    run: async (a) => {
      const dir = resolveInRoots(roots, a.path ?? ".");
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      if (!entries.length) return "(empty folder)";
      entries.sort(
        (x, y) => x.isDirectory() === y.isDirectory() ? x.name.localeCompare(y.name, "en", { numeric: true }) : x.isDirectory() ? -1 : 1
      );
      return entries.slice(0, 300).map((e) => e.isDirectory() ? `${e.name}/` : e.name).join("\n");
    }
  };
  const read_file = {
    check: (a) => {
      if (!a.path) return "path is required";
      try {
        resolveInRoots(roots, a.path);
        return null;
      } catch (e) {
        return e.message;
      }
    },
    run: async (a) => {
      const file = resolveInRoots(roots, a.path);
      const text2 = fs.readFileSync(file, "utf8");
      const lines = text2.split("\n");
      const total = lines.length;
      if (a.offset != null || a.limit != null) {
        const offset = Math.max(1, Math.floor(Number(a.offset) || 1));
        const limit = Math.max(1, Math.min(2e3, Math.floor(Number(a.limit) || 400)));
        if (offset > total) return `(file has only ${total} lines)`;
        let chunk = lines.slice(offset - 1, offset - 1 + limit).join("\n");
        if (chunk.length > 4e4) chunk = chunk.slice(0, 4e4) + "\n\u2026[slice too large \u2014 narrow offset/limit]";
        const last = Math.min(total, offset + limit - 1);
        const more = last < total;
        if (offset === 1 && !more) return chunk;
        return `lines ${offset}\u2013${last} of ${total}${more ? ` (more after \u2014 next offset=${last + 1})` : ""}

${chunk}`;
      }
      if (text2.length <= 3e4) return text2;
      const head = lines.slice(0, 900).join("\n").slice(0, 24e3);
      const tail = lines.slice(-250).join("\n").slice(-6e3);
      return `${head}
\u2026[file has ${total} lines / ${text2.length} chars \u2014 showing head+tail, re-read with offset/limit to page]\u2026
${tail}
\u2026[truncated]`;
    }
  };
  const write_file = {
    check: (a) => {
      if (!a.path) return "path is required";
      if (typeof a.content !== "string") return "content must be a string";
      const gated = refuse("write_file");
      if (gated) return gated;
      try {
        resolveInRoots(roots, a.path);
        return null;
      } catch (e) {
        return e.message;
      }
    },
    run: async (a) => {
      const file = resolveInRoots(roots, a.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, a.content, "utf8");
      return `wrote ${Buffer.byteLength(a.content, "utf8")} bytes to ${path.basename(file)}`;
    }
  };
  const edit_file = {
    check: (a) => {
      if (!a.path) return "path is required";
      if (typeof a.old !== "string" || !a.old.length) return "old text is required \u2014 the exact text to replace";
      if (typeof a.new !== "string") return 'new must be a string (use "" to delete the old text)';
      if (a.old === a.new) return "old and new are identical \u2014 nothing to do";
      const gated = refuse("edit_file");
      if (gated) return gated;
      try {
        resolveInRoots(roots, a.path);
        return null;
      } catch (e) {
        return e.message;
      }
    },
    run: async (a) => {
      const file = resolveInRoots(roots, a.path);
      if (!fs.existsSync(file)) return `ERROR: ${a.path} does not exist \u2014 use write_file to create it`;
      const before = fs.readFileSync(file, "utf8");
      if (Buffer.byteLength(before, "utf8") > 2e6) return "ERROR: file too large to edit safely \u2014 use write_file if you really must";
      const count = before.split(a.old).length - 1;
      if (count === 0) {
        return `ERROR: the old text was not found in ${path.basename(file)} \u2014 copy it verbatim (indentation included) or read the file again first`;
      }
      if (count > 1 && !a.replace_all) {
        return `ERROR: the old text appears ${count} times \u2014 add more surrounding lines to make it unique, or pass replace_all`;
      }
      const after = a.replace_all ? before.split(a.old).join(a.new) : before.replace(a.old, a.new);
      fs.writeFileSync(file, after, "utf8");
      const n = a.replace_all ? count : 1;
      return `edited ${path.basename(file)}: ${n} replacement${n === 1 ? "" : "s"} (${Buffer.byteLength(before, "utf8")} \u2192 ${Buffer.byteLength(after, "utf8")} bytes)`;
    }
  };
  const glob = {
    check: (a) => {
      if (!a.pattern) return "pattern is required";
      try {
        resolveInRoots(roots, a.path ?? ".");
        return null;
      } catch (e) {
        return e.message;
      }
    },
    run: async (a) => {
      const start = resolveInRoots(roots, a.path ?? ".");
      const re = globToRegExp(a.pattern);
      const hits = [];
      let visited = 0;
      const walk = (dir) => {
        if (hits.length >= 200 || visited >= 2e4) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (hits.length >= 200 || visited >= 2e4) return;
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(abs);
          } else {
            visited++;
            const rel = path.relative(start, abs).split(path.sep).join("/");
            if (re.test(rel)) hits.push(rel);
          }
        }
      };
      walk(start);
      hits.sort();
      if (!hits.length) return `no files match ${a.pattern}`;
      return hits.join("\n") + (hits.length >= 200 ? "\n\u2026[capped at 200 \u2014 narrow the pattern]" : "");
    }
  };
  const grep_search = {
    check: (a) => {
      if (!a.pattern) return "pattern is required";
      try {
        new RegExp(a.pattern);
      } catch (e) {
        return `invalid regex: ${e.message}`;
      }
      try {
        resolveInRoots(roots, a.path ?? ".");
        return null;
      } catch (e) {
        return e.message;
      }
    },
    run: async (a) => {
      const start = resolveInRoots(roots, a.path ?? ".");
      const re = new RegExp(a.pattern);
      const hits = [];
      let files = 0;
      const walk = (dir) => {
        if (hits.length >= 100 || files >= 500) return;
        let entries;
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (hits.length >= 100 || files >= 500) return;
          if (e.isDirectory()) {
            if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
          } else {
            files++;
            try {
              const stat = fs.statSync(path.join(dir, e.name));
              if (stat.size > 1e6) continue;
              const lines = fs.readFileSync(path.join(dir, e.name), "utf8").split("\n");
              lines.forEach((line, i) => {
                if (hits.length < 100 && re.test(line)) {
                  hits.push(`${path.relative(start, path.join(dir, e.name))}:${i + 1}: ${line.trim().slice(0, 200)}`);
                }
              });
            } catch {
            }
          }
        }
      };
      walk(start);
      return hits.length ? hits.join("\n") : `no matches for /${a.pattern}/`;
    }
  };
  const killTask = (t) => {
    if (!t.running || !t.proc?.pid) return;
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(t.proc.pid), "/T", "/F"], { windowsHide: true });
      } else t.proc.kill("SIGTERM");
    } catch {
    }
    try {
      t.proc.kill();
    } catch {
    }
  };
  const startTask = (command) => {
    while (state.tasks.size >= 20) {
      const victim = [...state.tasks.values()].find((t) => !t.running) ?? [...state.tasks.values()][0];
      killTask(victim);
      state.tasks.delete(victim.id);
    }
    const id = state.nextTaskId++;
    const task = { id, command, running: true, code: null, out: "", started: Date.now(), proc: null };
    let child;
    try {
      child = spawn(command, { shell: true, cwd: workCwd, windowsHide: true });
    } catch (e) {
      return `ERROR: could not start task: ${e?.message ?? e}`;
    }
    task.proc = child;
    const keep = (chunk) => {
      task.out += String(chunk);
      if (task.out.length > 2e5) task.out = task.out.slice(-2e5);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("close", (code) => {
      task.running = false;
      task.code = code;
    });
    child.on("error", (e) => {
      task.running = false;
      task.code = "error";
      keep(`
${e?.message ?? e}`);
    });
    state.tasks.set(id, task);
    return `started background task #${id}: ${command.slice(0, 120)} \u2014 ask task_status {"id": ${id}} for progress`;
  };
  const run_command = {
    check: (a) => {
      if (!a.command) return "command is required";
      if (a.command.length > 500) return "command too long";
      for (const re of DENY_PATTERNS) {
        if (re.test(a.command)) return `destructive command rejected: matches ${re}`;
      }
      const gated = refuse("run_command");
      if (gated) return gated;
      return null;
    },
    run: async (a) => {
      if (a.background) return startTask(String(a.command));
      try {
        const { stdout, stderr } = await execP(a.command, {
          cwd: workCwd,
          timeout: execTimeoutMs,
          maxBuffer: 1024 * 1024,
          windowsHide: true
        });
        const out = [stdout, stderr].filter(Boolean).join("\n").trim();
        return (out || "(no output)").slice(0, 8e3);
      } catch (e) {
        const out = [e.stdout, e.stderr].filter(Boolean).join("\n").trim();
        return `ERROR (exit ${e.code ?? "?"}): ${(out || e.message).slice(0, 4e3)}`;
      }
    }
  };
  const task_status = {
    state,
    check: (a) => a && typeof a === "object" ? null : "arguments must be an object \u2014 {} lists every task",
    run: async (a) => {
      if (a.id == null) {
        const all = [...state.tasks.values()];
        if (!all.length) return "no background tasks";
        return all.map((t2) => `#${t2.id} ${t2.running ? "running" : `exit ${t2.code}`}: ${t2.command.slice(0, 100)}`).join("\n");
      }
      const t = state.tasks.get(Number(a.id));
      if (!t) return `no task #${a.id} \u2014 known tasks: ${[...state.tasks.keys()].join(", ") || "(none)"}`;
      if (a.kill && t.running) killTask(t);
      const tail = t.out.length > 4e3 ? `\u2026${t.out.slice(-4e3)}` : t.out;
      return `task #${t.id} ${t.running ? "running" : `exited with code ${t.code}`}${a.kill && t.running ? " (kill requested)" : ""}
${tail || "(no output yet)"}`;
    }
  };
  function stripHtml(html) {
    return String(html).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ").replace(/<\/(p|div|section|article|li|h[1-6]|tr|blockquote|pre|table|ul|ol|figcaption)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/[ \t ]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  const web_search = {
    check: (a) => a.query && String(a.query).trim() ? null : "query is required",
    run: async (a) => {
      const results = await webSearch(String(a.query));
      if (!results?.length) return "no results";
      return results.slice(0, 6).map((r) => `${r.title}
${r.url}${r.snippet ? `
${r.snippet}` : ""}`).join("\n\n");
    }
  };
  const web_fetch = {
    check: (a) => {
      if (!a || !a.url) return "url is required";
      if (!/^https?:\/\//i.test(String(a.url))) return "only http(s) urls are allowed";
      return null;
    },
    run: async (a) => {
      const res = await fetch(String(a.url), {
        redirect: "follow",
        signal: AbortSignal.timeout(15e3),
        headers: { "user-agent": "CODEZY agent (web_fetch)" }
      });
      if (!res.ok) return `fetch failed: HTTP ${res.status} ${res.statusText}`;
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      const text2 = await res.text();
      const cap2 = Math.min(Math.max(Number(a.maxChars) || 2e4, 1e3), 1e5);
      const out = type.includes("html") || type.includes("xml") ? stripHtml(text2) : text2.trim();
      if (!out) return "(the page had no readable text)";
      return out.length > cap2 ? `${out.slice(0, cap2)}
\u2026[truncated]` : out;
    }
  };
  const todo_write = {
    check: (a) => {
      if (!Array.isArray(a.items)) return "items must be an array of {text, status}";
      if (!a.items.length) return "items must not be empty";
      for (const it of a.items) {
        if (!it || typeof it.text !== "string" || !it.text.trim()) return "every item needs text";
        if (!["pending", "in_progress", "done"].includes(it.status))
          return `bad status "${it.status}" \u2014 use pending, in_progress or done`;
      }
      return null;
    },
    run: async (a) => {
      state.todos.length = 0;
      for (const it of a.items) state.todos.push({ text: String(it.text).slice(0, 300), status: it.status });
      const done = state.todos.filter((i) => i.status === "done").length;
      return `saved ${state.todos.length} todos (${done} done):
` + state.todos.map((it, i) => `${i + 1}. [${it.status === "done" ? "x" : it.status === "in_progress" ? ">" : " "}] ${it.text}`).join("\n");
    },
    state
  };
  return {
    list_dir,
    read_file,
    write_file,
    edit_file,
    glob,
    grep_search,
    run_command,
    task_status,
    web_search,
    web_fetch,
    todo_write
  };
}
function runHooks(hooks, phase, name, args) {
  const list = hooks?.[phase];
  if (!hooks || !Array.isArray(list) || !list.length) return null;
  for (const h of list) {
    const tools = Array.isArray(h?.tools) ? h.tools : ["*"];
    if (!tools.includes("*") && !tools.includes(name)) continue;
    const cmd = String(h?.command ?? "").trim();
    if (!cmd) continue;
    let r;
    try {
      r = spawnSync(cmd, {
        shell: true,
        cwd: hooks.cwd || process.cwd(),
        encoding: "utf8",
        timeout: Number(h.timeout_ms) || 1e4,
        windowsHide: true,
        input: JSON.stringify({ tool: name, args })
      });
    } catch (e) {
      return `hook "${cmd}" failed to run: ${e?.message ?? e}`;
    }
    if (r.status === null || r.status === void 0) return `hook "${cmd}" timed out or did not start`;
    if (r.status !== 0) {
      return String(r.stderr ?? "").trim().slice(0, 400) || `hook "${cmd}" exited with code ${r.status}`;
    }
  }
  return null;
}
function isTransient(e) {
  if (e?.name === "AbortError" || e?.code === "ABORT_ERR") return false;
  const m = String(e?.message ?? e ?? "");
  if (/(ECONNREFUSED|ETIMEDOUT|ECONNRESET|EPIPE|EAI_AGAIN|fetch failed|socket hang up)/i.test(m)) return true;
  const http = m.match(/(?:Ollama|API) error (\d{3})/);
  if (http) {
    const s = Number(http[1]);
    return s === 408 || s === 429 || s >= 500;
  }
  return /timed? out/i.test(m);
}
var abortError = () => {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
};
async function callWithRetry({ callModel, params, retries, retryDelayMs, onEvent }) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (params.signal?.aborted) throw abortError();
    try {
      return await callModel(params);
    } catch (e) {
      lastErr = e;
      if (e?.name === "AbortError" || params.signal?.aborted) throw e;
      if (attempt >= retries || !isTransient(e)) throw e;
      const wait = retryDelayMs * 3 ** attempt;
      onEvent({ type: "retry", attempt: attempt + 1, max: retries, wait, error: String(e?.message ?? e) });
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
function normalizeArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return { _raw: raw };
    }
  }
  return typeof raw === "object" ? raw : { value: raw };
}
function scanJsonObjects(s) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        out.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  if (depth > 0 && start !== -1) out.push(s.slice(start));
  return out;
}
function repairJson(raw) {
  let s = String(raw);
  s = s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
  let out = "";
  let mode = null;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (mode) {
      if (c === "\\") {
        out += c + (s[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (c === mode) {
        out += mode === "'" ? '"' : c;
        mode = null;
        i++;
        continue;
      }
      if (mode === "'" && c === '"') {
        out += '\\"';
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      mode = c;
      out += c === "'" ? '"' : c;
      i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      i += 2;
      while (i < s.length && !(s[i] === "*" && s[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  if (mode) out += mode === "'" ? '"' : mode;
  out = out.replace(/,\s*([}\]])/g, "$1");
  const stack = [];
  let inStr = false;
  let esc = false;
  for (const ch of out) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (inStr) out += '"';
  while (stack.length) out += stack.pop() === "{" ? "}" : "]";
  return out;
}
function parseTextToolCall(content, known) {
  if (typeof content !== "string" || !/["'\u201C\u2018]name["'\u201D\u2019]\s*:/.test(content)) return [];
  const fences = [...content.matchAll(/```[a-z]*\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const blob of [...fences, content]) {
    for (const raw of scanJsonObjects(blob)) {
      if (seen.has(raw)) continue;
      seen.add(raw);
      let obj = null;
      try {
        obj = JSON.parse(raw);
      } catch {
        try {
          obj = JSON.parse(repairJson(raw));
        } catch {
        }
      }
      if (!obj || typeof obj !== "object") continue;
      const fn = obj.function && typeof obj.function === "object" ? obj.function : obj;
      const name = typeof fn.name === "string" ? fn.name : null;
      if (!name) continue;
      if (known && !known.has(name)) continue;
      out.push({ function: { name, arguments: fn.arguments ?? fn.parameters ?? fn.args ?? {} } });
      if (out.length >= 7) return out;
    }
  }
  return out;
}
var cap = (s, n) => String(s).length > n ? String(s).slice(0, n) + "\n\u2026[truncated]" : String(s);
function fitContext(msgs, { recentTools = 2, oldCap = 4e3, budget = 21e4 } = {}) {
  const shrink = (m, capTo) => {
    if (typeof m.content !== "string" || m.content.length <= capTo) return false;
    const marker = `
\u2026[${m.content.length} chars trimmed to fit the context window]\u2026
`;
    const room = Math.max(200, capTo - marker.length);
    const head = Math.floor(room * 0.7);
    const tail = room - head;
    m.content = m.content.slice(0, head) + marker + (tail > 0 ? m.content.slice(-tail) : "");
    return true;
  };
  const toolIdx = [];
  for (let i = 0; i < msgs.length; i++) if (msgs[i].role === "tool") toolIdx.push(i);
  const keep = new Set(toolIdx.slice(-recentTools));
  for (const i of toolIdx) if (!keep.has(i)) shrink(msgs[i], oldCap);
  let total = 0;
  for (const m of msgs) total += typeof m.content === "string" ? m.content.length : 0;
  for (let i = 0; i < msgs.length && total > budget; i++) {
    const m = msgs[i];
    if (m.role === "system" || keep.has(i)) continue;
    if (typeof m.content === "string" && m.content.length > 2e3) {
      const before = m.content.length;
      shrink(m, Math.max(1e3, Math.floor(before / 2)));
      total -= before - m.content.length;
    }
  }
  return msgs;
}
async function runAgent({
  messages,
  tools = TOOLS,
  registry,
  callModel,
  approve,
  needsApproval = (name) => DANGEROUS_TOOLS.has(name),
  maxIter = DEFAULT_MAX_ITER,
  toolResultCap = 16e3,
  retries = 2,
  retryDelayMs = 400,
  onEvent = () => {
  },
  hooks = null,
  signal,
  allowDelegate = true,
  delegateDepth = 0,
  maxDelegateDepth = 2,
  delegateIter = 4
}) {
  if (typeof callModel !== "function") throw new Error("runAgent: callModel is required");
  if (!registry || typeof registry !== "object") throw new Error("runAgent: registry is required");
  let effRegistry = registry;
  let effTools = tools;
  if (allowDelegate && delegateDepth < maxDelegateDepth && !("delegate" in registry)) {
    effRegistry = {
      ...registry,
      delegate: {
        check: (a) => {
          if (!a || typeof a.task !== "string" || !a.task.trim())
            return "task is required \u2014 a focused brief for the sub-agent";
          if (a.task.length > 4e3) return "task too long \u2014 keep the brief under 4000 characters";
          return null;
        },
        run: async (a) => {
          const sub = await runAgent({
            messages: [{ role: "user", content: String(a.task) }],
            registry,
            callModel,
            approve,
            needsApproval,
            hooks,
            signal,
            maxIter: delegateIter,
            toolResultCap,
            allowDelegate,
            delegateDepth: delegateDepth + 1,
            maxDelegateDepth,
            delegateIter,
            onEvent: (ev) => onEvent({ ...ev, sub: true, depth: delegateDepth + 1 })
          });
          const text2 = sub.text || (sub.status === "limit" ? "(the sub-agent hit its step cap)" : "(no final text)");
          return `sub-agent finished (${sub.status}, ${sub.iterations} steps):
${cap(text2, 8e3)}`;
        }
      }
    };
    effTools = effTools.some((t) => t?.function?.name === "delegate") ? effTools : [...effTools, DELEGATE_TOOL];
  }
  const toolNames = new Set(Object.keys(effRegistry));
  const capIter = Math.min(40, Math.max(5, Math.floor(maxIter) || DEFAULT_MAX_ITER));
  const msgs = messages.map((m) => ({ ...m }));
  const usage = { promptTokens: 0, completionTokens: 0, calls: 0 };
  let iter = 0;
  for (; ; ) {
    if (iter >= capIter) {
      onEvent({ type: "end", status: "limit", iterations: iter });
      return { status: "limit", text: "", messages: msgs, iterations: iter, usage };
    }
    iter++;
    fitContext(msgs);
    let res;
    try {
      res = await callWithRetry({ callModel, params: { messages: msgs, tools: effTools, signal }, retries, retryDelayMs, onEvent });
    } catch (e) {
      if (e?.name === "AbortError" || signal?.aborted) {
        onEvent({ type: "end", status: "stopped", iterations: iter });
        return { status: "stopped", text: "", messages: msgs, iterations: iter, usage };
      }
      throw e;
    }
    usage.calls++;
    if (res.stats) {
      usage.promptTokens += Number(res.stats.promptTokens) || 0;
      usage.completionTokens += Number(res.stats.completionTokens) || 0;
    }
    const content = res.content ?? "";
    const calls = Array.isArray(res.tool_calls) && res.tool_calls.length ? res.tool_calls : parseTextToolCall(content, toolNames);
    if (!calls.length) {
      msgs.push({ role: "assistant", content });
      onEvent({ type: "end", status: "text", iterations: iter, text: content });
      return { status: "text", text: content, messages: msgs, iterations: iter, usage };
    }
    const wireCalls = calls.map((c, i) => {
      const fn = c && typeof c === "object" && c.function ? c.function : c;
      return {
        ...c && typeof c === "object" ? c : {},
        id: c?.id ?? `call_${iter}_${i}`,
        function: {
          name: fn?.name ?? c?.name,
          arguments: fn?.arguments ?? c?.arguments ?? fn?.parameters ?? c?.args ?? {}
        }
      };
    });
    const assistantMsg = { role: "assistant", content, tool_calls: wireCalls };
    msgs.push(assistantMsg);
    const run1 = async (call) => {
      const name = call.function.name ?? "(unnamed)";
      const args = normalizeArgs(call.function.arguments);
      let outcome = "ok";
      let result;
      const t0 = Date.now();
      const entry = effRegistry[name];
      if (!entry) {
        outcome = "unknown";
        result = `ERROR: unknown tool "${name}"`;
      } else {
        const problem = entry.check ? await entry.check(args) : null;
        if (problem) {
          outcome = "rejected";
          result = `ERROR: ${problem}`;
        } else {
          const blocked = runHooks(hooks, "before_tool", name, args);
          if (blocked !== null) {
            outcome = "blocked";
            result = `BLOCKED by hook: ${blocked}`;
          } else if (needsApproval(name, args)) {
            const allowed = approve ? await approve(name, args) : false;
            if (!allowed) {
              outcome = "denied";
              result = `BLOCKED: the user denied approval for ${name}. Nothing was executed.`;
            }
          }
        }
        if (outcome === "ok") {
          try {
            const out = await entry.run(args);
            result = cap(out ?? "", toolResultCap);
          } catch (e) {
            outcome = "error";
            result = `ERROR: ${e?.message ?? e}`;
          }
          const afterFailure = runHooks(hooks, "after_tool", name, args);
          if (afterFailure !== null) result += `
[hook] ${afterFailure}`;
        }
      }
      onEvent({ type: "tool", iteration: iter, name, args, outcome, result, ms: Date.now() - t0 });
      return {
        role: "tool",
        tool_name: name,
        // Ollama native pairing key
        tool_call_id: call.id,
        // OpenAI-compatible pairing key (always set now)
        content: result
      };
    };
    let split = wireCalls.length;
    for (let i = 0; i < wireCalls.length; i++) {
      const n = wireCalls[i].function.name;
      if (!PARALLEL_SAFE.has(n)) {
        split = i;
        break;
      }
      if (await needsApproval(n, normalizeArgs(wireCalls[i].function.arguments))) {
        split = i;
        break;
      }
    }
    if (split > 0) {
      const head = await Promise.all(wireCalls.slice(0, split).map((c) => run1(c)));
      for (const m of head) msgs.push(m);
    }
    for (let i = split; i < wireCalls.length; i++) msgs.push(await run1(wireCalls[i]));
  }
}

// src/main/v2.ts
var regCache = [];
function killProc(t) {
  if (!t.running || !t.proc?.pid) return;
  try {
    if (process.platform === "win32") {
      spawnSync2("taskkill", ["/pid", String(t.proc.pid), "/T", "/F"], { windowsHide: true });
    } else t.proc.kill("SIGTERM");
  } catch {
  }
  try {
    t.proc.kill();
  } catch {
  }
}
var TASK_OUT_TAIL = 6e3;
function listV2Tasks() {
  const rows = [];
  for (const entry of regCache) {
    const tasks = entry.registry.task_status?.state?.tasks;
    if (!tasks) continue;
    const workspace = entry.roots[0] ?? "";
    for (const t of tasks.values()) {
      rows.push({
        uid: `${workspace}:${t.id}`,
        id: t.id,
        command: t.command,
        running: t.running,
        code: t.code,
        out: t.out.length > TASK_OUT_TAIL ? t.out.slice(-TASK_OUT_TAIL) : t.out,
        outTotal: t.out.length,
        started: t.started ?? 0,
        workspace
      });
    }
  }
  return rows.sort((a, b) => Number(b.running) - Number(a.running) || b.id - a.id);
}
function stopV2Task(uid) {
  for (const entry of regCache) {
    const tasks = entry.registry.task_status?.state?.tasks;
    if (!tasks) continue;
    const workspace = entry.roots[0] ?? "";
    for (const t of tasks.values()) {
      if (`${workspace}:${t.id}` === uid) {
        killProc(t);
        return true;
      }
    }
  }
  return false;
}
export {
  listV2Tasks,
  makeRegistry,
  runAgent,
  stopV2Task
};
