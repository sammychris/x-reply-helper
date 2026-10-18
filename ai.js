import { writerPrompt, writerTask, REVIEWER as REVIEW_RULES, styleProblems as checkStyle, DEFAULT_VOICE } from "./prompts.js";
// AI calls for Autopilot. Three jobs:
//  reader   - looks at pictures / video frames once and turns them into a short description
//  writer   - drafts 3 replies from text only (post + description + other replies)
//  reviewer - a separate AI scores the drafts and picks the most natural one
const KEY_DEFAULTS = {
  apiKey: "",
  model: "claude-haiku-5-5",
  reviewerModel: "claude-haiku-5-5",
  geminiKey: "",
  geminiModel: "gemini-3.1-flash-lite",
  voice: DEFAULT_VOICE
};
export async function keys() {
  const k = { ...KEY_DEFAULTS, ...(await chrome.storage.sync.get(Object.keys(KEY_DEFAULTS))) };
  if (!k.voice) k.voice = KEY_DEFAULTS.voice;
  return k;
}

function parseJSON(text) {
  const m = (text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Couldn't read the AI's answer.");
  return JSON.parse(m[0]);
}

// media: [{url}] for X pictures, [{data: "data:image/jpeg;base64,..."}] for video frames
async function claude(k, model, system, text, media, maxTokens) {
  if (!k.apiKey) throw new Error("No Claude API key in Settings.");
  const content = media.map(m =>
    m.url
      ? { type: "image", source: { type: "url", url: m.url } }
      : { type: "image", source: { type: "base64", media_type: m.data.slice(5, m.data.indexOf(";")), data: m.data.split(",")[1] } }
  );
  content.push({ type: "text", text });
  countCall("claude");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(45000), // never wait forever on a stuck request
    headers: {
      "content-type": "application/json",
      "x-api-key": k.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content }] })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("Claude: " + (data?.error?.message || `error ${res.status}`));
  return parseJSON((data.content || []).filter(b => b.type === "text").map(b => b.text).join(""));
}

async function toInline(m) {
  if (m.data) return { mime_type: m.data.slice(5, m.data.indexOf(";")), data: m.data.split(",")[1] };
  const res = await fetch(m.url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error("image fetch failed");
  const mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
  const bytes = new Uint8Array(await res.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mime_type: mime, data: btoa(bin) };
}

async function gemini(k, system, text, media, maxTokens) {
  if (!k.geminiKey) throw new Error("No Google Gemini API key in Settings.");
  const parts = [];
  for (const m of media) { try { parts.push({ inline_data: await toInline(m) }); } catch (_) { /* skip a picture that won't load */ } }
  parts.push({ text });
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig: { thinkingConfig: { thinkingLevel: "MINIMAL" }, temperature: 0.8, maxOutputTokens: Math.max(maxTokens, 1000) }
  });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(k.geminiModel)}:generateContent`;
  // When Gemini is busy, retrying fast only adds to the overload: try 3 times in total, waiting longer each time.
  let lastErr;
  for (let i = 0; i < 3; i++) {
    countCall("gemini"); // every request counts, retries too
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(45000), headers: { "content-type": "application/json", "x-goog-api-key": k.geminiKey }, body }).catch(e => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }));
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const out = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
      if (out) { try { return parseJSON(out); } catch (e) { lastErr = e; } }
      else lastErr = new Error("Gemini sent an empty answer.");
    } else {
      lastErr = new Error("Gemini: " + (data?.error?.message || `error ${res.status}`));
      if (![0, 429, 500, 503].includes(res.status)) throw lastErr; // wrong key / bad request: never retried
    }
    if (i < 2) await new Promise(r => setTimeout(r, res.status === 429 ? [15000, 30000][i] : [8000, 20000][i])); // busy: wait, then try again
  }
  throw lastErr;
}

// How many AI calls today (shown in the control center, so you can watch Gemini's free daily limit).
let usageChain = Promise.resolve();
function countCall(who) {
  usageChain = usageChain.then(async () => { // one at a time, so parallel calls aren't lost
    const day = new Date().toISOString().slice(0, 10);
    const { apUsage = {} } = await chrome.storage.local.get("apUsage");
    const u = apUsage[day] || { gemini: 0, claude: 0 };
    u[who]++;
    await chrome.storage.local.set({ apUsage: { [day]: u } }); // only today is kept
  }).catch(() => {});
}

// Use the AI you picked; if it has no key or fails, try the other one.
async function run(pick, role, system, text, media, maxTokens) {
  const k = await keys();
  const order = pick === "claude" ? ["claude", "gemini"] : ["gemini", "claude"];
  let lastErr;
  for (const who of order) {
    try {
      const out = who === "claude"
        ? await claude(k, role === "reviewer" ? k.reviewerModel : k.model, system, text, media, maxTokens)
        : await gemini(k, system, text, media, maxTokens);
      return { out, via: who === "claude" ? "Claude" : "Gemini" };
    } catch (e) {
      lastErr = e;
      if (!(who === "claude" ? k.geminiKey : k.apiKey)) break; // no backup key
    }
  }
  throw lastErr;
}

export function postContext(it) {
  const p = it.post || {};
  const lines = [`Post on X by @${p.handle || it.handle || "unknown"}:`, `"""${p.text || "(no text)"}"""`];
  if (p.quoted) lines.push(`It quotes this other post:\n"""${p.quoted}"""`);
  if (p.type === "image") lines.push("It has a picture.");
  if (p.type === "video") lines.push("It has a video.");
  if (p.alts?.length) lines.push("Picture description written by the poster: " + p.alts.join(" | "));
  if (it.desc) lines.push(`What's in the ${p.type === "video" ? "video" : "picture"}: ${it.desc}`);
  if (p.grokReply) lines.push(`Grok's explanation (from the replies):\n${p.grokReply.slice(0, 1200)}`);
  if (it.grok) lines.push(`Grok's explanation of the post:\n${it.grok}`);
  // 6 replies, trimmed, are enough context and keep each request small
  if (p.replies?.length) lines.push("Replies other people already left (context only):\n" + p.replies.slice(0, 6).map((r, i) => `${i + 1}. ${r.slice(0, 200)}`).join("\n"));
  return lines.join("\n");
}

const READER =
  "You look at the pictures from a post on X and say plainly what is in them, so someone who can't see them can reply well. " +
  "Read any words in the picture exactly. If it's a meme, say what the joke is. If the pictures are frames from a video, say what seems to happen. " +
  "If it's a movie or show you recognise, say which. Under 80 words.";

export async function describe(it, media, ap) {
  const p = it.post;
  const text =
    `Post text: """${p.text || "(no text)"}"""\n` +
    (p.type === "video" ? "The pictures are the preview and frames from the post's video.\n" : "") +
    (p.replies?.length ? "Some replies, which may explain it:\n" + p.replies.slice(0, 5).map(r => "- " + r.slice(0, 200)).join("\n") + "\n" : "") +
    '\nAnswer with JSON only: {"description": "...", "understood": true}. Set understood to false if you can\'t tell what the picture or video is about.';
  const { out, via } = await run(ap.reader, "reader", READER, text, media, 300);
  return { description: String(out.description || ""), understood: out.understood !== false, via };
}

// Writer: the style comes from Settings (auto / opinion / reaction), or is forced when you rewrite one post.
export async function write(it, ap, forceMode) {
  const k = await keys();
  const mode = forceMode || ap.replyMode || "auto";
  const { out, via } = await run(ap.writer, "writer", writerPrompt(mode, k.voice), postContext(it) + writerTask(mode), [], 600);
  const used = mode === "auto" ? (out.mode === "reaction" ? "reaction" : "opinion") : mode;
  return { mode: used, skip: !!out.skip, reason: String(out.reason || ""), replies: (out.replies || []).map(String).filter(r => r.trim()).slice(0, 3), via };
}

export async function review(it, drafts, ap, mode) {
  // No Claude key: skip the AI reviewer instead of spending another Gemini call (the free local check still runs).
  // Same as the Reply ideas button. Pick Gemini as the reviewer in the control center if you want it anyway.
  if (ap.reviewer !== "gemini" && !(await keys()).apiKey) return null;
  const task =
    `\n\nThese drafts are ${mode === "reaction" ? "REACTION" : "OPINION"} replies.\nBanned words for this account: ${ap.bannedWords}.\n\nDrafts:\n` + drafts.map((r, i) => `${i}. ${r}`).join("\n") +
    '\n\nAnswer with JSON only: {"scores": [n, n, n], "best": index, "notes": ["very short reason per draft"]}';
  const { out, via } = await run(ap.reviewer, "reviewer", REVIEW_RULES, postContext(it) + task, [], 400);
  return { scores: (out.scores || []).map(Number), best: Number.isInteger(out.best) ? out.best : 0, notes: (out.notes || []).map(String), via };
}

// Free check on our side for AI-sounding writing (rules live in prompts.js).
export function styleProblems(reply, ap, mode) {
  return checkStyle(reply, ap.bannedWords, mode);
}
