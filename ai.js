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
  voice:
    "I'm Sammy (@sammychrise), an AI filmmaker and software engineer who loves movies. " +
    "Reply to posts on X the way a real person would: simple, natural, and making sense with the post."
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
  let lastErr;
  for (let i = 0; i < 4; i++) {
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(45000), headers: { "content-type": "application/json", "x-goog-api-key": k.geminiKey }, body }).catch(e => ({ ok: false, status: 0, json: async () => ({ error: { message: e.message } }) }));
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const out = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
      if (out) { try { return parseJSON(out); } catch (e) { lastErr = e; } }
      else lastErr = new Error("Gemini sent an empty answer.");
    } else {
      lastErr = new Error("Gemini: " + (data?.error?.message || `error ${res.status}`));
      if (![0, 429, 500, 503].includes(res.status)) throw lastErr;
    }
    await new Promise(r => setTimeout(r, (res.status === 429 ? 6000 : 2000) * (i + 1))); // busy: wait and try again
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
      countCall(who);
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
  if (it.grok) lines.push(`Grok's explanation of the post:\n${it.grok}`);
  if (p.replies?.length) lines.push("Replies other people already left (context only):\n" + p.replies.map((r, i) => `${i + 1}. ${r.slice(0, 280)}`).join("\n"));
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

function styleRules(ap) {
  return (
    "\n\nHow to write:\n" +
    "- Sound like a normal person typing on their phone: plain everyday words, sentences that flow and connect.\n" +
    "- Let the post decide the language, tone and length.\n" +
    "- React to the specific thing in this post: a thought, a joke, an opinion or a question about it.\n" +
    "- Never use dashes (— or –) to join sentences, no semicolons, no hashtags, at most one emoji.\n" +
    `- Never use these words or phrases: ${ap.bannedWords}.\n` +
    "- No lists of three, no \"it's not just X, it's Y\", don't open with a compliment or with \"Ah\".\n" +
    "- Don't make up things that happened to you, and don't promote anything."
  );
}

export async function write(it, ap) {
  const k = await keys();
  const task =
    "\n\nWrite 3 different replies to this post. Use the other replies only to understand the post, don't copy them.\n" +
    "If the post is a giveaway, bait, a scam, a tragedy or politics, or you can't tell what it's about, set skip to true and say why in a few words.\n" +
    'Answer with JSON only: {"skip": false, "reason": "", "replies": ["...", "...", "..."]}';
  const { out, via } = await run(ap.writer, "writer", k.voice + styleRules(ap), postContext(it) + task, [], 600);
  return { skip: !!out.skip, reason: String(out.reason || ""), replies: (out.replies || []).map(String).filter(r => r.trim()).slice(0, 3), via };
}

const REVIEWER =
  "You are a strict editor checking reply drafts for a creator's X account before they go out. You did not write them. " +
  "Judge each draft only against the post:\n" +
  "1. Fits THIS post specifically (would make no sense under a different post).\n" +
  "2. Adds something: a real opinion, joke, insight or question, not just 'lol' or 'facts'.\n" +
  "3. Accurate: doesn't misread the picture, video or joke, no invented facts or personal stories.\n" +
  "4. Safe: not rude, not offensive, not spammy, no self-promotion.\n" +
  "5. Sounds like a real person typing, not an AI: plain words, natural flow. Dashes, buzzwords, stiff or polished wording lose points.\n" +
  "Score each draft 1-10. Give 4 or less to any that fails 1, 3 or 4.";

export async function review(it, drafts, ap) {
  const task =
    `\n\nBanned words for this account: ${ap.bannedWords}.\n\nDrafts:\n` + drafts.map((r, i) => `${i}. ${r}`).join("\n") +
    '\n\nAnswer with JSON only: {"scores": [n, n, n], "best": index, "notes": ["very short reason per draft"]}';
  const { out, via } = await run(ap.reviewer, "reviewer", REVIEWER, postContext(it) + task, [], 400);
  return { scores: (out.scores || []).map(Number), best: Number.isInteger(out.best) ? out.best : 0, notes: (out.notes || []).map(String), via };
}

// Free check on our side: things that make a reply look AI-written.
export function styleProblems(reply, ap) {
  const issues = [];
  if (/[—–]/.test(reply)) issues.push("dash");
  if (/;/.test(reply)) issues.push("semicolon");
  if (/(^|\s)#\w/.test(reply)) issues.push("hashtag");
  if ((reply.match(/\p{Extended_Pictographic}/gu) || []).length > 2) issues.push("too many emojis");
  const banned = String(ap.bannedWords || "").split(",").map(w => w.trim().toLowerCase()).filter(Boolean);
  const low = reply.toLowerCase();
  for (const w of banned) {
    const re = new RegExp("(^|[^\\p{L}])" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?=$|[^\\p{L}])", "iu");
    if (re.test(low)) issues.push(`"${w}"`);
  }
  return issues;
}
