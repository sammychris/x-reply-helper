// Adds a "Reply ideas" button to each post on X. Nothing is ever posted automatically:
// the chosen idea is placed in X's reply box and you press Reply yourself.
(() => {
  const today = () => new Date().toISOString().slice(0, 10);
  let pendingFromHelper = false;

  // ---------- daily counter ----------
  const badge = document.createElement("div");
  badge.id = "srh-badge";
  document.body.appendChild(badge);
  async function refreshBadge() {
    const { counts = {} } = await chrome.storage.local.get("counts");
    const { goal } = await chrome.runtime.sendMessage({ type: "getGoal" });
    badge.textContent = `Replies today: ${counts[today()] || 0} / ${goal}`;
  }
  async function bump() {
    const { counts = {} } = await chrome.storage.local.get("counts");
    counts[today()] = (counts[today()] || 0) + 1;
    await chrome.storage.local.set({ counts });
    refreshBadge();
  }
  refreshBadge();

  // Count a reply when you press X's Reply button after using an idea.
  document.addEventListener("click", e => {
    const send = e.target.closest('[data-testid="tweetButton"], [data-testid="tweetButtonInline"]');
    if (send && pendingFromHelper) { pendingFromHelper = false; setTimeout(bump, 800); }
  }, true);

  // ---------- reading a post ----------
  function readPost(article) {
    const texts = [...article.querySelectorAll('[data-testid="tweetText"]')].map(t => t.innerText);
    const text = texts[0] || "";
    const quoted = texts[1] || ""; // a quoted post inside this one
    const author = article.querySelector('[data-testid="User-Name"]')?.innerText.replace(/\n/g, " ") || "";
    const images = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')]
      .map(img => img.src.replace(/name=\w+/, "name=medium"))
      .filter(src => src.startsWith("https://pbs.twimg.com/"));
    const poster = article.querySelector("video")?.getAttribute("poster");
    if (poster && poster.startsWith("https://pbs.twimg.com/")) images.push(poster);

    // Your old trick: other people's replies as context (3 to 10 of them).
    // Only available when the post is open on its own page (x.com/.../status/...).
    let replies = [];
    if (location.pathname.includes("/status/")) {
      const all = [...document.querySelectorAll('article[data-testid="tweet"]')];
      const i = all.indexOf(article);
      replies = all.slice(i + 1)
        .map(a => a.querySelector('[data-testid="tweetText"]')?.innerText || "")
        .filter(t => t.trim().length > 2)
        .slice(0, 10);
    }
    return { text, quoted, author, replies, images: [...new Set(images)].slice(0, 4), hasVideo: !!article.querySelector("video") };
  }

  // ---------- putting an idea into X's reply box ----------
  async function putInReplyBox(article, text) {
    const existing = document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]');
    if (!existing) article.querySelector('[data-testid="reply"]')?.click();
    let box = null;
    for (let i = 0; i < 40 && !box; i++) {
      await new Promise(r => setTimeout(r, 100));
      box = document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]');
    }
    if (!box) { await navigator.clipboard.writeText(text); alert("Couldn't open the reply box, so the reply was copied. Paste it in."); return; }
    // Paste the text the way your old extension did (a paste event X's editor handles cleanly).
    // The old method (execCommand) could make X show the text twice.
    const editable = box.matches('[contenteditable="true"]') ? box : box.querySelector('[contenteditable="true"]') || box;
    editable.focus();
    await new Promise(r => setTimeout(r, 200));
    if (editable.innerText.trim()) {
      // Something is already in the box (e.g. an earlier attempt): clear it so the reply isn't doubled.
      document.execCommand("selectAll", false, null);
      document.execCommand("delete", false, null);
      await new Promise(r => setTimeout(r, 100));
    }
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    editable.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 500));
    if (!editable.innerText.includes(text.slice(0, 10))) {
      await navigator.clipboard.writeText(text);
      alert("The reply didn't paste in automatically, so it's copied. Press Ctrl+V in the reply box.");
      return;
    }
    pendingFromHelper = true;
  }

  // ---------- the panel under each post ----------
  function showPanel(article, anchor) {
    return new Promise(done => {
    article.querySelector(".srh-panel")?.remove();
    const panel = document.createElement("div");
    panel.className = "srh-panel";
    panel.textContent = "Reading the post…";
    anchor.after(panel);

    const run = () => {
      panel.textContent = "Reading the post…";
      const post = readPost(article);
      chrome.runtime.sendMessage({ type: "draft", post }, res => {
        done();
        panel.textContent = "";
        if (!res?.ok) { panel.textContent = res?.error || "Something went wrong."; return; }
        const n = post.replies.length;
        const ctx = location.pathname.includes("/status/")
          ? (n ? `Read ${n} ${n === 1 ? "reply" : "replies"} for context` : "No replies yet to read for context")
          : "Feed post: open the post to also read its replies";
        if (res.via) panel.append(Object.assign(document.createElement("div"), { className: "srh-review", textContent: `Written by ${res.via} · ${ctx}` }));
        if (res.note) panel.append(Object.assign(document.createElement("div"), { className: "srh-note", textContent: res.note }));
        if (res.skip) {
          panel.append(Object.assign(document.createElement("div"), { className: "srh-note", textContent: `Suggest skipping: ${res.reason}` }));
        }
        const rv = res.review;
        const order = res.replies.map((r, i) => i);
        if (rv) order.sort((x, y) => (x === rv.best ? -1 : y === rv.best ? 1 : (rv.scores[y] || 0) - (rv.scores[x] || 0)));
        order.forEach(i => {
          const reply = res.replies[i];
          if (rv) {
            const score = rv.scores[i];
            const tag = document.createElement("div");
            tag.className = "srh-review" + (i === rv.best ? " srh-best" : "") + (score <= 4 ? " srh-bad" : "");
            tag.textContent = (i === rv.best ? "Reviewer's pick" : "Reviewer") + (score ? ` ${score}/10` : "") + (rv.notes[i] ? ` · ${rv.notes[i]}` : "");
            panel.append(tag);
          }
          const row = document.createElement("div");
          row.className = "srh-row" + (rv && rv.scores[i] <= 4 ? " srh-dim" : "");
          const t = Object.assign(document.createElement("div"), { className: "srh-text", textContent: reply, contentEditable: "true" });
          const use = Object.assign(document.createElement("button"), { textContent: "Use" });
          use.onclick = ev => { ev.stopPropagation(); putInReplyBox(article, t.innerText.trim()); };
          const copy = Object.assign(document.createElement("button"), { textContent: "Copy" });
          copy.onclick = ev => { ev.stopPropagation(); navigator.clipboard.writeText(t.innerText.trim()); copy.textContent = "Copied"; };
          row.append(t, use, copy);
          panel.append(row);
        });
        const again = Object.assign(document.createElement("button"), { className: "srh-again", textContent: "New ideas" });
        again.onclick = ev => { ev.stopPropagation(); run(); };
        const close = Object.assign(document.createElement("button"), { className: "srh-again", textContent: "Close" });
        close.onclick = ev => { ev.stopPropagation(); panel.remove(); };
        panel.append(again, close);
      });
    };
    panel.addEventListener("click", e => e.stopPropagation());
    run();
    });
  }

  // ---------- post picker: 10 posts from your bank ----------
  let pendingPostId = null;
  const pickBtn = document.createElement("button");
  pickBtn.id = "srh-pick";
  pickBtn.textContent = "Pick a post";
  document.body.appendChild(pickBtn);
  const picker = document.createElement("div");
  picker.id = "srh-picker";
  picker.className = "srh-panel";
  document.body.appendChild(picker);

  async function openComposer(text, id) {
    document.querySelector('[data-testid="SideNav_NewTweet_Button"]')?.click();
    let box = null;
    for (let i = 0; i < 40 && !box; i++) {
      await new Promise(r => setTimeout(r, 100));
      box = document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]');
    }
    if (!box) { await navigator.clipboard.writeText(text); alert("Couldn't open the post box, so the post was copied. Paste it in."); return; }
    const editable = box.matches('[contenteditable="true"]') ? box : box.querySelector('[contenteditable="true"]') || box;
    editable.focus();
    await new Promise(r => setTimeout(r, 200));
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    editable.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    pendingPostId = id; // marked as posted only when you actually press Post
  }

  async function showPicker() {
    picker.style.display = "block";
    picker.textContent = "Loading…";
    const { posts, remaining } = await chrome.runtime.sendMessage({ type: "getBatch", size: 10 });
    picker.textContent = "";
    picker.append(Object.assign(document.createElement("div"), { className: "srh-review", textContent: `${remaining} posts left in your bank. Pick one, edit it if you like, then press Post on X.` }));
    posts.forEach(p => {
      const row = document.createElement("div");
      row.className = "srh-row";
      const t = Object.assign(document.createElement("div"), { className: "srh-text", textContent: p.text, contentEditable: "true" });
      const use = Object.assign(document.createElement("button"), { textContent: "Use" });
      use.onclick = () => { picker.style.display = "none"; openComposer(t.innerText.trim(), p.id); };
      row.append(t, use);
      picker.append(row);
      if (p.img) picker.append(Object.assign(document.createElement("div"), { className: "srh-review", textContent: `Image idea: ${p.img}` }));
    });
    const again = Object.assign(document.createElement("button"), { className: "srh-again", textContent: "Show 10 more" });
    again.onclick = showPicker;
    const close = Object.assign(document.createElement("button"), { className: "srh-again", textContent: "Close" });
    close.onclick = () => { picker.style.display = "none"; };
    picker.append(again, close);
  }
  pickBtn.onclick = () => (picker.style.display === "block" ? (picker.style.display = "none") : showPicker());

  // Mark the bank post as used when you press Post.
  document.addEventListener("click", e => {
    if (pendingPostId && e.target.closest('[data-testid="tweetButton"]')) {
      const id = pendingPostId; pendingPostId = null;
      chrome.runtime.sendMessage({ type: "markPosted", id });
    }
  }, true);

  // ---------- batch: draft ideas for the next 10 posts in your feed ----------
  const batchBtn = document.createElement("button");
  batchBtn.id = "srh-batch";
  batchBtn.textContent = "Draft next 10";
  document.body.appendChild(batchBtn);
  batchBtn.onclick = async () => {
    const posts = [...document.querySelectorAll('article[data-testid="tweet"]')]
      .filter(a => a.getBoundingClientRect().bottom > 0 && !a.querySelector(".srh-panel"))
      .slice(0, 10);
    batchBtn.disabled = true;
    let n = 0;
    const queue = [...posts];
    const worker = async () => {
      while (queue.length) {
        const a = queue.shift();
        const bar = a.querySelector('[role="group"]');
        if (bar) { await showPanel(a, bar); n++; batchBtn.textContent = `Drafting ${n}/${posts.length}`; }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    batchBtn.textContent = "Draft next 10";
    batchBtn.disabled = false;
  };

  function addButton(article) {
    if (article.dataset.srh) return;
    const bar = article.querySelector('[role="group"]');
    if (!bar) return;
    article.dataset.srh = "1";
    const btn = document.createElement("button");
    btn.className = "srh-btn";
    btn.textContent = "✨ Reply ideas";
    btn.onclick = e => { e.preventDefault(); e.stopPropagation(); showPanel(article, bar); };
    bar.appendChild(btn);
  }

  const scan = () => document.querySelectorAll('article[data-testid="tweet"]').forEach(addButton);
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();
})();
