// src/main/edits.ts
import fs2 from "fs";
import path2 from "path";

// src/main/store.ts
import fs from "fs";
import os from "os";
import path from "path";
var DEFAULT_DATA_DIR = path.join(os.homedir(), ".codezy");
var dataDir = DEFAULT_DATA_DIR;
var p = {
  settings: () => path.join(dataDir, "settings.json"),
  projects: () => path.join(dataDir, "projects.json"),
  sessions: () => path.join(dataDir, "sessions"),
  session: (id) => path.join(dataDir, "sessions", `${id}.json`),
  memory: () => path.join(dataDir, "memory.md"),
  // what CODEZY learns about you
  projectContext: (id) => path.join(dataDir, "projects", `${id}.md`),
  skills: () => path.join(dataDir, "skills"),
  goals: () => path.join(dataDir, "goals.json"),
  backups: (sessionId) => path.join(dataDir, "backups", sessionId)
  // pre-edit file copies for /undo
};
function readDataDirPointer() {
  try {
    const file = path.join(DEFAULT_DATA_DIR, "settings.json");
    if (!fs.existsSync(file)) return void 0;
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof j.dataDir === "string" && j.dataDir.trim() ? j.dataDir : void 0;
  } catch {
    return void 0;
  }
}
function initStore(dir) {
  const target = dir && dir.trim() ? dir : readDataDirPointer();
  dataDir = target && target.trim() ? target : DEFAULT_DATA_DIR;
  for (const dir2 of [dataDir, p.sessions(), path.dirname(p.projectContext("x")), p.skills()]) {
    fs.mkdirSync(dir2, { recursive: true });
  }
  seedSkills();
}
var SEED_SKILLS = {
  "code-reviewer": `You are a strict senior code reviewer. Go through the code or edits in
front of you and report, in this order:
1. Correctness - logic errors, off-by-one, wrong assumptions, unhandled null/empty cases.
2. Security - injection, path traversal, secrets in source, unsafe input handling.
3. Performance - needless loops, quadratic work on large data, repeated I/O.
4. Readability - naming, dead code, functions doing too many things.
Format: one bullet per finding with the file/line, why it matters, and the minimal fix.
End with a verdict line: APPROVE or FIX NEEDED. Be blunt; never pad with praise and
never restate the code back.`,
  explainer: `Explain code fast, assuming the reader already has it open in front of them:
1. One line on what this file or feature does overall.
2. Walk it top to bottom: each block or function in execution order, one sentence on
   what it does and WHY it exists.
3. Call out the non-obvious parts - state, async, side effects - with a tiny example
   of what happens at runtime.
4. Finish with gotchas: edge cases and things that break silently.
Never paste the whole code back; refer to parts by name. Keep it tight.`,
  "test-writer": `Write real, runnable tests:
1. Detect the framework from the project files (package.json, pyproject.toml,
   CMakeLists.txt) and match its conventions exactly.
2. Cover the happy path, boundary values, error paths and empty input.
3. One behavior per test, descriptive test names, no branching logic inside tests.
4. No placeholders - every assert must be real and the tests must run as-is.
Output test files as ===FILE edit blocks so they can be accepted into the linked folder.`
};
function listSkills() {
  try {
    return fs.readdirSync(p.skills()).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
  } catch {
    return [];
  }
}
function seedSkills() {
  try {
    if (listSkills().length > 0) return;
    for (const [name, body] of Object.entries(SEED_SKILLS)) {
      fs.writeFileSync(path.join(p.skills(), `${name}.md`), `${body.trim()}
`, "utf8");
    }
  } catch {
  }
}

// src/main/edits.ts
var lastBackupTs = 0;
function nextBackupId() {
  const now = Date.now();
  lastBackupTs = now > lastBackupTs ? now : lastBackupTs + 1;
  return String(lastBackupTs);
}
function inside(folder, target) {
  const rel = path2.relative(path2.resolve(folder), path2.resolve(target));
  return !!rel && !rel.startsWith("..") && !path2.isAbsolute(rel);
}
function resolveTarget(edit, folders) {
  const raw = edit.path.trim().replace(/\//g, "\\");
  const absolute = path2.isAbsolute(raw) || /^[a-zA-Z]:\\/.test(raw) || raw.startsWith("\\\\");
  if (absolute) {
    const target = path2.normalize(raw);
    if (!folders.some((f) => inside(f, target))) {
      return { error: `${edit.path}: outside the linked folders \u2014 refused.` };
    }
    return { target };
  }
  const candidates = folders.map((f) => path2.join(f, raw)).filter((c) => folders.some((f) => inside(f, c)));
  if (!candidates.length) return { error: `${edit.path}: outside the linked folders \u2014 refused.` };
  const existing = candidates.find((c) => fs2.existsSync(c));
  if (existing) return { target: existing };
  if (!edit.isNew) return { error: `${edit.path}: not found in the linked folders.` };
  return { target: candidates[0] };
}
function applyEdits(session, edits) {
  const applied = [];
  const errors = [];
  const folders = session.linkedFolders ?? [];
  if (!folders.length) return { applied, errors: ["Link a folder to this chat first."], backupId: null };
  if (!edits.length) return { applied, errors: ["Nothing to apply."], backupId: null };
  const plan = [];
  for (const edit of edits) {
    try {
      const { target, error } = resolveTarget(edit, folders);
      if (error || !target) {
        errors.push(error ?? `${edit.path}: could not be resolved.`);
        continue;
      }
      let next;
      let prev = null;
      if (edit.isNew) {
        if (fs2.existsSync(target)) {
          errors.push(`${edit.path}: already exists (model claimed EMPTY).`);
          continue;
        }
        next = edit.replace;
      } else {
        if (!fs2.existsSync(target)) {
          errors.push(`${edit.path}: not found.`);
          continue;
        }
        const rawBuf = fs2.readFileSync(target);
        const current = rawBuf.toString("utf8");
        if (current.includes("\0") || !Buffer.from(current, "utf8").equals(rawBuf)) {
          errors.push(`${edit.path}: not UTF-8 text (binary or legacy encoding) \u2014 refusing to edit to avoid corruption.`);
          continue;
        }
        const hay = current.replace(/\r\n/g, "\n");
        const needle = edit.search.replace(/\r\n/g, "\n");
        const idx = hay.indexOf(needle);
        if (idx === -1) {
          errors.push(`${edit.path}: the code to replace no longer matches (file changed?).`);
          continue;
        }
        if (hay.indexOf(needle, idx + needle.length) !== -1) {
          errors.push(`${edit.path}: the code to replace matches several places \u2014 be more specific.`);
          continue;
        }
        prev = current;
        next = hay.slice(0, idx) + edit.replace.replace(/\r\n/g, "\n") + hay.slice(idx + needle.length);
        const crlf = (current.match(/\r\n/g) ?? []).length;
        const lf = (current.match(/\n/g) ?? []).length - crlf;
        if (crlf > lf) next = next.replace(/\n/g, "\r\n");
      }
      plan.push({ target, next, prev, isNew: edit.isNew, editPath: edit.path });
    } catch (e) {
      errors.push(`${edit.path}: ${e.message}`);
    }
  }
  if (!plan.length) return { applied, errors, backupId: null };
  const entries = plan.map((w) => ({ path: w.target, prev: w.prev }));
  let backupId = null;
  try {
    const dir = p.backups(session.id);
    fs2.mkdirSync(dir, { recursive: true });
    backupId = nextBackupId();
    fs2.writeFileSync(path2.join(dir, `${backupId}.json`), JSON.stringify({ ts: Date.now(), entries }, null, 2), "utf8");
  } catch (e) {
    return {
      applied,
      errors: [...errors, `safety backup could not be written (${e.message}) \u2014 no files were changed.`],
      backupId: null
    };
  }
  const written = [];
  for (const w of plan) {
    try {
      fs2.mkdirSync(path2.dirname(w.target), { recursive: true });
      fs2.writeFileSync(w.target, w.next, "utf8");
      applied.push({ path: w.target, isNew: w.isNew });
      written.push({ path: w.target, prev: w.prev });
    } catch (e) {
      errors.push(`${w.editPath}: ${e.message}`);
    }
  }
  if (backupId) {
    const backupFile = path2.join(p.backups(session.id), `${backupId}.json`);
    if (!written.length) {
      try {
        fs2.rmSync(backupFile, { force: true });
      } catch {
      }
      backupId = null;
    } else if (written.length !== entries.length) {
      try {
        fs2.writeFileSync(backupFile, JSON.stringify({ ts: Date.now(), entries: written }, null, 2), "utf8");
      } catch {
      }
    }
  }
  return { applied, errors, backupId };
}
function applyCodeBlock(session, target, content) {
  const roots = session.linkedFolders ?? [];
  if (!roots.length) throw new Error("Link a folder to this chat first");
  const rel = String(target ?? "").trim().replace(/\\/g, "/");
  if (!rel || rel.includes("..") || rel.startsWith("/") || /^[a-zA-Z]:/.test(rel)) {
    throw new Error("Give a path inside the linked folder (e.g. src/app.ts)");
  }
  const existing = roots.map((r) => path2.join(r, rel)).find((c) => fs2.existsSync(c));
  let search = "";
  const isNew = !existing;
  if (existing) {
    const raw = fs2.readFileSync(existing);
    const cur = raw.toString("utf8");
    if (cur.includes("\0") || !Buffer.from(cur, "utf8").equals(raw)) {
      throw new Error("That file is not UTF-8 text \u2014 refusing to overwrite it.");
    }
    search = cur;
  }
  const out = applyEdits(session, [{ path: rel, search, replace: String(content ?? ""), isNew }]);
  if (out.errors?.length) throw new Error(out.errors[0]);
  return { saved: out.applied[0]?.path ?? rel, backupId: out.backupId };
}
function undoLast(sessionId) {
  const dir = p.backups(sessionId);
  let files;
  try {
    files = fs2.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return { restored: 0, message: "Nothing to undo \u2014 no edits were applied yet." };
  }
  if (!files.length) return { restored: 0, message: "Nothing to undo \u2014 no edits were applied yet." };
  const latest = files.sort((a, b) => (parseInt(b, 10) || 0) - (parseInt(a, 10) || 0))[0];
  let entries;
  try {
    entries = JSON.parse(fs2.readFileSync(path2.join(dir, latest), "utf8")).entries;
  } catch {
    return { restored: 0, message: "Backup unreadable \u2014 nothing changed." };
  }
  const seen = /* @__PURE__ */ new Set();
  const deduped = [];
  for (const e of entries) {
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    deduped.push(e);
  }
  let restored = 0;
  const failed = [];
  for (const e of deduped) {
    try {
      if (e.prev === null) fs2.rmSync(e.path, { force: true });
      else fs2.writeFileSync(e.path, e.prev, "utf8");
      restored++;
    } catch {
      failed.push(e);
    }
  }
  const latestPath = path2.join(dir, latest);
  if (failed.length) {
    try {
      fs2.writeFileSync(latestPath, JSON.stringify({ ts: Date.now(), entries: failed }, null, 2), "utf8");
    } catch {
    }
    return {
      restored,
      message: `Reverted ${restored} file${restored === 1 ? "" : "s"}; ${failed.length} could not be written (locked or missing) \u2014 run /undo again to retry.`
    };
  }
  fs2.rmSync(latestPath, { force: true });
  return { restored, message: `Reverted ${restored} file${restored === 1 ? "" : "s"}.` };
}
export {
  applyCodeBlock,
  applyEdits,
  initStore,
  undoLast
};
