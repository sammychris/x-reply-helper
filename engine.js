// Autopilot engine. Runs in the extension's background, so it keeps going when the
// control center tab is closed or hidden. The control center only shows the queue and sends commands.
//
// Flow: queue → read each post in the working window → describe pictures once → write → review
//       → you review → Continue → for each post: open it, wait on it, then like / repost / reply, move on.
import "./ap-defaults.js";
import { describe, write, review, styleProblems } from "./ai.js";

const D = self.AP_DEFAULTS;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const rand = (a, b) => a + Math.random() * Math.max(0, b - a);
const fmtMin = sec => (sec >= 90 ? `${Math.round(sec / 60)} min` : `${Math.round(sec)} s`);
const FINISHED = ["done", "skipped", "failed"];

let ap = structuredClone(D);
let queue = [];
let logLines = [];
let busy = ""; // "", "writing", "posting", "collecting"
let paused = false;
let collectorTab = null;
let writeAfterCollect = false;
let statusText = "Idle";

// ---------- loading and saving ----------
function mergeSettings(s = {}) {
  return { ...structuredClone(D), ...s, types: { ...D.types, ...(s.types || {}) }, filters: { ...D.filters, ...(s.filters || {}) }, defaultActions: { ...structuredClone(D.defaultActions), ...(s.defaultActions || {}) } };
}
async function load() {
  const st = await chrome.storage.local.get(["apSettings", "apQueue", "apLog", "apCollectorTab", "apDone"]);
  ap = mergeSettings(st.apSettings);
  // A post that was mid-way when Chrome stopped goes back a step. Posting is safe to repeat:
  // likes/reposts are checked first, and a reply is skipped if yours is already under the post.
  queue = (st.apQueue || []).map(i => ({ ...i, status: ["reading", "writing"].includes(i.status) ? "queued" : i.status === "posting" ? "ready" : i.status }));
  logLines = st.apLog || [];
  collectorTab = st.apCollectorTab || null;
  // keep the "already done" list from growing forever: forget posts older than 60 days
  const done = st.apDone || {}, cutoff = Date.now() - 60 * 864e5;
  const keep = Object.fromEntries(Object.entries(done).filter(([, v]) => (v.at || 0) > cutoff));
  if (Object.keys(keep).length !== Object.keys(done).length) await chrome.storage.local.set({ apDone: keep });
  const w = (await chrome.storage.session.get("apWorker")).apWorker;
  if (w) { workerTab = w.tab; workerWin = w.win; }
}
const ready = load();

let saveTimer = null;
function slim(i) {
  // video frames are big: never keep them once used. Finished posts keep only what the Done list shows.
  const post = i.post ? { ...i.post, frames: undefined } : undefined;
  return FINISHED.includes(i.status) ? { ...i, post: undefined, drafts: undefined, scores: undefined, notes: undefined, issues: undefined } : { ...i, post };
}
function saveNow() {
  clearTimeout(saveTimer);
  return chrome.storage.local.set({ apQueue: queue.map(slim), apLog: logLines.slice(-400) });
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 250); }
function touch(it) { it._v = (it._v || 0) + 1; save(); }
function log(msg, cls = "") { logLines.push({ t: new Date().toLocaleTimeString(), msg, cls }); save(); }
function setStatus(text) {
  statusText = text;
  return chrome.storage.session.set({ apStatus: { text, busy, paused } });
}

// While Autopilot works, keep the background awake (Chrome stops idle extension backgrounds after 30 s).
let keepAlive = null;
function setBusy(b) {
  busy = b;
  clearInterval(keepAlive);
  if (b) keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20e3);
  setStatus(statusText);
}

chrome.storage.onChanged.addListener(async (ch, area) => {
  if (area !== "local") return;
  if (ch.apSettings) ap = mergeSettings(ch.apSettings.newValue);
  if (ch.apCollectorTab) collectorTab = ch.apCollectorTab.newValue;
  if (ch.apInbox && (ch.apInbox.newValue || []).length) { await ready; drainInbox(); }
});

// ---------- adding posts ----------
async function addItems(items) {
  const { apDone = {} } = await chrome.storage.local.get("apDone");
  const have = new Set(queue.map(i => i.id));
  let added = 0, dup = 0;
  for (const x of items) {
    if (!x?.id || have.has(x.id) || apDone[x.id]) { dup++; continue; }
    have.add(x.id);
    const it = {
      id: x.id, url: x.url || `https://x.com/i/status/${x.id}`, handle: x.handle || "", text: x.text || "", thumb: x.thumb || "", type: x.type || "",
      source: x.source || "link", fav: !!x.fav, actions: { ...(x.actions || ap.defaultActions[x.source] || ap.defaultActions.link) },
      status: "queued", added: Date.now(), warn: [], _v: 1
    };
    if (it.fav) queue.unshift(it); else queue.push(it);
    added++;
  }
  if (added || dup) log(`Added ${added} to the queue` + (dup ? ` (${dup} already in the queue or done)` : ""));
  await saveNow();
  return { added, dup };
}
let draining = false;
async function drainInbox() {
  if (draining) return;
  draining = true;
  try {
    const { apInbox = [] } = await chrome.storage.local.get("apInbox");
    if (!apInbox.length) return;
    await chrome.storage.local.set({ apInbox: [] });
    const { added } = await addItems(apInbox);
    if (writeAfterCollect) {
      writeAfterCollect = false;
      if (added) writeBatch(); else { log("Nothing new to collect. Keep going stopped."); setStatus("Idle"); }
    }
  } finally { draining = false; }
}

// ---------- the working window ----------
let workerTab = null, workerWin = null;
let inAppOk = true, inAppFails = 0;
let chain = Promise.resolve();
function withWorker(fn) { const r = chain.then(fn); chain = r.catch(() => {}); return r; }

function waitLoad(tabId, ms = 25000) {
  return new Promise(resolve => {
    const done = () => { chrome.tabs.onUpdated.removeListener(l); clearTimeout(t); resolve(); };
    const l = (id, info) => { if (id === tabId && info.status === "complete") done(); };
    const t = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(l);
  });
}
async function ensureWorker() {
  if (workerTab) { try { await chrome.tabs.get(workerTab); return false; } catch (_) { workerTab = null; } }
  const w = await chrome.windows.create({ url: "https://x.com/home", focused: false, width: 520, height: 860, left: 20, top: 20 });
  workerWin = w.id; workerTab = w.tabs[0].id;
  await chrome.storage.session.set({ apWorker: { tab: workerTab, win: workerWin } });
  log("Opened the working window. Keep it open and on screen (not minimised) while Autopilot runs.");
  await waitLoad(workerTab);
  return true;
}
export const isWorker = tabId => tabId != null && tabId === workerTab;

async function send(msg, ms = 60000, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try {
      return await Promise.race([chrome.tabs.sendMessage(workerTab, msg), sleep(ms).then(() => ({ ok: false, error: "The working window took too long." }))]);
    } catch (e) {
      if (!/Receiving end|Could not establish/i.test(e.message)) throw e;
      if (i < tries - 1) await sleep(500); // the page is still loading
    }
  }
  if (tries === 1) return { ok: false };
  throw new Error("The working window isn't responding. Reload it.");
}

// Open a post. First try moving inside X (like tapping a post: no full reload); if that
// doesn't work, load the post's page normally.
async function openPost(it) {
  const fresh = await ensureWorker();
  if (inAppOk && !fresh) {
    let r = null;
    try {
      const tab = await chrome.tabs.get(workerTab);
      if (tab.status === "complete") r = await send({ type: "apNav", url: it.url, id: it.id }, 12000, 1); // only answers if it's on X
    } catch (_) {}
    if (r?.ok) { inAppFails = 0; return "in-app"; }
    if (r?.error && /^(login|gone|ratelimit)/.test(r.error)) throw new Error(r.error);
    if (r && ++inAppFails >= 3) { inAppOk = false; log("Moving between posts inside X didn't work 3 times in a row, so it's loading each post's page instead."); }
  }
  await chrome.tabs.update(workerTab, { url: it.url });
  await waitLoad(workerTab);
  await send({ type: "apPing" }, 5000);
  return "reload";
}

// ---------- step 1+2: read and write ----------
function limiter(n) {
  let active = 0; const waiting = [];
  const next = () => { if (active < n && waiting.length) { active++; const [fn, res, rej] = waiting.shift(); fn().then(res, rej).finally(() => { active--; next(); }); } };
  return fn => new Promise((res, rej) => { waiting.push([fn, res, rej]); next(); });
}
async function grokLeft() {
  const { apGrok = {} } = await chrome.storage.local.get("apGrok");
  return Math.max(0, ap.grokPerDay - (apGrok[today()] || 0));
}
async function useGrok() {
  const { apGrok = {} } = await chrome.storage.local.get("apGrok");
  apGrok[today()] = (apGrok[today()] || 0) + 1;
  await chrome.storage.local.set({ apGrok });
}
const me = () => String(ap.myHandle || "").toLowerCase().replace(/^@/, "");

async function think(it) {
  const p = it.post;
  it.warn = [];
  const media = ap.images ? [...p.images.map(url => ({ url })), ...(p.frames || []).map(data => ({ data }))] : [];
  it.understood = true;
  if (media.length) {
    try {
      const d = await describe(it, media, ap);
      it.desc = d.description; it.understood = d.understood;
    } catch (e) {
      it.warn.push("Couldn't read the pictures: " + e.message);
      it.understood = (p.text || "").length > 40;
    }
  } else if (p.type !== "text" && !ap.images) {
    it.understood = (p.text || "").length > 40 || (p.alts || []).length > 0;
  }
  delete p.frames; // used once, then dropped (they're big)
  if (p.grokReply) it.understood = true; // Grok already explained it in the replies
  if (p.type === "video" && !it.understood && ap.grok && (await grokLeft()) > 0) {
    const g = await withWorker(async () => { await openPost(it); return send({ type: "apGrok", id: it.id }, 70000); }).catch(e => ({ ok: false, error: e.message }));
    if (g.ok) { it.grok = g.text; it.understood = true; await useGrok(); }
    else it.warn.push("Grok: " + g.error);
  }

  await writeAndPick(it);
}

// Write 3 replies (in the chosen style) and let the reviewer + local check pick the best.
async function writeAndPick(it, forceMode) {
  const p = it.post;
  it.skipReason = "";
  it.warn = (it.warn || []).filter(w => !/^(Suggest skipping|Reviewer unavailable|Not sure)/.test(w));
  const w = await write(it, ap, forceMode);
  it.drafts = w.replies; it.via = w.via; it.mode = w.mode;
  if (w.skip) it.skipReason = w.reason || "AI suggests skipping";
  if (!it.drafts.length) throw new Error(it.skipReason || "The writer sent no replies.");

  let scores = it.drafts.map(() => 7), notes = [];
  try {
    const r = await review(it, it.drafts, ap, it.mode);
    scores = it.drafts.map((_, i) => r.scores[i] || 5); notes = r.notes;
    it.via += " → " + r.via;
  } catch (e) { it.warn.push("Reviewer unavailable: " + e.message); }
  it.issues = it.drafts.map(d => styleProblems(d, ap, it.mode)); // free check for AI-sounding writing
  scores = scores.map((s, i) => Math.max(1, s - 2 * it.issues[i].length));
  const best = scores.indexOf(Math.max(...scores));
  it.scores = scores; it.notes = notes; it.best = best;
  it.reply = it.drafts[best];
  it.score = scores[best];
  if (!it.understood) it.warn.push(`Not sure what's in the ${p.type === "video" ? "video" : "picture"}.`);
  if (it.skipReason) it.warn.push("Suggest skipping: " + it.skipReason);
  // You decide: everything comes ticked unless you turned on "Untick weak replies for me".
  it.include = ap.autoUntick ? !it.skipReason && it.understood && it.score >= ap.passScore : true;
}

function stopFor(e) {
  if (/^login/.test(e)) return "X logged you out in the working window. Log in there, then press the button again.";
  if (/^ratelimit/.test(e)) return "X says you've hit its rate limit. Autopilot paused. Wait 15 minutes or more before continuing.";
  return "";
}

async function writeBatch() {
  if (busy) return;
  const items = queue.filter(i => i.status === "queued").slice(0, Number(ap.batchSize));
  if (!items.length) { setStatus("The queue is empty. Collect posts on X or paste links."); return; }
  paused = false; setBusy("writing");
  const lim = limiter(2);
  const jobs = [];
  let n = 0;
  log(`Writing replies for ${items.length} posts`);
  for (const it of items) {
    if (paused) break;
    if (!it.actions.reply) { it.status = "ready"; it.include = true; touch(it); n++; continue; } // like / repost only: nothing to read
    it.status = "reading"; touch(it);
    setStatus(`Reading ${++n}/${items.length}: @${it.handle || "post"}`);
    try {
      const r = await withWorker(async () => {
        await openPost(it);
        return send({ type: "apRead", id: it.id, opts: { readReplies: ap.readReplies, frames: ap.images && ap.videoFrames, me: me() } });
      });
      if (!r.ok) throw new Error(r.error);
      it.post = r.post;
      Object.assign(it, { handle: r.post.handle, text: r.post.text, thumb: r.post.thumb || it.thumb, type: r.post.type, url: r.post.url || it.url });
      if (ap.filters.own && it.handle.toLowerCase() === me()) { it.status = "skipped"; it.error = "Your own post"; touch(it); continue; }
      it.status = "writing"; touch(it);
      jobs.push(lim(async () => {
        try { await think(it); it.status = "ready"; }
        catch (e) { it.status = "failed"; it.error = e.message; log(`@${it.handle}: ${e.message}`, "e"); }
        touch(it);
      }));
    } catch (e) {
      it.status = /^(login|ratelimit)/.test(e.message) ? "queued" : "failed";
      it.error = e.message.replace(/^\w+: /, ""); touch(it);
      log(`Couldn't read ${it.url}: ${it.error}`, "e");
      const stop = stopFor(e.message);
      if (stop) { paused = true; await Promise.all(jobs); setBusy(""); return setStatus(stop); }
    }
  }
  setStatus("Finishing the replies…");
  await Promise.all(jobs);
  setBusy("");
  const rd = queue.filter(i => i.status === "ready");
  log(`Batch written: ${rd.filter(i => i.include).length} ticked, ${rd.filter(i => !i.include).length} unticked`, "ok");
  setStatus(paused ? "Paused." : "Ready to review. Untick or edit anything, then press Continue.");
  attention();
}

async function attention() {
  try {
    const [page] = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [chrome.runtime.getURL("autopilot.html")] });
    if (page?.windowId >= 0) chrome.windows.update(page.windowId, { drawAttention: true });
  } catch (_) {}
}

// ---------- step 3: post ----------
async function bumpCount() {
  const { counts = {} } = await chrome.storage.local.get("counts");
  counts[today()] = (counts[today()] || 0) + 1;
  await chrome.storage.local.set({ counts });
}
async function wait(sec, label, extra = () => "") {
  const end = Date.now() + sec * 1000;
  while (Date.now() < end && !paused) {
    setStatus(`${label} ${Math.ceil((end - Date.now()) / 1000)}s${extra()}`);
    await sleep(Math.min(1000, end - Date.now()));
  }
}

async function postApproved() {
  if (busy) return;
  const items = queue.filter(i => i.status === "ready" && i.include);
  if (!items.length) { setStatus("Nothing ticked to post."); return; }
  paused = false; setBusy("posting");
  const finish = ap.paceMode === "finish";
  let deadline = Date.now() + Number(ap.finishMinutes) * 60e3;
  const weights = items.map(() => 0.4 + Math.random() * 1.2); // every wait different, still adds up to your time
  let workAvg = 6000, workN = 1; // time to open a post + act on it, learned as it goes
  log(`Posting ${items.length}` + (finish ? ` within ${ap.finishMinutes} min` : ""));
  let n = 0, errors = 0, slow = 1;
  const left = () => (finish ? ` · ${n}/${items.length} done · about ${fmtMin(Math.max(0, (deadline - Date.now()) / 1000))} left` : ` · ${n}/${items.length} done`);

  for (let k = 0; k < items.length && !paused; k++) {
    const it = items[k];
    const want = { like: !!it.actions.like, repost: !!it.actions.repost, reply: it.actions.reply ? (it.reply || "").trim() : "", me: me() };
    if (!want.like && !want.repost && !want.reply) { it.status = "skipped"; it.error = "No action ticked"; touch(it); continue; }
    it.status = "posting"; it.error = ""; touch(it);
    const t0 = Date.now();
    let r;
    try {
      // 1. open the post
      setStatus(`Opening ${k + 1}/${items.length}: @${it.handle || "post"}${left()}`);
      await withWorker(() => openPost(it));
      const openMs = Date.now() - t0;
      // 2. wait ON the post (it finishes loading; looks like reading), then act
      let gap;
      if (finish) {
        const budget = (deadline - Date.now() - workAvg * (items.length - k - 1) - Math.max(0, workAvg - openMs)) / 1000;
        const share = weights.slice(k).reduce((a, b) => a + b, 0);
        gap = budget > 0 ? (budget * weights[k]) / share : rand(1, 3);
      } else gap = rand(Number(ap.minGap), Number(ap.maxGap));
      await wait(Math.max(1, gap) * slow, `On @${it.handle || "post"}'s post · acting in`, left);
      if (paused) { it.status = "ready"; touch(it); break; }
      const t1 = Date.now();
      // 3. like / repost / reply
      r = await withWorker(async () => {
        let res = await send({ type: "apAct", id: it.id, want });
        if (!res.ok && res.needFocus) {
          // the reply box needs the window in front: bring it forward once and try again
          await chrome.windows.update(workerWin, { focused: true });
          await sleep(600);
          res = await send({ type: "apAct", id: it.id, want: { ...want, like: false, repost: false } });
          res.done = { ...(res.done || {}), like: want.like, repost: want.repost };
        }
        return res;
      });
      workAvg = (workAvg * workN + openMs + (Date.now() - t1)) / ++workN;
    } catch (e) { r = { ok: false, error: e.message }; }

    if (r.ok) {
      it.status = "done"; it.doneAt = Date.now(); n++;
      if (r.already) it.warn = ["You'd already replied to this post, so the reply wasn't sent again."];
      touch(it);
      const { apDone = {} } = await chrome.storage.local.get("apDone");
      apDone[it.id] = { at: it.doneAt, like: want.like, repost: want.repost, reply: !!want.reply };
      await chrome.storage.local.set({ apDone });
      if (want.reply && !r.already) await bumpCount();
      log(`✓ @${it.handle}` + [want.like && " liked", want.repost && " reposted", want.reply && (r.already ? " already replied" : " replied")].filter(Boolean).join(","), "ok");
    } else if (r.xError) {
      errors++;
      it.status = "ready"; it.error = "X: " + r.xError; touch(it);
      log(`X showed an error: ${r.xError}`, "e");
      if (errors >= 2) { paused = true; setBusy(""); return setStatus("X showed errors twice, so Autopilot paused. Wait a while before continuing."); }
      slow = 2; deadline += 600e3;
      await wait(600, "X pushed back. Resting");
      continue;
    } else {
      const stop = stopFor(r.error || "");
      it.status = stop ? "ready" : "failed"; it.error = (r.error || "Something went wrong.").replace(/^\w+: /, ""); touch(it);
      log(`✗ @${it.handle}: ${it.error}`, "e");
      if (stop) { paused = true; setBusy(""); return setStatus(stop); }
    }
    // gap mode: a longer rest every few posts
    if (!finish && k < items.length - 1 && !paused && n && n % ap.restEvery === 0) await wait(ap.restMinutes * 60, `Resting after ${n}.`, left);
  }
  setBusy("");
  log(`Finished: ${n} done`, "ok");
  if (paused) return setStatus("Paused.");
  setStatus(`Done: ${n} posted.`);
  if (ap.keepGoing) nextRound();
}

async function collectMore(thenWrite) {
  if (!collectorTab) return setStatus("Open X and press 🤖 → Collect there once; after that Autopilot can collect more from the same page.");
  setStatus("Collecting on X…");
  writeAfterCollect = thenWrite;
  try {
    const r = await chrome.tabs.sendMessage(collectorTab, { type: "apCollect", n: Number(ap.batchSize) });
    if (!r?.added) { writeAfterCollect = false; setStatus("No new posts found on that page."); }
    else if (!thenWrite) setStatus(`Collected ${r.added} posts.`);
  } catch (_) {
    writeAfterCollect = false;
    setStatus("The X tab you collected from was closed. Open X and press 🤖 → Collect.");
  }
}
function nextRound() {
  if (queue.some(i => i.status === "queued")) return writeBatch();
  return collectMore(true);
}

// ---------- commands from the control center ----------
function setAction(it, k, on) {
  it.actions[k] = on;
  // turning Reply on for a post with no reply yet sends it back to be written
  if (k === "reply" && on && it.status === "ready" && !it.drafts?.length) { it.status = "queued"; it.include = false; it.warn = ["Reply turned on: press Write replies to write one."]; }
  touch(it);
}
const find = id => queue.find(i => i.id === id);

export async function command(msg) {
  await ready;
  switch (msg.op) {
    case "write": writeBatch(); return { ok: true };
    case "post": postApproved(); return { ok: true };
    case "pause": if (busy) { paused = true; setStatus("Pausing after the current step…"); } return { ok: true };
    case "collect": collectMore(false); return { ok: true };
    case "add": return { ok: true, ...(await addItems(msg.items || [])) };
    case "edit": {
      const it = find(msg.id); if (!it) return { ok: false };
      Object.assign(it, msg.patch);
      if (msg.bump) touch(it); else save();
      return { ok: true };
    }
    case "action": for (const id of msg.ids) { const it = find(id); if (it && ["queued", "ready"].includes(it.status)) setAction(it, msg.key, msg.on); } return { ok: true };
    case "tick": for (const id of msg.ids) { const it = find(id); if (it?.status === "ready") { it.include = msg.on; touch(it); } } return { ok: true };
    case "remove": queue = queue.filter(i => !msg.ids.includes(i.id) || i.status === "posting"); await saveNow(); return { ok: true };
    case "rewrite": { // write this post again in the other style
      const it = find(msg.id);
      if (!it?.post || it.status !== "ready") return { ok: false, error: "Only posts on the review screen can be rewritten." };
      it.status = "writing"; touch(it);
      try { await writeAndPick(it, msg.mode); it.status = "ready"; }
      catch (e) { it.status = "ready"; it.error = e.message; }
      touch(it);
      return { ok: true };
    }
    case "retry": { const it = find(msg.id); if (it) { it.status = "queued"; it.error = ""; touch(it); } return { ok: true }; }
    case "clearFinished": queue = queue.filter(i => !FINISHED.includes(i.status)); await saveNow(); return { ok: true };
    case "clearQueue":
      if (busy) return { ok: false, error: "Pause first." };
      queue = queue.filter(i => FINISHED.includes(i.status)); await saveNow(); return { ok: true };
    case "status": return { ok: true, text: statusText, busy, paused };
  }
  return { ok: false, error: "Unknown command" };
}
export { drainInbox, ready };
