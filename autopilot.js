// Autopilot control center.
// Queue → (read each post in the working window → describe pictures once → Gemini writes → Claude picks)
// → you review → Continue → it likes / reposts / replies one by one with random gaps and rests.
import { describe, write, review, styleProblems } from "./ai.js";

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);
const D = self.AP_DEFAULTS;

let ap = structuredClone(D);
let queue = [];
let logLines = [];
let busy = ""; // "", "writing", "posting"
let paused = false;
let tab = "review";
let collectorTab = null;
let writeAfterCollect = false;

// ---------- saving ----------
async function loadAll() {
  const st = await chrome.storage.local.get(["apSettings", "apQueue", "apLog", "apCollectorTab"]);
  const s = st.apSettings || {};
  ap = { ...structuredClone(D), ...s, types: { ...D.types, ...(s.types || {}) }, defaultActions: { ...structuredClone(D.defaultActions), ...(s.defaultActions || {}) } };
  queue = (st.apQueue || []).map(i => ({ ...i, status: ["reading", "writing"].includes(i.status) ? "queued" : i.status === "posting" ? "ready" : i.status }));
  logLines = st.apLog || [];
  collectorTab = st.apCollectorTab || null;
}
const saveSettings = () => chrome.storage.local.set({ apSettings: ap });
let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer);
  const slim = queue.map(i => (["done", "skipped", "failed"].includes(i.status) ? { ...i, post: undefined, drafts: undefined } : i));
  return chrome.storage.local.set({ apQueue: slim, apLog: logLines.slice(-400) });
}
function saveQueue() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}
window.addEventListener("pagehide", saveNow);
function log(msg, cls = "") {
  logLines.push({ t: new Date().toLocaleTimeString(), msg, cls });
  if (tab === "log") renderLog();
  saveQueue();
}
function setStatus(text, isBusy = !!busy) {
  $("#status").textContent = text;
  $("#status").classList.toggle("busy", isBusy);
  document.title = (isBusy ? "⏳ " : "") + "Autopilot";
}
function touch(it) { it._v = (it._v || 0) + 1; scheduleRender(); saveQueue(); }

// ---------- adding posts ----------
async function doneIds() { return (await chrome.storage.local.get("apDone")).apDone || {}; }
async function addItems(items) {
  const done = await doneIds();
  const have = new Set(queue.map(i => i.id));
  let added = 0, dup = 0;
  for (const x of items) {
    if (!x?.id || have.has(x.id) || done[x.id]) { dup++; continue; }
    have.add(x.id);
    const it = {
      id: x.id, url: x.url || `https://x.com/i/status/${x.id}`, handle: x.handle || "", text: x.text || "", thumb: x.thumb || "", type: x.type || "",
      source: x.source || "link", fav: !!x.fav, actions: { ...(x.actions || ap.defaultActions[x.source] || ap.defaultActions.link) },
      status: "queued", added: Date.now(), warn: []
    };
    if (it.fav) queue.unshift(it); else queue.push(it);
    added++;
  }
  if (added || dup) log(`Added ${added} to the queue` + (dup ? ` (${dup} already in the queue or done)` : ""));
  scheduleRender(); saveQueue();
  return added;
}
async function drainInbox() {
  const { apInbox = [] } = await chrome.storage.local.get("apInbox");
  if (!apInbox.length) return;
  await chrome.storage.local.set({ apInbox: [] });
  const n = await addItems(apInbox);
  if (writeAfterCollect) { writeAfterCollect = false; if (n) writeBatch(); else { log("Nothing new to collect. Keep going stopped."); setStatus("Idle"); } }
}
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  if (ch.apInbox) drainInbox();
  if (ch.apCollectorTab) collectorTab = ch.apCollectorTab.newValue;
  if (ch.counts) renderCount();
});

const LINK_RE = /(?:x|twitter)\.com\/([A-Za-z0-9_]{1,20})\/status\/(\d{5,25})/gi;
function linksFromText(text, source) {
  const out = [];
  for (const m of text.matchAll(LINK_RE)) out.push({ id: m[2], handle: m[1], url: `https://x.com/${m[1]}/status/${m[2]}`, source, actions: readActs("#linkActs") });
  return out;
}

// ---------- the working window ----------
let workerTab = null, workerWin = null;
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
  if (workerTab) { try { await chrome.tabs.get(workerTab); return; } catch (_) { workerTab = null; } }
  const w = await chrome.windows.create({ url: "https://x.com/home", focused: false, width: 560, height: 900, left: 20, top: 20 });
  workerWin = w.id; workerTab = w.tabs[0].id;
  log("Opened the working window. Keep it open (don't minimise it) while Autopilot runs.");
  await waitLoad(workerTab);
}
async function send(msg, ms = 60000) {
  for (let i = 0; i < 20; i++) {
    try {
      return await Promise.race([chrome.tabs.sendMessage(workerTab, msg), sleep(ms).then(() => ({ ok: false, error: "The working window took too long." }))]);
    } catch (e) {
      if (!/Receiving end|Could not establish/i.test(e.message)) throw e;
      await sleep(500); // the page is still loading
    }
  }
  throw new Error("The working window isn't responding. Reload it.");
}
async function openPost(it) {
  await ensureWorker();
  await chrome.tabs.update(workerTab, { url: it.url });
  await waitLoad(workerTab);
  await send({ type: "apPing" }, 5000);
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
  if (p.type === "video" && !it.understood && ap.grok && (await grokLeft()) > 0) {
    setStatus(`Asking Grok about @${it.handle}'s video…`);
    const g = await withWorker(async () => { await openPost(it); return send({ type: "apGrok", id: it.id }, 70000); }).catch(e => ({ ok: false, error: e.message }));
    if (g.ok) { it.grok = g.text; it.understood = true; await useGrok(); }
    else it.warn.push("Grok: " + g.error);
  }

  const w = await write(it, ap);
  it.drafts = w.replies; it.via = w.via;
  if (w.skip) it.skipReason = w.reason || "AI suggests skipping";
  if (!it.drafts.length) throw new Error(it.skipReason || "The writer sent no replies.");

  let scores = it.drafts.map(() => 7), notes = [], best = 0;
  try {
    const r = await review(it, it.drafts, ap);
    scores = it.drafts.map((_, i) => r.scores[i] || 5); notes = r.notes; best = r.best;
    it.via += " → " + r.via;
  } catch (e) { it.warn.push("Reviewer unavailable: " + e.message); }
  // our own free check for AI-sounding writing
  it.issues = it.drafts.map(d => styleProblems(d, ap));
  scores = scores.map((s, i) => Math.max(1, s - 2 * it.issues[i].length));
  best = scores.indexOf(Math.max(...scores));
  it.scores = scores; it.notes = notes; it.best = best;
  it.reply = it.drafts[best];
  it.score = scores[best];

  if (!it.understood) it.warn.push(`Not sure what's in the ${p.type === "video" ? "video" : "picture"}.`);
  if (it.skipReason) it.warn.push("Suggest skipping: " + it.skipReason);
  it.include = !it.skipReason && it.understood && it.score >= ap.passScore;
}

async function writeBatch() {
  if (busy) return;
  const items = queue.filter(i => i.status === "queued").slice(0, Number(ap.batchSize));
  if (!items.length) { setStatus("The queue is empty. Collect posts on X or paste links."); return; }
  busy = "writing"; paused = false; render();
  const lim = limiter(2);
  const jobs = [];
  let n = 0;
  log(`Writing replies for ${items.length} posts`);
  for (const it of items) {
    if (paused) break;
    if (!it.actions.reply) { it.status = "ready"; it.include = true; touch(it); n++; continue; }
    it.status = "reading"; touch(it);
    setStatus(`Reading ${++n}/${items.length}: @${it.handle || "post"}`);
    try {
      const r = await withWorker(async () => {
        await openPost(it);
        return send({ type: "apRead", id: it.id, opts: { readReplies: ap.readReplies, frames: ap.images && ap.videoFrames } });
      });
      if (!r.ok) throw new Error(r.error);
      it.post = r.post;
      Object.assign(it, { handle: r.post.handle, text: r.post.text, thumb: r.post.thumb || it.thumb, type: r.post.type, url: r.post.url || it.url });
      if (it.handle.toLowerCase() === String(ap.myHandle).toLowerCase().replace(/^@/, "")) { it.status = "skipped"; it.error = "Your own post"; touch(it); continue; }
      it.status = "writing"; touch(it);
      jobs.push(lim(async () => {
        try { await think(it); it.status = "ready"; }
        catch (e) { it.status = "failed"; it.error = e.message; log(`@${it.handle}: ${e.message}`, "e"); }
        touch(it);
      }));
    } catch (e) {
      it.status = "failed"; it.error = e.message; touch(it);
      log(`Couldn't read ${it.url}: ${e.message}`, "e");
      if (/^login/.test(e.message)) { paused = true; setStatus("X logged you out in the working window. Log in there, then press Write replies.", false); break; }
    }
  }
  setStatus("Finishing the replies…");
  await Promise.all(jobs);
  busy = "";
  const ready = queue.filter(i => i.status === "ready");
  log(`Batch written: ${ready.filter(i => i.include).length} ticked, ${ready.filter(i => !i.include).length} unticked for you to check`, "ok");
  setStatus(paused ? "Paused." : "Ready to review. Untick or edit anything, then press Continue.", false);
  tab = "review"; render();
  try { chrome.windows.update((await chrome.windows.getCurrent()).id, { drawAttention: true }); } catch (_) {}
}

// ---------- step 3: post ----------
async function bumpCount() {
  const { counts = {} } = await chrome.storage.local.get("counts");
  counts[today()] = (counts[today()] || 0) + 1;
  await chrome.storage.local.set({ counts });
}
async function wait(sec, label) {
  const end = Date.now() + sec * 1000;
  while (Date.now() < end && !paused) {
    setStatus(`${label} ${Math.ceil((end - Date.now()) / 1000)}s`);
    await sleep(500);
  }
}
const rand = (a, b) => a + Math.random() * Math.max(0, b - a);

async function postApproved() {
  if (busy) return;
  const items = queue.filter(i => i.status === "ready" && i.include);
  if (!items.length) { setStatus("Nothing ticked to post."); return; }
  busy = "posting"; paused = false; render();
  log(`Posting ${items.length}`);
  let n = 0, errors = 0, slow = 1;
  for (let k = 0; k < items.length && !paused; k++) {
    const it = items[k];
    const want = { like: !!it.actions.like, repost: !!it.actions.repost, reply: it.actions.reply ? (it.reply || "").trim() : "" };
    if (!want.like && !want.repost && !want.reply) { it.status = "skipped"; it.error = "No action ticked"; touch(it); continue; }
    it.status = "posting"; touch(it);
    setStatus(`Posting ${k + 1}/${items.length}: @${it.handle || "post"}`);
    let r;
    try {
      r = await withWorker(async () => {
        await openPost(it);
        let res = await send({ type: "apAct", id: it.id, want });
        if (!res.ok && res.needFocus) {
          // the box needs the window in front: bring it forward once and try again
          await chrome.windows.update(workerWin, { focused: true });
          await sleep(600);
          res = await send({ type: "apAct", id: it.id, want: { ...want, like: false, repost: false } });
          res.done = { ...(res.done || {}), like: want.like, repost: want.repost };
        }
        return res;
      });
    } catch (e) { r = { ok: false, error: e.message }; }

    if (r.ok) {
      it.status = "done"; it.doneAt = Date.now(); touch(it); n++;
      const { apDone = {} } = await chrome.storage.local.get("apDone");
      apDone[it.id] = { at: it.doneAt, ...want, reply: !!want.reply };
      await chrome.storage.local.set({ apDone });
      if (want.reply) await bumpCount();
      log(`✓ @${it.handle}` + [want.like && " liked", want.repost && " reposted", want.reply && " replied"].filter(Boolean).join(","), "ok");
    } else if (r.xError) {
      errors++;
      it.status = "ready"; it.error = "X: " + r.xError; touch(it);
      log(`X showed an error: ${r.xError}`, "e");
      if (errors >= 2) { paused = true; setStatus("X showed errors twice, so Autopilot paused. Wait a while before continuing.", false); break; }
      slow = 2;
      await wait(600, "X pushed back. Resting");
      continue;
    } else {
      it.status = "failed"; it.error = r.error || "Something went wrong."; touch(it);
      log(`✗ @${it.handle}: ${it.error}`, "e");
      if (/^login/.test(it.error)) { paused = true; setStatus("Log in to X in the working window, then press Continue.", false); break; }
    }
    if (k < items.length - 1 && !paused) {
      if (n && n % ap.restEvery === 0) await wait(ap.restMinutes * 60, `Resting after ${n}.`);
      else await wait(rand(Number(ap.minGap), Number(ap.maxGap)) * slow, "Next one in");
    }
  }
  busy = "";
  log(`Finished: ${n} done`, "ok");
  render();
  if (paused) { if (!/X showed|Log in/.test($("#status").textContent)) setStatus("Paused.", false); return; }
  setStatus(`Done: ${n} posted.`, false);
  if (ap.keepGoing) nextRound();
}

async function nextRound() {
  if (queue.some(i => i.status === "queued")) return writeBatch();
  if (!collectorTab) { setStatus("Keep going: press 🤖 Collect on X once so Autopilot knows which page to collect from.", false); return; }
  setStatus("Collecting the next batch on X…", true);
  writeAfterCollect = true;
  try {
    const r = await chrome.tabs.sendMessage(collectorTab, { type: "apCollect", n: Number(ap.batchSize) });
    if (!r?.added) { writeAfterCollect = false; setStatus("No new posts matched your filters on that page. Keep going stopped.", false); }
  } catch (_) {
    writeAfterCollect = false;
    setStatus("The X tab you collected from was closed. Open X and press 🤖 Collect.", false);
  }
}

// ---------- drawing the page ----------
let renderQueued = false;
function scheduleRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); } }

const inTab = i => (tab === "review" ? i.status === "ready" : tab === "queue" ? ["queued", "reading", "writing", "posting"].includes(i.status) : tab === "done" ? ["done", "skipped", "failed"].includes(i.status) : false);
const STATUS_TEXT = { queued: "Waiting", reading: "Reading…", writing: "Writing…", ready: "Ready", posting: "Posting…", done: "Done", skipped: "Skipped", failed: "Failed" };
const cards = new Map();

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null && k !== false) e.append(k);
  return e;
}
function actBoxes(actions, onChange) {
  const wrap = el("div", { className: "row acts" });
  for (const k of ["reply", "like", "repost"]) {
    const cb = el("input", { type: "checkbox", checked: !!actions[k] });
    cb.onchange = () => { actions[k] = cb.checked; onChange && onChange(); };
    wrap.append(el("label", { className: "check" }, cb, k[0].toUpperCase() + k.slice(1)));
  }
  return wrap;
}
function readActs(sel) {
  const out = {};
  document.querySelectorAll(sel + " input").forEach((cb, i) => { out[["reply", "like", "repost"][i]] = cb.checked; });
  return out;
}

function card(it) {
  const c = el("div", { className: "card" + (it.status === "ready" && !it.include ? " out" : "") });
  const tick = el("input", { type: "checkbox", className: "tick", checked: !!it.include, disabled: it.status !== "ready", title: "Post this one" });
  tick.onchange = () => { it.include = tick.checked; c.classList.toggle("out", !tick.checked); saveQueue(); renderCounts(); };
  const x = el("button", { className: "x", textContent: "✕", title: "Remove from queue" });
  x.onclick = () => { queue = queue.filter(q => q !== it); cards.delete(it.id); render(); saveQueue(); };
  const head = el("div", { className: "head" },
    el("a", { className: "who", href: it.url, target: "_blank", textContent: "@" + (it.handle || "post") }),
    it.type && el("span", { className: "tag", textContent: it.type }),
    el("span", { className: "tag", textContent: it.source === "group" ? "chat link" : it.source }),
    el("span", { className: "tag st-" + it.status, textContent: STATUS_TEXT[it.status] }),
    it.score != null && it.actions.reply && el("span", { className: "tag score" + (it.score < ap.passScore ? " low" : ""), textContent: `${it.score}/10` }),
    it.fav && el("span", { className: "tag", textContent: "★ favourite" }),
    x
  );
  const body = el("div", { className: "body" },
    it.thumb && el("img", { src: it.thumb, alt: "", loading: "lazy" }),
    el("div", {}, el("div", { className: "ptext", textContent: it.text || (it.post ? "(no text)" : it.actions.reply ? "Not read yet." : "Like / repost only, so it isn't read.") }),
      it.desc && el("div", { className: "desc", textContent: "🖼 " + it.desc }),
      it.grok && el("div", { className: "desc", textContent: "Grok: " + it.grok.slice(0, 300) + (it.grok.length > 300 ? "…" : "") }))
  );
  const main = el("div", {}, head, body);
  (it.warn || []).forEach(w => main.append(el("div", { className: "warn", textContent: "⚠ " + w })));
  if (it.error) main.append(el("div", { className: "err", textContent: it.error }));

  if (it.status === "ready" && it.actions.reply && it.drafts?.length) {
    const ta = el("textarea", { className: "reply", value: it.reply || "" });
    ta.oninput = () => { it.reply = ta.value; saveQueue(); };
    main.append(ta);
    const alts = el("div", { className: "alts" });
    it.drafts.forEach((d, i) => {
      if (d === it.reply) return;
      const b = el("button", { className: "alt", textContent: `${it.scores?.[i] ?? ""}/10 · ${d}`, title: "Use this draft instead" });
      b.onclick = () => { it.reply = d; it.score = it.scores?.[i]; touch(it); };
      alts.append(b);
    });
    main.append(alts);
  } else if (it.reply && ["done", "posting"].includes(it.status) && it.actions.reply) {
    main.append(el("div", { className: "desc", textContent: "↳ " + it.reply }));
  }
  const foot = el("div", { className: "foot" });
  if (["queued", "ready"].includes(it.status)) foot.append(actBoxes(it.actions, () => { saveQueue(); }));
  const note = it.notes?.[it.drafts?.indexOf(it.reply)] || "";
  if (it.via || note) foot.append(el("span", { className: "note", textContent: [it.via, note].filter(Boolean).join(" · ") }));
  if (["failed", "skipped"].includes(it.status)) {
    const again = el("button", { className: "ghost", textContent: "Try again" });
    again.onclick = () => { it.status = "queued"; it.error = ""; touch(it); };
    foot.append(again);
  }
  main.append(foot);
  c.append(tick, main);
  return c;
}

function renderCounts() {
  const n = s => queue.filter(i => s.includes(i.status)).length;
  const ready = queue.filter(i => i.status === "ready");
  document.querySelector('[data-tab="review"] span').textContent = ready.length;
  document.querySelector('[data-tab="queue"] span').textContent = n(["queued", "reading", "writing", "posting"]);
  document.querySelector('[data-tab="done"] span').textContent = n(["done", "skipped", "failed"]);
  const ticked = ready.filter(i => i.include).length;
  $("#postBtn").textContent = ticked ? `Continue: post ${ticked}` : "Continue";
  $("#postBtn").disabled = !!busy || !ticked;
  $("#writeBtn").disabled = !!busy || !queue.some(i => i.status === "queued");
  $("#writeBtn").textContent = `Write replies (${Math.min(Number(ap.batchSize), n(["queued"]))})`;
  $("#pauseBtn").textContent = busy ? (paused ? "Pausing…" : "Pause") : "Pause";
  $("#pauseBtn").disabled = !busy;
}
async function renderCount() {
  const { counts = {} } = await chrome.storage.local.get("counts");
  const { goal = 300 } = await chrome.storage.sync.get("goal");
  $("#count").textContent = `Replies today: ${counts[today()] || 0} / ${goal}`;
}
function renderLog() {
  $("#log").replaceChildren(...logLines.slice(-300).reverse().map(l => el("div", { className: l.cls, textContent: `${l.t}  ${l.msg}` })));
}
function render() {
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  $("#log").hidden = tab !== "log";
  $("#list").hidden = $("#bulk").hidden = tab === "log";
  renderCounts();
  if (tab === "log") { renderLog(); $("#empty").textContent = ""; return; }
  const items = queue.filter(inTab);
  const nodes = items.map(it => {
    const c = cards.get(it.id);
    if (c && c.v === it._v && c.st === it.status && c.inc === it.include) return c.el;
    const e = card(it);
    cards.set(it.id, { el: e, v: it._v, st: it.status, inc: it.include });
    return e;
  });
  const list = $("#list");
  // keep the box you're typing in untouched
  nodes.forEach((nd, i) => { if (list.children[i] !== nd) list.insertBefore(nd, list.children[i] || null); });
  while (list.children.length > nodes.length) list.lastChild.remove();
  $("#empty").textContent = items.length ? "" :
    tab === "review" ? "Nothing to review yet. Add posts (🤖 Collect or ➕ on X, chat links, or paste links), then press Write replies." :
    tab === "queue" ? "The queue is empty." : "Nothing finished yet.";
}

// ---------- settings panel ----------
const getK = k => k.split(".").reduce((o, p) => o?.[p], ap);
function setK(k, v) { const ps = k.split("."); const last = ps.pop(); ps.reduce((o, p) => (o[p] = o[p] || {}), ap)[last] = v; }
function bindSettings() {
  document.querySelectorAll("[data-k]").forEach(inp => {
    const k = inp.dataset.k;
    const v = getK(k);
    if (inp.type === "checkbox") inp.checked = !!v; else inp.value = v ?? "";
    inp.onchange = () => {
      setK(k, inp.type === "checkbox" ? inp.checked : inp.type === "number" || k === "batchSize" ? Number(inp.value) : inp.value);
      saveSettings(); renderCounts();
    };
  });
  const topics = $("#topics");
  topics.replaceChildren(...Object.entries(self.AP_TOPICS).map(([key, t]) => {
    const b = el("button", { className: "chip" + (ap.topics.includes(key) ? " on" : ""), textContent: t.label });
    b.onclick = () => {
      ap.topics = ap.topics.includes(key) ? ap.topics.filter(x => x !== key) : [...ap.topics, key];
      b.classList.toggle("on"); saveSettings();
    };
    return b;
  }));
  const names = { feed: "Collected", picked: "➕ picked", link: "Pasted links", group: "Chat links" };
  $("#defaults").replaceChildren(...Object.keys(names).map(src => {
    const row = el("div", { className: "defrow" }, el("b", { textContent: names[src] }));
    row.append(actBoxes(ap.defaultActions[src], saveSettings));
    return row;
  }));
  $("#linkActs").replaceChildren(...actBoxes({ ...ap.defaultActions.link }).childNodes);
}

// ---------- buttons ----------
$("#writeBtn").onclick = writeBatch;
$("#postBtn").onclick = postApproved;
$("#pauseBtn").onclick = () => { paused = true; renderCounts(); setStatus("Pausing after the current step…"); };
$("#collectBtn").onclick = () => { writeAfterCollect = false; nextRoundCollectOnly(); };
async function nextRoundCollectOnly() {
  if (!collectorTab) return setStatus("Open X and press 🤖 Collect there once; after that this button collects more from the same page.", false);
  setStatus("Collecting on X…", true);
  try { const r = await chrome.tabs.sendMessage(collectorTab, { type: "apCollect", n: Number(ap.batchSize) }); setStatus(`Collected ${r?.added || 0} posts.`, false); }
  catch (_) { setStatus("That X tab was closed. Open X and press 🤖 Collect.", false); }
}
$("#addLinks").onclick = async () => {
  const items = linksFromText($("#links").value, "link");
  if (!items.length) return setStatus("No X post links found in that text.", false);
  const n = await addItems(items);
  $("#links").value = "";
  setStatus(`Added ${n} links.`, false);
  tab = "queue"; render();
};
$("#linkFile").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const n = await addItems(linksFromText(await f.text(), "link"));
  setStatus(`Added ${n} links from ${f.name}.`, false);
  e.target.value = ""; tab = "queue"; render();
};
document.querySelectorAll("#tabs button").forEach(b => { b.onclick = () => { tab = b.dataset.tab; render(); }; });
$("#tickAll").onclick = () => { queue.filter(i => i.status === "ready").forEach(i => { i.include = true; touch(i); }); };
$("#untickAll").onclick = () => { queue.filter(i => i.status === "ready").forEach(i => { i.include = false; touch(i); }); };
$("#clearDone").onclick = () => { queue = queue.filter(i => !["done", "skipped", "failed"].includes(i.status)); render(); saveQueue(); };
$("#clearQueue").onclick = () => {
  if (busy) return setStatus("Pause first.", false);
  if (!confirm("Remove everything that hasn't been posted yet?")) return;
  queue = queue.filter(i => ["done", "skipped", "failed"].includes(i.status)); render(); saveQueue();
};
window.addEventListener("beforeunload", e => { if (busy) { e.preventDefault(); e.returnValue = ""; } });

// ---------- start ----------
await loadAll();
bindSettings();
render();
renderCount();
await drainInbox();
setStatus(queue.some(i => i.status === "ready") ? "Ready to review." : "Idle", false);
