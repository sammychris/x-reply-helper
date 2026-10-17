// Reads a post (text + images) and asks an AI for reply ideas.
// Claude is the main AI; Google Gemini is the backup when Claude has no key, no credit or an error.
const DEFAULTS = {
  provider: "auto", // "auto" = Claude first, Gemini if Claude fails; or "claude" / "gemini"
  apiKey: "",
  model: "claude-haiku-5-5",
  geminiKey: "",
  geminiModel: "gemini-3.1-flash-lite",
  goal: 300,
  sendImages: true, // read the post's pictures; turn off to send text only
  reviewer: true,
  reviewWithGemini: false, // the reviewer doubles Gemini requests; off by default to stay inside free limits
  reviewerModel: "claude-haiku-5-5",
  voice:
    "I'm Sammy (@sammychrise), an AI filmmaker and software engineer who loves movies. " +
    "Reply to posts on X the way a real person would: simple, natural, and making sense with the post."
};

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

// If an older version saved "gemini-3.6-flash" in your settings, switch it to the model from your old extension.
chrome.runtime.onInstalled.addListener(async () => {
  const { geminiModel } = await chrome.storage.sync.get("geminiModel");
  if (!geminiModel || geminiModel === "gemini-3.6-flash") await chrome.storage.sync.set({ geminiModel: "gemini-3.1-flash-lite" });
});

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(DEFAULTS))) };
}

function postContext(post, withImages) {
  return (
    `Post on X by ${post.author || "unknown"}:\n"""${post.text || "(no text)"}"""\n` +
    (post.images.length ? `It has ${post.images.length} image(s)${withImages ? " shown above" : " (not available)"}.\n` : "") +
    (post.hasVideo ? "It contains a video (only its preview image, if any, is shown).\n" : "") +
    (post.quoted ? `It quotes this other post:\n"""${post.quoted}"""\n` : "") +
    (post.replies && post.replies.length
      ? `Replies other people already left (context only):\n` + post.replies.map((r, i) => `${i + 1}. ${r.slice(0, 280)}`).join("\n") + "\n"
      : "")
  );
}

const WRITER_TASK =
  "\nWrite 3 different replies to this post. Let the post decide the language, tone and length. " +
  "Use the other replies only to understand the post, don't copy them.\n" +
  "If the post is a giveaway, bait, a scam, a tragedy or politics, set skip to true and say why.\n" +
  'Answer with JSON only: {"skip": false, "reason": "", "replies": ["...", "...", "..."]}';

function parseJSON(text) {
  const match = (text || "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Couldn't read the AI's answer. Try again.");
  return JSON.parse(match[0]);
}

// ---------- Claude ----------
async function askClaude(s, model, system, images, text, maxTokens) {
  if (!s.apiKey) throw new Error("No Claude API key.");
  const content = [...images.map(url => ({ type: "image", source: { type: "url", url } })), { type: "text", text }];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": s.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content }] })
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Claude: " + (data?.error?.message || `error ${res.status}`));
  return parseJSON((data.content || []).filter(b => b.type === "text").map(b => b.text).join(""));
}

// ---------- Google Gemini ----------
async function toBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("image fetch failed");
  const mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mime_type: mime, data: btoa(bin) };
}

async function askGemini(s, system, images, text, maxTokens) {
  if (!s.geminiKey) throw new Error("No Google Gemini API key.");
  const parts = [];
  for (const url of images) {
    try { parts.push({ inline_data: await toBase64(url) }); } catch (_) { /* skip images that won't load */ }
  }
  parts.push({ text });
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: "MINIMAL" }, // same as your old extension: fast, no long "thinking"
      temperature: 0.7,
      maxOutputTokens: Math.max(maxTokens, 1000)
    }
  });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.geminiModel)}:generateContent`;
  // Retry like your old extension: busy/overloaded errors (429, 500, 503) usually pass after a short wait.
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": s.geminiKey }, body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastErr = new Error("Gemini: " + (data?.error?.message || `error ${res.status}`));
        if ([429, 500, 503].includes(res.status) && i < 2) { await new Promise(r => setTimeout(r, 2000 * (i + 1))); continue; }
        throw lastErr;
      }
      const out = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
      if (!out) throw new Error("Gemini sent an empty answer.");
      return parseJSON(out);
    } catch (e) {
      lastErr = e;
      if (i < 2) await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw lastErr;
}

// ---------- pick the AI ----------
let lastUsed = "";
async function ask(role, system, post, withImages, task, maxTokens) {
  const s = await settings();
  const images = withImages ? post.images.slice(0, 4) : [];
  const text = postContext(post, withImages) + task;
  const claudeModel = role === "reviewer" ? s.reviewerModel : s.model;
  if (s.provider === "gemini") { lastUsed = "Gemini"; return askGemini(s, system, images, text, maxTokens); }
  if (s.provider === "claude") { lastUsed = "Claude"; return askClaude(s, claudeModel, system, images, text, maxTokens); }
  // auto: Claude first, Gemini as backup
  try {
    lastUsed = "Claude";
    return await askClaude(s, claudeModel, system, images, text, maxTokens);
  } catch (e) {
    if (!s.geminiKey) throw e;
    lastUsed = "Gemini (backup)";
    return askGemini(s, system, images, text, maxTokens);
  }
}

// AI 1: the writer drafts 3 replies.
async function write(post, withImages) {
  const s = await settings();
  const parsed = await ask("writer", s.voice, post, withImages, WRITER_TASK, 600);
  return { skip: !!parsed.skip, reason: parsed.reason || "", replies: (parsed.replies || []).slice(0, 3) };
}

// AI 2: a separate reviewer that never saw the writer's instructions checks each draft against the post.
const REVIEWER =
  "You are a strict editor reviewing reply drafts for a creator's X account before he posts them. " +
  "You did not write them. Judge each draft only against the post (and its images, quoted post and other replies):\n" +
  "1. Fits THIS post specifically (would make no sense under a different post).\n" +
  "2. Adds something: a real opinion, insight or question, not just a reaction like 'lol' or 'facts'.\n" +
  "3. Accurate: no misreading of the image or joke, no invented facts or personal experiences.\n" +
  "4. Safe: not rude, not offensive, not spammy, no self-promotion.\n" +
  "5. Sounds like a real person and matches the post's language and tone.\n" +
  "Score each draft 1-10. Reject (score 4 or less) any that fails 1, 3 or 4.";

async function review(post, withImages, replies) {
  const task =
    "\nDrafts:\n" + replies.map((r, i) => `${i}. ${r}`).join("\n") +
    '\n\nAnswer with JSON only: {"scores": [n, n, n], "best": index, "notes": ["very short reason per draft", ...]}';
  const r = await ask("reviewer", REVIEWER, post, withImages, task, 400);
  return { scores: r.scores || [], best: Number.isInteger(r.best) ? r.best : 0, notes: r.notes || [] };
}

async function draftAndReview(post, withImages) {
  const s = await settings();
  const out = await write(post, withImages);
  const usedGemini = lastUsed.startsWith("Gemini");
  if (s.reviewer && out.replies.length && !(usedGemini && !s.reviewWithGemini)) {
    try { out.review = await review(post, withImages, out.replies); }
    catch (e) { out.note = "Reviewer unavailable: " + e.message; }
  }
  out.via = lastUsed;
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "draft") {
    (async () => {
      try {
        try {
          const useImages = (await settings()).sendImages !== false && msg.post.images.length > 0;
          sendResponse({ ok: true, ...(await draftAndReview(msg.post, useImages)), ...(useImages || !msg.post.images.length ? {} : { note: "Images are off in Settings: text only." }) });
        } catch (e) {
          // If an image couldn't be loaded, retry with text only.
          if (msg.post.images.length && /image|url|fetch/i.test(e.message)) {
            sendResponse({ ok: true, ...(await draftAndReview(msg.post, false)), note: "Images couldn't be read; used text only." });
          } else throw e;
        }
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // keep the channel open for the async reply
  }
  if (msg.type === "getBatch") {
    getBatch(msg.size || 10).then(sendResponse);
    return true;
  }
  if (msg.type === "markPosted") {
    markPosted(msg.id).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "getGoal") {
    settings().then(s => sendResponse({ goal: s.goal }));
    return true;
  }
});

// ---------- post picker: your text bank ----------
let bundled = null;
async function allPosts() {
  if (!bundled) bundled = await (await fetch(chrome.runtime.getURL("posts.json"))).json();
  const { customPosts = [] } = await chrome.storage.local.get("customPosts");
  return [...customPosts, ...bundled];
}
async function getBatch(size) {
  const { posted = {} } = await chrome.storage.local.get("posted");
  const left = (await allPosts()).filter(p => !posted[p.id]);
  for (let i = left.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [left[i], left[j]] = [left[j], left[i]]; }
  return { posts: left.slice(0, size), remaining: left.length };
}
async function markPosted(id) {
  const { posted = {} } = await chrome.storage.local.get("posted");
  posted[id] = new Date().toISOString();
  await chrome.storage.local.set({ posted });
}
