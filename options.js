const KEYS = ["provider", "apiKey", "model", "geminiKey", "geminiModel", "goal", "voice", "reviewerModel"];
const DEFAULTS = { provider: "auto", model: "claude-haiku-5-5", geminiModel: "gemini-3.1-flash-lite", goal: 300, reviewerModel: "claude-haiku-5-5" };
chrome.storage.sync.get([...KEYS, "reviewer", "sendImages"]).then(v => {
  document.getElementById("sendImages").checked = v.sendImages !== false;
  KEYS.forEach(k => { document.getElementById(k).value = v[k] ?? DEFAULTS[k] ?? ""; });
  document.getElementById("reviewer").checked = v.reviewer !== false;
  if (!v.voice) document.getElementById("voice").placeholder = "Leave empty to use the built-in Sammy voice.";
});
document.getElementById("save").onclick = async () => {
  const v = { reviewer: document.getElementById("reviewer").checked, sendImages: document.getElementById("sendImages").checked };
  KEYS.forEach(k => { const val = document.getElementById(k).value.trim(); if (val) v[k] = k === "goal" ? Number(val) : val; });
  await chrome.storage.sync.set(v);
  document.getElementById("s").textContent = "Saved";
};

// ---------- post bank ----------
async function bankInfo() {
  const bundled = await (await fetch(chrome.runtime.getURL("posts.json"))).json();
  const { customPosts = [], posted = {} } = await chrome.storage.local.get(["customPosts", "posted"]);
  const total = bundled.length + customPosts.length;
  document.getElementById("bankinfo").textContent = `${total} posts in your bank (${customPosts.length} added by you). ${Object.keys(posted).length} posted so far.`;
  return { all: [...customPosts, ...bundled], posted };
}
bankInfo();

function parseCSVLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur); return out;
}

// ---- read .xlsx files (like X-Text-Bank.xlsx) without any extra library ----
async function unzipEntries(buf) {
  const v = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Not a valid .xlsx file.");
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const files = {};
  for (let n = 0; n < count; n++) {
    const method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true), extraLen = v.getUint16(p + 30, true), commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    files[name] = { method, data: u8.subarray(start, start + size) };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}
async function entryText(e) {
  if (!e) return "";
  if (e.method === 0) return new TextDecoder().decode(e.data);
  const stream = new Blob([e.data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return await new Response(stream).text();
}
function colIndex(ref) {
  const letters = ref.replace(/[0-9]/g, "");
  let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
async function postsFromXlsx(buf) {
  const files = await unzipEntries(buf);
  const dom = s => new DOMParser().parseFromString(s, "application/xml");
  const shared = [...dom(await entryText(files["xl/sharedStrings.xml"])).getElementsByTagName("si")].map(si =>
    [...si.getElementsByTagName("t")].map(t => t.textContent).join(""));
  const sheets = Object.keys(files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
  for (const name of sheets) {
    const rows = [...dom(await entryText(files[name])).getElementsByTagName("row")].map(row => {
      const cells = [];
      for (const c of row.getElementsByTagName("c")) {
        const t = c.getAttribute("t"), vEl = c.getElementsByTagName("v")[0];
        let val = "";
        if (t === "s" && vEl) val = shared[Number(vEl.textContent)] || "";
        else if (t === "inlineStr") val = [...c.getElementsByTagName("t")].map(x => x.textContent).join("");
        else if (vEl) val = vEl.textContent;
        cells[colIndex(c.getAttribute("r"))] = val;
      }
      return cells;
    });
    if (!rows.length) continue;
    const head = (rows[0] || []).map(h => String(h || "").trim().toLowerCase());
    const col = head.findIndex(h => h.startsWith("post"));
    if (col < 0) continue;
    const used = head.findIndex(h => h.startsWith("used"));
    return rows.slice(1)
      .filter(r => r[col] && !(used >= 0 && String(r[used]).toLowerCase() === "yes"))
      .map(r => String(r[col]).trim());
  }
  throw new Error('No column named "Post" was found in this file.');
}

document.getElementById("importFile").onchange = async e => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const name = file.name.toLowerCase();
    let posts;
    if (name.endsWith(".xlsx")) {
      posts = await postsFromXlsx(await file.arrayBuffer());
    } else {
      const text = await file.text();
      let lines = text.split(/\r?\n/).filter(l => l.trim());
      if (name.endsWith(".csv")) {
        const head = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
        let col = head.findIndex(h => h.startsWith("post"));
        if (col < 0) col = 0; else lines = lines.slice(1);
        posts = lines.map(l => parseCSVLine(l)[col]).filter(Boolean);
      } else posts = lines;
    }
    // Skip posts already in the bank, so importing the same file twice doesn't double them.
    const { all } = await bankInfo();
    const have = new Set(all.map(p => p.text.trim()));
    const fresh = [...new Set(posts.map(t => t.trim()))].filter(t => t && !have.has(t));
    const { customPosts = [] } = await chrome.storage.local.get("customPosts");
    const stamp = Date.now();
    fresh.forEach((t, i) => customPosts.push({ id: `c${stamp}-${i}`, cat: "Added", text: t }));
    await chrome.storage.local.set({ customPosts });
    alert(`Added ${fresh.length} new posts. ${posts.length - fresh.length} were already in your bank.`);
  } catch (err) {
    alert("Couldn't read that file: " + err.message);
  }
  e.target.value = "";
  bankInfo();
};

document.getElementById("exportBtn").onclick = async () => {
  const { all, posted } = await bankInfo();
  const rows = [["Post", "Category", "Posted on"]].concat(
    all.filter(p => posted[p.id]).map(p => [p.text, p.cat, posted[p.id].slice(0, 16).replace("T", " ")])
  );
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: "posted-posts.csv" });
  a.click();
};

document.getElementById("resetBtn").onclick = async () => {
  if (!confirm("Mark every post as unused again?")) return;
  await chrome.storage.local.set({ posted: {} });
  bankInfo();
};
