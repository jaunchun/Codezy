// src/main/update.ts
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
var UPDATE_REPO = "jaunchun/Codezy";
function parseVersion(name) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(name));
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3] ?? "0"}`;
}
function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
function isNewerVersion(a, b) {
  return compareVersions(a, b) > 0;
}
function pickAsset(assets) {
  if (!Array.isArray(assets)) return null;
  let best = null;
  for (const raw of assets) {
    const a = raw;
    if (!a || typeof a.name !== "string") continue;
    if (!/\.exe$/i.test(a.name)) continue;
    const version = parseVersion(a.name);
    if (!version) continue;
    const url = typeof a.browser_download_url === "string" ? a.browser_download_url : "";
    if (!url) continue;
    const cand = {
      version,
      name: a.name,
      url,
      size: typeof a.size === "number" ? a.size : 0
    };
    if (!best || isNewerVersion(cand.version, best.version)) best = cand;
  }
  return best;
}
function evaluateReleases(payload, current) {
  const out = { ok: true, current, available: false, release: null };
  if (!Array.isArray(payload)) return out;
  let best = null;
  for (const raw of payload) {
    const rel = raw;
    if (!rel || typeof rel !== "object") continue;
    if (rel.draft === true || rel.prerelease === true) continue;
    const pick = pickAsset(rel.assets);
    if (!pick) continue;
    pick.notes = typeof rel.body === "string" ? rel.body.slice(0, 400) : "";
    pick.page = typeof rel.html_url === "string" ? rel.html_url : "";
    if (!best || isNewerVersion(pick.version, best.version)) best = pick;
  }
  if (best && isNewerVersion(best.version, current)) {
    out.available = true;
    out.release = best;
  } else if (best) {
    out.release = null;
  }
  return out;
}
async function checkForUpdates(current, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(
      `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=10`,
      {
        headers: {
          "user-agent": `CODEZY/${current} (https://github.com/${UPDATE_REPO})`,
          accept: "application/vnd.github+json"
        },
        signal: AbortSignal.timeout(8e3)
      }
    );
    if (!res.ok) {
      return { ok: false, current, available: false, release: null, error: `GitHub responded ${res.status}` };
    }
    return evaluateReleases(await res.json(), current);
  } catch (e) {
    return {
      ok: false,
      current,
      available: false,
      release: null,
      error: e instanceof Error ? e.message : String(e)
    };
  }
}
async function downloadUpdate(url, dir, onProgress, fetchImpl = fetch) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const res = await fetchImpl(url, {
      headers: { "user-agent": `CODEZY updater` },
      redirect: "follow",
      signal: AbortSignal.timeout(6e5)
      // 113 MB on a slow line
    });
    if (!res.ok || !res.body) return { error: `download failed (HTTP ${res.status})` };
    const total = Number(res.headers.get("content-length")) || 0;
    const dest = path.join(dir, `CODEZY-update.exe`);
    const tmp = `${dest}.part`;
    const out = fs.createWriteStream(tmp);
    const reader = res.body.getReader();
    let received = 0;
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (!out.write(Buffer.from(value))) {
          await new Promise((r) => out.once("drain", () => r()));
        }
        onProgress({ received, total, percent: total ? Math.min(100, Math.round(received / total * 100)) : -1 });
      }
    }
    await new Promise((resolve, reject) => {
      out.end(() => resolve());
      out.on("error", reject);
    });
    if (total && received !== total) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
      }
      return { error: `incomplete download (${received}/${total} bytes)` };
    }
    fs.renameSync(tmp, dest);
    return { path: dest };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
function applyUpdate(setupPath) {
  return new Promise((resolve) => {
    try {
      if (!fs.existsSync(setupPath)) {
        resolve({ ok: false, error: "update file is gone" });
        return;
      }
      const child = spawn(setupPath, ["--updated", "/S", "--force-run"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      child.once("spawn", () => {
        child.unref();
        resolve({ ok: true });
      });
      child.once("error", (e) => resolve({ ok: false, error: e.message }));
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}
export {
  UPDATE_REPO,
  applyUpdate,
  checkForUpdates,
  compareVersions,
  downloadUpdate,
  evaluateReleases,
  isNewerVersion,
  parseVersion,
  pickAsset
};
