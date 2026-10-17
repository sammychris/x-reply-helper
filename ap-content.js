// Autopilot helpers on x.com:
//  - "Collect" gathers posts from the page you're on (feed, search, list) using your filters
//  - a ➕ on every post adds it to the queue by hand
//  - in a chat: set a start point, then grab the post links people dropped after it
//  - in the working window: reads a post, and likes / reposts / replies when the control center says so
(() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const STATUS_RE = /(?:x|twitter)\.com\/([A-Za-z0-9_]{1,20})\/status\/(\d{5,25})/i;

  async function apSettings() {
    const { apSettings = {} } = await chrome.storage.local.get("apSettings");
    const d = self.AP_DEFAULTS;
    return { ...d, ...apSettings, types: { ...d.types, ...(apSettings.types || {}) }, filters: { ...d.filters, ...(apSettings.filters || {}) }, defaultActions: { ...d.defaultActions, ...(apSettings.defaultActions || {}) } };
  }
  const list = s => String(s || "").split(/[,\n]/).map(x => x.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordsRe = words => (words.length ? new RegExp("(^|[^\\p{L}\\p{N}])(" + words.map(escapeRe).join("|") + ")(?=$|[^\\p{L}\\p{N}])", "iu") : null);

  function toast(msg, ms = 3500) {
    const t = Object.assign(document.createElement("div"), { className: "ap-toast", textContent: msg });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  // Add posts to the control center's inbox, then open the control center.
  async function sendToQueue(items, collector = false) {
    if (collector) chrome.runtime.sendMessage({ type: "apCollector" }); // remember this tab for "Collect more"
    if (!items.length) return;
    const { apInbox = [] } = await chrome.storage.local.get("apInbox");
    await chrome.storage.local.set({ apInbox: apInbox.concat(items) });
    chrome.runtime.sendMessage({ type: "apOpen" });
  }
  async function knownIds() {
    const { apQueue = [], apDone = {} } = await chrome.storage.local.get(["apQueue", "apDone"]);
    return new Set([...apQueue.map(i => i.id), ...Object.keys(apDone)]);
  }

  // ---------- reading what's on a post ----------
  function articleInfo(a) {
    const timeLink = a.querySelector('a[href*="/status/"] time')?.closest("a");
    const m = timeLink?.getAttribute("href")?.match(/\/([A-Za-z0-9_]+)\/status\/(\d+)/);
    if (!m) return null;
    const [, handle, id] = m;
    const replyLabel = a.querySelector('[data-testid="reply"]')?.getAttribute("aria-label") || "";
    const replies = Number((replyLabel.match(/([\d,]+)\s+repl/i) || [, "0"])[1].replace(/,/g, "")) || 0;
    const isVideo = !!a.querySelector('video, [data-testid="videoPlayer"], [data-testid="videoComponent"]');
    const photo = a.querySelector('[data-testid="tweetPhoto"] img');
    const poster = a.querySelector("video")?.getAttribute("poster");
    return {
      id,
      handle,
      url: `https://x.com/${handle}/status/${id}`,
      text: a.querySelector('[data-testid="tweetText"]')?.innerText || "",
      time: timeLink.querySelector("time")?.getAttribute("datetime") || "",
      replies,
      type: isVideo ? "video" : photo ? "image" : "text",
      thumb: (photo?.src || poster || "").replace(/name=\w+/, "name=small"),
      isAd: !!a.querySelector('[data-testid="placementTracking"]') || [...a.querySelectorAll("span")].some(s => s.textContent.trim() === "Ad")
    };
  }

  // Returns the reason to leave a post out, or "" to keep it.
  // "Already done", ads and your own posts (both switchable) always apply; the rest only with "Use filters" on.
  function skipReason(info, s, rules) {
    if (rules.known.has(info.id)) return "already in queue or done";
    const f = s.filters, h = info.handle.toLowerCase();
    if (f.ads && info.isAd) return "ad";
    if (f.own && h === rules.me) return "your own post";
    if (!s.useFilters) return "";
    if (f.accounts && rules.skipAcc.has(h)) return "skip list";
    if (f.types && !s.types[info.type]) return info.type + " posts are off";
    if (f.age && s.maxAgeHours && info.time && Date.now() - Date.parse(info.time) > s.maxAgeHours * 3600e3) return "too old";
    if (f.replies && s.maxReplies && info.replies > s.maxReplies) return "too many replies";
    const hay = info.text + " " + info.handle;
    if (f.words && rules.skipRe && rules.skipRe.test(hay)) return "never-reply word";
    if (rules.fav.has(h)) return "";
    if (f.topics && rules.topicRe && !rules.topicRe.test(hay)) return "off topic";
    return "";
  }

  // ---------- collect posts from the page ----------
  let collecting = false;
  async function collect(n, onProgress = () => {}) {
    if (collecting) { collecting = false; return { stopped: true }; }
    collecting = true;
    const s = await apSettings();
    const topicWords = [...(s.topics || []).flatMap(t => self.AP_TOPICS[t]?.words || []), ...list(s.keywords)];
    const rules = {
      me: (s.myHandle || "").toLowerCase().replace(/^@/, ""),
      skipAcc: new Set(list(s.skipAccounts)),
      fav: new Set(list(s.favAccounts)),
      known: await knownIds(),
      skipRe: wordsRe(list(s.skipWords)),
      topicRe: wordsRe(topicWords.map(w => w.toLowerCase()))
    };
    const found = [], seen = new Set(), skipped = {}, filtered = [];
    let stale = 0;
    for (let step = 0; step < 80 && found.length < n && collecting; step++) {
      let fresh = 0;
      for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
        const info = articleInfo(a);
        if (!info || seen.has(info.id)) continue;
        seen.add(info.id); fresh++;
        const why = skipReason(info, s, rules);
        if (why) {
          skipped[why] = (skipped[why] || 0) + 1;
          if (why !== "already in queue or done") filtered.push({ ...info, reason: why }); // shown in "Filtered out"
          continue;
        }
        found.push({ ...info, fav: rules.fav.has(info.handle.toLowerCase()) });
        if (found.length >= n) break;
      }
      onProgress(found.length, n);
      stale = fresh ? 0 : stale + 1;
      if (stale >= 6) break; // the page stopped loading new posts
      window.scrollBy(0, window.innerHeight * 0.85);
      await sleep(1300);
    }
    collecting = false;
    if (s.favFirst) found.sort((x, y) => (y.fav ? 1 : 0) - (x.fav ? 1 : 0)); // favourites first
    const items = found.map(f => ({ ...f, source: "feed", actions: { ...s.defaultActions.feed } }));
    if (filtered.length) {
      const { apFiltered = [] } = await chrome.storage.local.get("apFiltered");
      const keep = apFiltered.filter(x => !filtered.some(y => y.id === x.id));
      await chrome.storage.local.set({ apFiltered: filtered.concat(keep).slice(0, 300) });
    }
    await sendToQueue(items, true);
    return { added: items.length, skipped };
  }

  // ---------- one 🤖 button (bottom left) that opens a small menu ----------
  // Everything the extension adds to x.com lives in this menu, so nothing covers X's own buttons.
  const dock = Object.assign(document.createElement("div"), { id: "ap-dock" });
  const toggle = Object.assign(document.createElement("button"), { id: "ap-toggle", textContent: "🤖" });
  const bar = Object.assign(document.createElement("div"), { id: "ap-bar" });
  dock.append(bar, toggle);
  document.body.appendChild(dock);
  let open = false;
  try { open = sessionStorage.getItem("apMenu") === "1"; } catch (_) {}
  const setOpen = v => { open = v; dock.classList.toggle("open", v); try { sessionStorage.setItem("apMenu", v ? "1" : "0"); } catch (_) {} };
  setOpen(open);
  toggle.onclick = () => setOpen(!open);
  const mk = (text, cls = "") => Object.assign(document.createElement("button"), { className: "ap-fbtn " + cls, textContent: text });
  const apBtn = mk("🤖 Collect posts on this page");
  const centerBtn = mk("Control center", "ap-dark");
  bar.append(apBtn, centerBtn);
  // the older helper's buttons (reply counter, Draft next 10, Pick a post) move into the same menu
  const adopt = () => {
    const badge = document.getElementById("srh-badge");
    if (badge && badge.parentNode !== dock) { dock.insertBefore(badge, bar); new MutationObserver(() => { toggle.textContent = "🤖 " + (badge.textContent.match(/\d+\s*\/\s*\d+/) || [""])[0].replace(/\s/g, ""); }).observe(badge, { childList: true, characterData: true, subtree: true }); }
    for (const id of ["srh-batch", "srh-pick"]) { const b = document.getElementById(id); if (b && b.parentNode !== bar) bar.append(b); }
  };
  adopt(); setTimeout(adopt, 500);

  apBtn.onclick = async () => {
    if (collecting) { collecting = false; apBtn.textContent = "Stopping…"; return; }
    const s = await apSettings();
    const label = (f, n) => { apBtn.textContent = `Collecting ${f}/${n} · tap to stop`; toggle.textContent = `🤖 ${f}/${n}`; };
    label(0, s.batchSize);
    const r = await collect(s.batchSize, label);
    apBtn.textContent = "🤖 Collect posts on this page";
    adopt();
    if (r.stopped) return;
    const sk = Object.entries(r.skipped).map(([k, v]) => `${v} ${k}`).join(", ");
    toast(`Added ${r.added} posts to the queue.` + (sk ? ` Left out: ${sk}.` : ""), 6000);
  };
  centerBtn.onclick = () => chrome.runtime.sendMessage({ type: "apOpen", focus: true });

  // In the working window, hide everything the extension adds: Autopilot drives that window.
  chrome.runtime.sendMessage({ type: "apWhoAmI" }).then(r => { if (r?.worker) document.documentElement.classList.add("ap-worker"); }).catch(() => {});

  // ---------- ➕ on every post ----------
  function addPlus(article) {
    if (article.dataset.apPlus) return;
    const group = article.querySelector('[role="group"]');
    if (!group) return;
    article.dataset.apPlus = "1";
    const b = Object.assign(document.createElement("button"), { className: "ap-plus", textContent: "➕", title: "Add to Autopilot queue" });
    b.onclick = async e => {
      e.preventDefault(); e.stopPropagation();
      const info = articleInfo(article);
      if (!info) return toast("Couldn't read this post.");
      if ((await knownIds()).has(info.id)) { b.textContent = "✓"; return toast("Already in the queue or done."); }
      const s = await apSettings();
      await sendToQueue([{ ...info, source: "picked", actions: { ...s.defaultActions.picked } }]);
      b.textContent = "✓";
    };
    group.appendChild(b);
  }
  const scan = () => document.querySelectorAll('article[data-testid="tweet"]').forEach(addPlus);
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();

  // ---------- chat: start point + grab links ----------
  const isChat = () => /^\/(messages|i\/chat)(\/|$)/.test(location.pathname);
  const chatKey = () => location.pathname.replace(/\/+$/, "");
  const chatRoot = () => document.querySelector('[data-testid="DmActivityViewport"], [data-testid="DMConversation"]') || document.querySelector('[role="main"]') || document.body;

  // Every post link in the chat, in the order it appears on screen (links and plain-text links).
  function linksIn(root) {
    const out = [], ids = new Set();
    for (const el of root.querySelectorAll("a")) {
      const m = (el.getAttribute("href") || "").match(STATUS_RE) || (el.innerText || "").match(STATUS_RE) || (el.title || "").match(STATUS_RE);
      if (!m || ids.has(m[2])) continue;
      ids.add(m[2]);
      out.push({ node: el, handle: m[1], id: m[2] });
    }
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.parentElement?.closest("a, #ap-dock")) continue;
      for (const m of (n.textContent || "").matchAll(new RegExp(STATUS_RE.source, "gi"))) {
        if (!ids.has(m[2])) { ids.add(m[2]); out.push({ node: n, handle: m[1], id: m[2] }); }
      }
    }
    return out.sort((a, b) => (a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }
  const msgEntries = root => [...root.querySelectorAll('[data-testid="messageEntry"]')];
  const sigOf = el => (el?.innerText || "").trim().slice(0, 80);
  async function getChats() { return (await chrome.storage.local.get("apChats")).apChats || {}; }

  const startBtn = mk("📍 Set start point", "ap-dark");
  const grabBtn = mk("🔗 Grab new links");
  bar.prepend(startBtn, grabBtn);
  const showChatButtons = () => {
    const on = isChat();
    startBtn.style.display = grabBtn.style.display = on ? "" : "none";
    apBtn.style.display = on ? "none" : "";
  };
  setInterval(showChatButtons, 1000);
  showChatButtons();

  // The start point is remembered by the links around it, not by where they sit on screen:
  // X only keeps part of a long chat loaded, so positions change as you scroll.
  //   before  = links older than the start point (never taken)
  //   after   = links at/after the start point that we've seen (used to find our place again)
  //   grabbed = links already sent to the queue
  let picking = false;
  startBtn.onclick = () => {
    picking = !picking;
    startBtn.textContent = picking ? "Now click the first message to start from (tap here to cancel)" : "📍 Set start point";
  };
  document.addEventListener("click", async e => {
    if (!picking || e.target.closest("#ap-dock")) return;
    e.preventDefault(); e.stopPropagation();
    picking = false;
    startBtn.textContent = "📍 Set start point";
    const clicked = e.target.closest('[data-testid="messageEntry"]') || e.target;
    const links = linksIn(chatRoot());
    const isBefore = l => !clicked.contains(l.node) && (clicked.compareDocumentPosition(l.node) & Node.DOCUMENT_POSITION_PRECEDING);
    const chats = await getChats();
    chats[chatKey()] = { before: links.filter(isBefore).map(l => l.id), after: links.filter(l => !isBefore(l)).map(l => l.id), grabbed: [], sig: sigOf(clicked), setAt: new Date().toISOString() };
    await chrome.storage.local.set({ apChats: chats });
    toast(`Start point set. ${chats[chatKey()].before.length} older links will be ignored. Press "Grab new links" whenever you want.`, 6000);
  }, true);

  grabBtn.onclick = async () => {
    const chats = await getChats();
    let chat = chats[chatKey()];
    if (chat && chat.seen && !chat.before) chat = { before: chat.seen, after: [], grabbed: [] }; // start point from v2.1
    const root = chatRoot();
    const links = linksIn(root);
    let from = 0; // index in links where new ones start
    if (!chat) {
      if (!confirm("No start point set for this chat yet. Grab every post link you can see?")) return;
      chat = { before: [], after: [], grabbed: [] };
    } else {
      const before = new Set(chat.before), after = new Set([...chat.after, ...chat.grabbed]);
      // 1) the start message itself, or the last older link, if they're on screen
      const startMsg = chat.sig ? msgEntries(root).find(m => sigOf(m) === chat.sig) : null;
      let cut = -1;
      links.forEach((l, i) => { if (before.has(l.id) || (startMsg && (startMsg.compareDocumentPosition(l.node) & Node.DOCUMENT_POSITION_PRECEDING))) cut = i; });
      if (cut >= 0) from = cut + 1;
      else {
        // 2) otherwise the first link we already know is after the start point
        const firstKnown = links.findIndex(l => after.has(l.id));
        if (firstKnown >= 0) from = firstKnown;
        else if (links.length) { toast("I can't see where the start point or your last grab is. Scroll the chat so your last grabbed links (or the start point) are on screen, then press Grab again.", 8000); return; }
      }
    }
    const grabbedSet = new Set(chat.grabbed), beforeSet = new Set(chat.before);
    const fresh = links.slice(from).filter(l => !grabbedSet.has(l.id) && !beforeSet.has(l.id));
    const known = await knownIds();
    const s = await apSettings();
    const items = fresh.filter(l => !known.has(l.id)).map(l => ({
      id: l.id, handle: l.handle, url: `https://x.com/${l.handle}/status/${l.id}`, text: "", type: "", source: "group", actions: { ...s.defaultActions.group }
    }));
    chat.grabbed = [...new Set([...chat.grabbed, ...fresh.map(l => l.id)])].slice(-5000);
    chat.after = [...new Set([...chat.after, ...links.slice(from).map(l => l.id)])].slice(-5000);
    chats[chatKey()] = chat;
    await chrome.storage.local.set({ apChats: chats });
    await sendToQueue(items);
    toast(items.length ? `Grabbed ${items.length} new links.` + (fresh.length > items.length ? ` ${fresh.length - items.length} were already done.` : "") : "No new links since last time.", 5000);
  };

  // ---------- working window: steps the control center asks for ----------
  function focal(id) {
    return [...document.querySelectorAll('article[data-testid="tweet"]')].find(a => articleInfo(a)?.id === id) || null;
  }
  async function waitFocal(id, ms = 15000) {
    for (let t = 0; t < ms; t += 300) {
      const a = focal(id);
      if (a) return a;
      if (/\/(login|i\/flow)/.test(location.pathname)) throw new Error("login: X wants you to log in again in the working window.");
      const body = document.querySelector('[role="main"]')?.innerText || document.body.innerText;
      if (/rate limit exceeded|you are rate limited|too many requests/i.test(body)) throw new Error("ratelimit: X says you've hit its rate limit.");
      if (/this post (was deleted|is unavailable)|hmm\.\.\.this page doesn.t exist|post you.re looking for|account (is|has been) suspended|these posts are protected/i.test(body)) throw new Error("gone: this post was deleted or isn't available.");
      await sleep(300);
    }
    throw new Error("Couldn't find the post on the page.");
  }

  async function grabFrames(article) {
    const v = article.querySelector("video");
    if (!v) return [];
    const frames = [];
    try {
      v.muted = true;
      await v.play().catch(() => {});
      for (let t = 0; t < 5000 && !(v.readyState >= 2 && isFinite(v.duration) && v.duration > 0); t += 250) await sleep(250);
      if (!(isFinite(v.duration) && v.duration > 0)) return [];
      v.pause();
      for (const at of [0.45, 0.85]) {
        v.currentTime = v.duration * at;
        await Promise.race([new Promise(r => v.addEventListener("seeked", r, { once: true })), sleep(4000)]);
        const w = 360, h = Math.round((v.videoHeight / v.videoWidth) * w) || 640;
        const c = Object.assign(document.createElement("canvas"), { width: w, height: h });
        c.getContext("2d").drawImage(v, 0, 0, w, h);
        frames.push(c.toDataURL("image/jpeg", 0.7)); // throws if X blocks reading the video
      }
      v.currentTime = 0;
    } catch (_) { /* X blocked the frames: the preview image is used instead */ }
    return frames;
  }

  async function readPost(id, opts) {
    const a = await waitFocal(id);
    const info = articleInfo(a);
    const texts = [...a.querySelectorAll('[data-testid="tweetText"]')].map(t => t.innerText);
    const imgs = [...a.querySelectorAll('[data-testid="tweetPhoto"] img')];
    const images = imgs.map(i => i.src.replace(/name=\w+/, "name=small")).filter(u => u.startsWith("https://pbs.twimg.com/"));
    const alts = imgs.map(i => (i.alt || "").trim()).filter(t => t && t.toLowerCase() !== "image");
    const poster = a.querySelector("video")?.getAttribute("poster");
    if (poster && poster.startsWith("https://pbs.twimg.com/")) images.push(poster.replace(/name=\w+/, "name=small"));
    // Frames only when the post's own words don't already explain the video (saves time and AI cost).
    const frames = opts.frames && info.type === "video" && (texts[0] || "").length < 120 && !alts.length ? await grabFrames(a) : [];
    let replies = [];
    if (opts.readReplies) {
      for (let i = 0; i < 3 && replies.length < 10; i++) {
        window.scrollTo(0, a.getBoundingClientRect().bottom + window.scrollY - 100 + i * window.innerHeight * 0.8);
        await sleep(1200);
        const all = [...document.querySelectorAll('article[data-testid="tweet"]')];
        const start = all.indexOf(focal(id));
        replies = all.slice(start + 1)
          .filter(r => { const i = articleInfo(r); return i && !i.isAd && i.handle.toLowerCase() !== (opts.me || ""); }) // no ads, not your own replies
          .map(r => r.querySelector('[data-testid="tweetText"]')?.innerText || "").filter(t => t.trim().length > 2).slice(0, 10);
      }
      window.scrollTo(0, 0);
    }
    return { ...info, text: texts[0] || "", quoted: texts[1] || "", images: [...new Set(images)].slice(0, 4), alts, frames, replies };
  }

  function xError() {
    const t = [...document.querySelectorAll('[data-testid="toast"], [role="alert"]')].map(x => x.innerText).join(" ");
    return /something went wrong|try again|limit|automated|unable to|suspend|restricted|spam/i.test(t) ? t.trim().slice(0, 200) : "";
  }
  async function clickWhenReady(sel, root = document, ms = 4000) {
    for (let t = 0; t < ms; t += 200) {
      const el = root.querySelector(sel);
      if (el && el.getAttribute("aria-disabled") !== "true" && !el.disabled) { el.click(); return true; }
      await sleep(200);
    }
    return false;
  }

  async function like(a) {
    if (a.querySelector('[data-testid="unlike"]')) return true;
    a.querySelector('[data-testid="like"]')?.click();
    for (let t = 0; t < 3000; t += 250) { if (a.querySelector('[data-testid="unlike"]')) return true; await sleep(250); }
    return false;
  }
  async function repost(a) {
    if (a.querySelector('[data-testid="unretweet"]')) return true;
    a.querySelector('[data-testid="retweet"]')?.click();
    if (!(await clickWhenReady('[data-testid="retweetConfirm"]'))) return false;
    for (let t = 0; t < 3000; t += 250) { if (a.querySelector('[data-testid="unretweet"]')) return true; await sleep(250); }
    return false;
  }
  async function reply(a, text) {
    // On a post's own page X shows a reply box under the post; otherwise open the reply pop-up.
    let box = document.querySelector('[role="main"] [data-testid="tweetTextarea_0"]');
    let inDialog = false;
    if (!box || box.closest('[role="dialog"]')) {
      a.querySelector('[data-testid="reply"]')?.click();
      for (let i = 0; i < 40 && !(box = document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]')); i++) await sleep(100);
      inDialog = true;
    }
    if (!box) return { ok: false, error: "Couldn't open the reply box." };
    const editable = box.matches('[contenteditable="true"]') ? box : box.querySelector('[contenteditable="true"]') || box;
    editable.click();
    editable.focus();
    await sleep(250);
    if (editable.innerText.trim()) { document.execCommand("selectAll", false, null); document.execCommand("delete", false, null); await sleep(150); }
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    editable.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    await sleep(600);
    if (!editable.innerText.includes(text.slice(0, 10))) return { ok: false, needFocus: true, error: "The reply didn't go into the box." };
    const sent = await clickWhenReady(inDialog ? '[role="dialog"] [data-testid="tweetButton"]' : '[data-testid="tweetButtonInline"]');
    if (!sent) return { ok: false, error: "X's Reply button stayed greyed out." };
    for (let t = 0; t < 8000; t += 300) {
      await sleep(300);
      const err = xError();
      if (err) return { ok: false, xError: err };
      const stillThere = editable.isConnected && editable.innerText.includes(text.slice(0, 10));
      if (!stillThere) return { ok: true };
    }
    return { ok: false, error: "X didn't confirm the reply was sent." };
  }

  // Is there already a reply from you under this post? (You replied by hand, or a reply went out
  // just before Chrome stopped.) Then the reply is not sent again.
  async function alreadyReplied(a, me) {
    if (!me) return false;
    for (let t = 0; t < 2500; t += 500) {
      const all = [...document.querySelectorAll('article[data-testid="tweet"]')];
      const after = all.slice(all.indexOf(a) + 1, all.indexOf(a) + 40);
      if (after.some(r => articleInfo(r)?.handle.toLowerCase() === me)) return true;
      if (after.length) return false;
      await sleep(500); // replies still loading
    }
    return false;
  }

  async function act(id, want) {
    const a = await waitFocal(id);
    const done = { like: false, repost: false, reply: false };
    let already = false;
    if (want.reply && location.pathname.includes("/status/" + id) && await alreadyReplied(a, want.me)) { already = true; want = { ...want, reply: "" }; done.reply = true; }
    if (want.like) done.like = await like(a);
    if (want.like && xError()) return { ok: false, done, xError: xError() };
    if (want.repost) done.repost = await repost(a);
    if (want.repost && xError()) return { ok: false, done, xError: xError() };
    if (want.reply) {
      const r = await reply(a, want.reply);
      if (!r.ok) return { ...r, done };
      done.reply = true;
    }
    const failed = Object.keys(done).filter(k => want[k] && !done[k]);
    return failed.length ? { ok: false, done, error: "Couldn't " + failed.join(" / ") + " this post." } : { ok: true, done, already };
  }

  // Grok: press the post's Grok button, ask it to explain, and read the answer. Experimental: X changes this often.
  async function askGrok(id) {
    const a = await waitFocal(id);
    const btn = [...a.querySelectorAll("button[aria-label], [role='button'][aria-label]")].find(b => /grok/i.test(b.getAttribute("aria-label")));
    if (!btn) return { ok: false, error: "No Grok button on this post." };
    const startPath = location.pathname;
    btn.click();
    await sleep(1500);
    const item = [...document.querySelectorAll('[role="menuitem"], [role="menu"] [role="button"], [role="dialog"] button')].find(m => /explain/i.test(m.innerText));
    if (item) item.click();
    let last = "", stableFor = 0;
    for (let t = 0; t < 45000; t += 1000) {
      await sleep(1000);
      const box = document.querySelector('[data-testid="GrokDrawer"]') || [...document.querySelectorAll('[role="dialog"]')].pop() ||
        (location.pathname !== startPath ? document.querySelector('[role="main"]') : null);
      const text = (box?.innerText || "").trim();
      if (text && text === last && text.length > 120) { if (++stableFor >= 3) break; } else stableFor = 0;
      last = text;
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    if (location.pathname !== startPath) history.back();
    return last.length > 120 ? { ok: true, text: last.slice(0, 1500) } : { ok: false, error: "Grok didn't answer in time." };
  }

  // Move to another post inside X, the way tapping a post does (no full page reload).
  async function nav(url, id) {
    const path = new URL(url).pathname;
    if (location.pathname !== path) {
      history.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    }
    for (let t = 0; t < 8000; t += 250) {
      if (location.pathname === path && focal(id)) { window.scrollTo(0, 0); return { ok: true }; }
      try { await waitFocal(id, 1); } catch (e) { if (/^(login|gone|ratelimit)/.test(e.message)) return { ok: false, error: e.message }; }
      await sleep(250);
    }
    return { ok: false };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "apNav") { nav(msg.url, msg.id).then(sendResponse, () => sendResponse({ ok: false })); return true; }
    const reply = p => p.then(v => sendResponse({ ok: true, ...v }), e => sendResponse({ ok: false, error: e.message }));
    if (msg.type === "apPing") { sendResponse({ ok: true }); return; }
    if (msg.type === "apRead") { reply(readPost(msg.id, msg.opts || {}).then(post => ({ post }))); return true; }
    if (msg.type === "apAct") { act(msg.id, msg.want).then(sendResponse, e => sendResponse({ ok: false, error: e.message })); return true; }
    if (msg.type === "apGrok") { askGrok(msg.id).then(sendResponse, e => sendResponse({ ok: false, error: e.message })); return true; }
    if (msg.type === "apCollect") {
      collect(msg.n).then(r => { toast(`Autopilot collected ${r.added || 0} more posts.`); sendResponse({ ok: true, ...r }); });
      return true;
    }
  });
})();
