// Autopilot control center: shows the queue and sends commands.
// The work itself runs in the extension's background (engine.js), so closing or hiding this tab doesn't stop it.
const $ = s => document.querySelector(s);
const today = () => new Date().toISOString().slice(0, 10);
const D = self.AP_DEFAULTS;
const FINISHED = ["done", "skipped", "failed"];
const WORK_SEC = 6;
const fmtMin = sec => (sec >= 90 ? `${Math.round(sec / 60)} min` : `${Math.round(sec)} s`);

let ap = structuredClone(D);
let queue = [];
let logLines = [];
let filteredList = [];
let status = { text: "Idle", busy: "", paused: false };
let tab = "review";

const cmd = (op, extra = {}) => chrome.runtime.sendMessage({ type: "ap", op, ...extra }).catch(e => ({ ok: false, error: e.message }));

// ---------- data from storage ----------
function mergeSettings(s = {}) {
  return { ...structuredClone(D), ...s, types: { ...D.types, ...(s.types || {}) }, filters: { ...D.filters, ...(s.filters || {}) }, defaultActions: { ...structuredClone(D.defaultActions), ...(s.defaultActions || {}) } };
}
async function loadAll() {
  const st = await chrome.storage.local.get(["apSettings", "apQueue", "apLog", "apFiltered"]);
  ap = mergeSettings(st.apSettings);
  queue = st.apQueue || [];
  logLines = st.apLog || [];
  filteredList = st.apFiltered || [];
  status = (await chrome.storage.session.get("apStatus")).apStatus || status;
}
const saveSettings = () => chrome.storage.local.set({ apSettings: ap });

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "session" && ch.apStatus) {
    status = ch.apStatus.newValue || status;
    if (/^Ready to review/.test(status.text) && tab === "queue") { tab = "review"; scheduleRender(); } // batch written: show it
    renderStatus(); renderCounts(); return;
  }
  if (area !== "local") return;
  if (ch.apQueue) { queue = ch.apQueue.newValue || []; scheduleRender(); }
  if (ch.apLog) { logLines = ch.apLog.newValue || []; if (tab === "log") renderLog(); }
  if (ch.apFiltered) { filteredList = ch.apFiltered.newValue || []; scheduleRender(); }
  if (ch.apSettings) { ap = mergeSettings(ch.apSettings.newValue); }
  if (ch.counts || ch.apUsage) renderCount();
});

function setStatus(text) { status = { ...status, text }; renderStatus(); }
function renderStatus() {
  $("#status").textContent = status.text;
  $("#status").classList.toggle("busy", !!status.busy);
  document.title = (status.busy ? "⏳ " : "") + "Autopilot";
}

const LINK_RE = /(?:x|twitter)\.com\/([A-Za-z0-9_]{1,20})\/status\/(\d{5,25})/gi;
function linksFromText(text) {
  const acts = readActs("#linkActs");
  return [...text.matchAll(LINK_RE)].map(m => ({ id: m[2], handle: m[1], url: `https://x.com/${m[1]}/status/${m[2]}`, source: "link", actions: { ...acts } }));
}

// ---------- drawing ----------
let renderQueued = false;
function scheduleRender() { if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; render(); }); } }
const inTab = i => (tab === "review" ? i.status === "ready" : tab === "queue" ? ["queued", "reading", "writing", "posting"].includes(i.status) : tab === "done" ? FINISHED.includes(i.status) : false);
const STATUS_TEXT = { queued: "Waiting", reading: "Reading…", writing: "Writing…", ready: "Ready", posting: "Posting…", done: "Done", skipped: "Skipped", failed: "Failed" };
const cards = new Map();

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null && k !== false && k !== "") e.append(k);
  return e;
}
function actBoxes(actions, onChange) {
  const wrap = el("div", { className: "row acts" });
  for (const k of ["reply", "like", "repost"]) {
    const cb = el("input", { type: "checkbox", checked: !!actions[k] });
    cb.onchange = () => { actions[k] = cb.checked; onChange && onChange(k, cb.checked); };
    wrap.append(el("label", { className: "check" }, cb, k[0].toUpperCase() + k.slice(1)));
  }
  return wrap;
}
function readActs(sel) {
  const out = {};
  document.querySelectorAll(sel + " input").forEach((cb, i) => { out[["reply", "like", "repost"][i]] = cb.checked; });
  return out;
}

let typing = null;
function card(it) {
  const c = el("div", { className: "card" + (it.status === "ready" && !it.include ? " out" : "") });
  const tick = el("input", { type: "checkbox", className: "tick", checked: !!it.include, disabled: it.status !== "ready", title: "Post this one" });
  tick.onchange = () => cmd("tick", { ids: [it.id], on: tick.checked });
  const x = el("button", { className: "x", textContent: "✕", title: "Remove from queue" });
  x.onclick = () => cmd("remove", { ids: [it.id] });
  const head = el("div", { className: "head" },
    el("a", { className: "who", href: it.url, target: "_blank", textContent: "@" + (it.handle || "post") }),
    it.type && el("span", { className: "tag", textContent: it.type }),
    el("span", { className: "tag", textContent: it.source === "group" ? "chat link" : it.source }),
    el("span", { className: "tag st-" + it.status, textContent: STATUS_TEXT[it.status] }),
    it.mode && it.actions.reply && el("span", { className: "tag mode-" + it.mode, textContent: it.mode === "reaction" ? "Reaction" : "Opinion" }),
    it.score != null && it.actions.reply && el("span", { className: "tag score" + (it.score < ap.passScore ? " low" : ""), textContent: `${it.score}/10` }),
    it.fav && el("span", { className: "tag", textContent: "★ favourite" }),
    it.status !== "posting" && x
  );
  const body = el("div", { className: "body" },
    it.thumb && el("img", { src: it.thumb, alt: "", loading: "lazy" }),
    el("div", { className: "bodytext" }, el("div", { className: "ptext", textContent: it.text || (it.post ? "(no text)" : it.actions.reply ? "Not read yet." : "Like / repost only, so it isn't read.") }),
      it.desc && el("div", { className: "desc", textContent: "🖼 " + it.desc }),
      it.grok && el("div", { className: "desc", textContent: "Grok: " + it.grok.slice(0, 300) + (it.grok.length > 300 ? "…" : "") }))
  );
  const main = el("div", { className: "cmain" }, head, body);
  (it.warn || []).forEach(w => main.append(el("div", { className: "warn", textContent: "⚠ " + w })));
  if (it.error) main.append(el("div", { className: "err", textContent: it.error }));

  if (it.status === "ready" && it.actions.reply && it.drafts?.length) {
    const ta = el("textarea", { className: "reply", value: it.reply || "" });
    ta.oninput = () => { clearTimeout(typing); typing = setTimeout(() => cmd("edit", { id: it.id, patch: { reply: ta.value } }), 300); };
    main.append(ta);
    const alts = el("div", { className: "alts" });
    it.drafts.forEach((d, i) => {
      if (d === it.reply) return;
      const b = el("button", { className: "alt", textContent: `${it.scores?.[i] ?? ""}/10 · ${d}`, title: "Use this draft instead" });
      b.onclick = () => cmd("edit", { id: it.id, patch: { reply: d, score: it.scores?.[i] }, bump: true });
      alts.append(b);
    });
    main.append(alts);
  } else if (it.reply && ["done", "posting"].includes(it.status) && it.actions.reply) {
    main.append(el("div", { className: "desc", textContent: "↳ " + it.reply }));
  }
  const foot = el("div", { className: "foot" });
  if (["queued", "ready"].includes(it.status)) foot.append(actBoxes({ ...it.actions }, (k, on) => cmd("action", { ids: [it.id], key: k, on })));
  if (it.status === "ready" && it.actions.reply && it.drafts?.length) {
    const other = it.mode === "reaction" ? "opinion" : "reaction";
    const rw = el("button", { className: "ghost", textContent: `Rewrite as ${other}` });
    rw.onclick = () => { rw.disabled = true; rw.textContent = "Rewriting…"; cmd("rewrite", { id: it.id, mode: other }); };
    foot.append(rw);
  }
  const iss = it.issues?.[it.drafts?.indexOf(it.reply)] || [];
  const note = [it.notes?.[it.drafts?.indexOf(it.reply)], iss.length ? "check: " + iss.join(", ") : ""].filter(Boolean).join(" · ");
  if (it.via || note) foot.append(el("span", { className: "note", textContent: [it.via, note].filter(Boolean).join(" · ") }));
  if (["failed", "skipped"].includes(it.status)) {
    const again = el("button", { className: "ghost", textContent: "Try again" });
    again.onclick = () => cmd("retry", { id: it.id });
    foot.append(again);
  }
  main.append(foot);
  c.append(tick, main);
  return c;
}

function filteredCard(x) {
  const add = el("button", { textContent: "Add to queue" });
  add.onclick = async () => {
    await cmd("add", { items: [{ ...x, source: "feed", actions: { ...ap.defaultActions.feed } }] });
    filteredList = filteredList.filter(y => y.id !== x.id);
    chrome.storage.local.set({ apFiltered: filteredList });
  };
  return el("div", { className: "card out" }, el("span"),
    el("div", { className: "cmain" },
      el("div", { className: "head" },
        el("a", { className: "who", href: x.url, target: "_blank", textContent: "@" + x.handle }),
        x.type && el("span", { className: "tag", textContent: x.type }),
        el("span", { className: "tag st-failed", textContent: "Left out: " + x.reason })),
      el("div", { className: "body" }, x.thumb && el("img", { src: x.thumb, alt: "", loading: "lazy" }), el("div", { className: "bodytext" }, el("div", { className: "ptext", textContent: x.text || "(no text)" }))),
      el("div", { className: "foot" }, add)));
}

function renderPace() {
  const box = $("#pace");
  box.hidden = tab !== "review";
  if (box.contains(document.activeElement)) return; // don't redraw while you're typing the minutes
  const ticked = queue.filter(i => i.status === "ready" && i.include).length;
  const fastest = ticked * WORK_SEC;
  const rd = queue.filter(i => i.status === "ready" && i.include && i.actions.reply && i.mode);
  const op = rd.filter(i => i.mode === "opinion").length;
  const mix = rd.length ? el("span", { className: "mix", textContent: `· ${op} opinion · ${rd.length - op} reaction (${Math.round((op / rd.length) * 100)}% opinion, aim 60–70%)` }) : "";
  if (ap.paceMode === "finish") {
    const total = Number(ap.finishMinutes) * 60;
    const each = ticked ? total / ticked : 0;
    const inp = el("input", { type: "number", min: "1", value: ap.finishMinutes });
    inp.onchange = () => { ap.finishMinutes = Math.max(1, Number(inp.value) || 1); saveSettings(); bindSettings(); inp.blur(); renderPace(); };
    box.replaceChildren(el("span", { textContent: "Finish in" }), inp, el("span", { textContent: "minutes" }),
      ticked ? el("span", { innerHTML: `· <b>${ticked}</b> ticked · about <b>${fmtMin(each)}</b> on each post before acting, every wait different` }) : "",
      ticked && fastest > total ? el("span", { className: "warnc", textContent: `· too short: fastest for ${ticked} posts is about ${fmtMin(fastest)}, so it'll take that long` }) : "", mix);
  } else {
    box.replaceChildren(el("span", { innerHTML: `Waits <b>${ap.minGap}–${ap.maxGap} s</b> on each post before acting, rests ${ap.restMinutes} min after every ${ap.restEvery}. Change it under Speed.` }), mix);
  }
}

function renderCounts() {
  const n = s => queue.filter(i => s.includes(i.status)).length;
  const ready = queue.filter(i => i.status === "ready");
  document.querySelector('[data-tab="review"] span').textContent = ready.length;
  document.querySelector('[data-tab="queue"] span').textContent = n(["queued", "reading", "writing", "posting"]);
  document.querySelector('[data-tab="done"] span').textContent = n(FINISHED);
  document.querySelector('[data-tab="filtered"] span').textContent = filteredList.length || "";
  renderPace();
  const busy = !!status.busy;
  const ticked = ready.filter(i => i.include).length;
  $("#postBtn").textContent = ticked ? `Continue: post ${ticked}` : "Continue";
  $("#postBtn").disabled = busy || !ticked;
  $("#writeBtn").disabled = busy || !queue.some(i => i.status === "queued");
  $("#writeBtn").textContent = `Write replies (${Math.min(Number(ap.batchSize), n(["queued"]))})`;
  $("#pauseBtn").disabled = !busy || status.paused;
  $("#pauseBtn").textContent = busy && status.paused ? "Pausing…" : "Pause";
}
async function renderCount() {
  const { counts = {}, apUsage = {} } = await chrome.storage.local.get(["counts", "apUsage"]);
  const { goal = 300 } = await chrome.storage.sync.get("goal");
  const u = apUsage[today()] || { gemini: 0, claude: 0 };
  $("#count").textContent = `Replies today: ${counts[today()] || 0} / ${goal}`;
  $("#usage").textContent = `AI calls today: Gemini ${u.gemini} · Claude ${u.claude}`;
  $("#usage").title = "Each post usually takes 1–2 Gemini calls (picture + writing) and 1 Claude call (review). Gemini's free plan has a daily limit; when it's used up, Claude takes over and that costs money. Check your limit in Google AI Studio.";
}
function renderLog() {
  $("#log").replaceChildren(...logLines.slice(-300).reverse().map(l => el("div", { className: l.cls, textContent: `${l.t}  ${l.msg}` })));
}
function render() {
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  $("#log").hidden = tab !== "log";
  $("#list").hidden = tab === "log";
  $("#bulk").hidden = tab === "log" || tab === "filtered";
  renderCounts();
  if (tab === "log") { renderLog(); $("#empty").textContent = ""; return; }
  if (tab === "filtered") {
    $("#list").replaceChildren(...filteredList.map(filteredCard));
    cards.clear();
    $("#empty").textContent = filteredList.length ? "" : ap.useFilters ? "Nothing was left out by your filters on the last Collect." : "Filters are off, so nothing is left out.";
    return;
  }
  const items = queue.filter(inTab);
  const nodes = items.map(it => {
    const c = cards.get(it.id);
    if (c && c.v === it._v && c.st === it.status && c.inc === it.include) return c.el;
    const e = card(it);
    cards.set(it.id, { el: e, v: it._v, st: it.status, inc: it.include });
    return e;
  });
  const list = $("#list");
  // move nodes instead of rebuilding, so the reply you're typing in isn't touched
  nodes.forEach((nd, i) => { if (list.children[i] !== nd) list.insertBefore(nd, list.children[i] || null); });
  while (list.children.length > nodes.length) list.lastChild.remove();
  $("#empty").textContent = items.length ? "" :
    tab === "review" ? "Nothing to review yet. Add posts (🤖 → Collect or ➕ on X, chat links, or paste links), then press Write replies." :
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
      saveSettings(); renderCounts(); syncFilterBox();
    };
  });
  document.querySelectorAll('input[name="pace"]').forEach(r => {
    r.checked = ap.paceMode === r.value;
    r.onchange = () => { ap.paceMode = r.value; saveSettings(); renderCounts(); };
  });
  syncFilterBox();
  $("#topics").replaceChildren(...Object.entries(self.AP_TOPICS).map(([key, t]) => {
    const b = el("button", { className: "chip" + (ap.topics.includes(key) ? " on" : ""), textContent: t.label });
    b.onclick = () => {
      ap.topics = ap.topics.includes(key) ? ap.topics.filter(x => x !== key) : [...ap.topics, key];
      b.classList.toggle("on"); saveSettings();
    };
    return b;
  }));
  const names = { feed: "Collected", picked: "➕ picked", link: "Pasted links", group: "Chat links" };
  $("#defaults").replaceChildren(...Object.keys(names).map(src => el("div", { className: "defrow" }, el("b", { textContent: names[src] }), actBoxes(ap.defaultActions[src], saveSettings))));
  $("#linkActs").replaceChildren(...actBoxes({ ...ap.defaultActions.link }).childNodes);
}
function syncFilterBox() { $("#filterBox").classList.toggle("off", !ap.useFilters); }

// ---------- buttons ----------
$("#writeBtn").onclick = () => cmd("write");
$("#postBtn").onclick = () => cmd("post");
$("#pauseBtn").onclick = () => cmd("pause");
$("#collectBtn").onclick = () => cmd("collect");
$("#addLinks").onclick = async () => {
  const items = linksFromText($("#links").value);
  if (!items.length) return setStatus("No X post links found in that text.");
  const r = await cmd("add", { items });
  $("#links").value = "";
  setStatus(`Added ${r.added || 0} links.` + (r.dup ? ` ${r.dup} were already in the queue or done.` : ""));
  tab = "queue"; render();
};
$("#linkFile").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const r = await cmd("add", { items: linksFromText(await f.text()) });
  setStatus(`Added ${r.added || 0} links from ${f.name}.`);
  e.target.value = ""; tab = "queue"; render();
};
document.querySelectorAll("#tabs button").forEach(b => { b.onclick = () => { tab = b.dataset.tab; render(); }; });
for (const [btn, k] of [["#replyAll", "reply"], ["#likeAll", "like"], ["#repostAll", "repost"]]) {
  $(btn).onclick = async () => {
    const list = queue.filter(i => inTab(i) && ["queued", "ready"].includes(i.status));
    if (!list.length) return;
    const on = !list.every(i => i.actions[k]); // all on already → turn off; otherwise on for all
    await cmd("action", { ids: list.map(i => i.id), key: k, on });
    setStatus(`${k[0].toUpperCase() + k.slice(1)} ${on ? "on" : "off"} for ${list.length} posts.` + (k === "reply" && on && list.some(i => i.status === "ready" && !i.drafts?.length) ? " Posts without a reply went back to the queue: press Write replies." : ""));
  };
}
$("#tickAll").onclick = () => cmd("tick", { ids: queue.filter(i => i.status === "ready").map(i => i.id), on: true });
$("#untickAll").onclick = () => cmd("tick", { ids: queue.filter(i => i.status === "ready").map(i => i.id), on: false });
$("#clearDone").onclick = () => cmd("clearFinished");
$("#clearQueue").onclick = async () => {
  if (!confirm("Remove everything that hasn't been posted yet?")) return;
  const r = await cmd("clearQueue");
  if (!r.ok) setStatus(r.error);
};

// keep the tabs just under the header, whatever its height (it wraps on small screens)
new ResizeObserver(() => document.documentElement.style.setProperty("--hh", $("header").offsetHeight + "px")).observe($("header"));

// ---------- start ----------
await loadAll();
bindSettings();
render();
renderStatus();
renderCount();
const s = await cmd("status");
if (s?.ok) { status = { text: s.text, busy: s.busy, paused: s.paused }; renderStatus(); renderCounts(); }
