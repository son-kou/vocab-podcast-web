/* Vocab Podcast Web — transcript sync + vocab hover + mastery levels + Anki export */

const audioInput = document.getElementById("audioInput");
const transcriptInput = document.getElementById("transcriptInput");
const loadSample = document.getElementById("loadSample");
const episodeSelect = document.getElementById("episodeSelect");
const loadEpisodeBtn = document.getElementById("loadEpisode");
const playerSection = document.getElementById("player");
const audio = document.getElementById("audio");
const transcriptContainer = document.getElementById("transcriptContainer");
const sentenceTemplate = document.getElementById("sentenceTemplate");
const speed = document.getElementById("speed");
const vocabList = document.getElementById("vocabList");
const vocabStats = document.getElementById("vocabStats");
const exportAnki = document.getElementById("exportAnki");
const ttsSpeakBtn = document.getElementById("ttsSpeak");
const useTTSCheckbox = document.getElementById("useTTS");
const ttsAutoCheckbox = document.getElementById("ttsAuto");
let ttsAutoPlaying = false;

const tabPodcast = document.getElementById("tabPodcast");
const tabReading = document.getElementById("tabReading");
const readingInput = document.getElementById("readingInput");
const readingPreview = document.getElementById("readingPreview");
const saveArticleBtn = document.getElementById("saveArticle");
const clearArticleBtn = document.getElementById("clearArticle");

const STORAGE_KEY_MASTERY = "vocab_podcast_mastery_v2";
const STORAGE_KEY_FLAGGED_REVIEWED = "vocab_podcast_flagged_reviewed_v1";

let sentences = [];
let vocabIndex = {};        // surface form -> {lemma, zh, en, rank, pos}
let vocabSurfaceToKey = {}; // normalized surface -> key in vocabIndex
let vocabDetail = {};       // lemma.toLowerCase() -> {ipa, example_da, example_zh, mnemonic, warning, confusing}
let userMastery = {};       // lemma -> {level:1-5, interval:N, reps:N}  OR  true/false (legacy)
let flaggedEntries = [];
let selectedSet = new Set();
let flaggedReviewedSet = new Set();
let contentWordKeys = new Set(); // surface keys that appear in the current transcript/article

let currentHoveredSurface = null;
const wiktionaryCache = new Map();

// ── Auth ──────────────────────────────────────────────────────────────────────
// Default password: "vocab2024" — replace AUTH_HASH with SHA-256 of your password.
// In browser console: crypto.subtle.digest('SHA-256', new TextEncoder().encode('yourpw'))
//   .then(b => console.log(Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('')))
const AUTH_HASH = "e48971b4ee5ef14bbe1bb3189045cc1e9853cc7fb3d9075dd75b3509dc1a3f6b";
const STORAGE_KEY_AUTH = "vocab_auth_v1";

function isLoggedIn() {
  return sessionStorage.getItem(STORAGE_KEY_AUTH) === "ok";
}

async function verifyPassword(pw) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(pw));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  return hex === AUTH_HASH;
}

function updateAuthUI() {
  const loggedIn = isLoggedIn();
  document.querySelectorAll(".auth-required").forEach(el => {
    el.style.display = loggedIn ? "" : "none";
  });
  const loginBtn = document.getElementById("loginBtn");
  if (loginBtn) loginBtn.textContent = loggedIn ? "Logout" : "Login";
}

async function handleLoginBtn() {
  if (isLoggedIn()) {
    sessionStorage.removeItem(STORAGE_KEY_AUTH);
    updateAuthUI();
    return;
  }
  const pw = prompt("Password:");
  if (!pw) return;
  if (await verifyPassword(pw)) {
    sessionStorage.setItem(STORAGE_KEY_AUTH, "ok");
    updateAuthUI();
  } else {
    alert("Wrong password.");
  }
}

// ── Persistence ──────────────────────────────────────────────────────────────

function loadPersistence() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MASTERY);
    if (raw) userMastery = JSON.parse(raw);
  } catch (e) {
    console.warn("failed to load mastery", e);
  }
  try {
    const raw2 = localStorage.getItem(STORAGE_KEY_FLAGGED_REVIEWED);
    if (raw2) JSON.parse(raw2).forEach((k) => flaggedReviewedSet.add(k));
  } catch (e) {}
}

function savePersistence() {
  try {
    localStorage.setItem(STORAGE_KEY_MASTERY, JSON.stringify(userMastery));
  } catch (e) {
    console.warn("save mastery failed", e);
  }
  try {
    localStorage.setItem(
      STORAGE_KEY_FLAGGED_REVIEWED,
      JSON.stringify(Array.from(flaggedReviewedSet)),
    );
  } catch (e) {}
}

loadPersistence();

// ── Mastery helpers ───────────────────────────────────────────────────────────

/**
 * Returns a mastery level 0-5 for a vocab key.
 * 0 = not tracked / not in Anki
 * 1-5 = Anki levels (see sync_with_anki.py)
 */
function getMasteryLevel(key) {
  // Try direct key (surface form), then fall back to lemma
  let m = userMastery[key];
  if ((m === undefined || m === null) && vocabIndex[key]?.lemma) {
    m = userMastery[vocabIndex[key].lemma.toLowerCase()];
  }
  if (m === undefined || m === null) return 0;
  if (typeof m === "boolean") return m ? 4 : 0;
  if (typeof m === "object") return m.level || 0;
  return 0;
}

function getMasteryLabel(level) {
  return ["未学", "新词", "学习中", "复习中", "已掌握", "精通"][level] || "";
}

/** Toggle mastery: 0 → 4 (known) or 4+ → 0 (remove).
 *  Stores under lemma key so it matches what Anki sync writes. */
function toggleMastery(key) {
  const lemmaKey = vocabIndex[key]?.lemma?.toLowerCase() || key;
  const cur = getMasteryLevel(key);
  if (cur >= 4) {
    delete userMastery[lemmaKey];
  } else {
    userMastery[lemmaKey] = { level: 4, interval: 0, reps: 0, manual: true };
  }
  savePersistence();
}

// ── Word span creation ────────────────────────────────────────────────────────

const RANK_HI_THRESHOLD = 800;

function applyMasteryClass(el, key, info) {
  // Remove all mastery/rank classes first
  el.classList.remove("known", "unknown", "rank-hi",
    "mastery-1", "mastery-2", "mastery-3", "mastery-4", "mastery-5");
  const level = getMasteryLevel(key);
  if (level >= 1) {
    el.classList.add(`mastery-${level}`);
  } else if (info && info.rank && info.rank <= RANK_HI_THRESHOLD) {
    // Important word not yet in Anki → warm amber hint
    el.classList.add("rank-hi");
  }
}

// displayText = original word (preserves case/punctuation for display)
// lookupKey   = normalized lowercase form for vocab lookup (optional, defaults to displayText)
function makeWordSpan(displayText, lookupKey) {
  const norm = lookupKey || displayText;
  const span = document.createElement("span");
  span.className = "word";
  span.textContent = displayText;
  span.addEventListener("mouseenter", onWordHover);
  span.addEventListener("mouseleave", onWordLeave);
  span.addEventListener("click", onWordClick);
  span.dataset.surface = norm;
  const key = vocabSurfaceToKey[norm] || norm;
  const info = vocabIndex[key] || null;
  applyMasteryClass(span, key, info);
  if (info || vocabSurfaceToKey[norm]) contentWordKeys.add(key);
  return span;
}

// ── Hover card ────────────────────────────────────────────────────────────────

let hoverCard = null;

let hoverHideTimer = null;

function scheduleHide() {
  clearTimeout(hoverHideTimer);
  hoverHideTimer = setTimeout(() => {
    if (hoverCard && !hoverCard.matches(":hover")) {
      hoverCard.style.display = "none";
      currentHoveredSurface = null;
    }
  }, 280);
}

function getHoverCard() {
  if (!hoverCard) {
    hoverCard = document.createElement("div");
    hoverCard.id = "hoverCard";
    hoverCard.className = "hoverCard";
    hoverCard.addEventListener("mouseenter", () => clearTimeout(hoverHideTimer));
    hoverCard.addEventListener("mouseleave", scheduleHide);
    document.body.appendChild(hoverCard);
  }
  return hoverCard;
}

function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function onWordHover(ev) {
  const surface = (ev.target.dataset.surface || ev.target.textContent || "").toLowerCase();
  currentHoveredSurface = surface;
  const key = vocabSurfaceToKey[surface];
  const info = key ? vocabIndex[key] : null;

  const card = getHoverCard();
  card.innerHTML = buildHoverHTML(surface, info, key);

  // Position: right of word, clamped to viewport
  const rect = ev.target.getBoundingClientRect();
  const cardW = 320;
  let left = rect.right + 8;
  if (left + cardW > window.innerWidth - 8) left = rect.left - cardW - 8;
  card.style.left = Math.max(4, left) + "px";
  card.style.top = Math.max(4, Math.min(rect.top, window.innerHeight - 380)) + "px";
  card.style.display = "block";
  card.style.pointerEvents = "auto";
  clearTimeout(hoverHideTimer);
  updateWiktSection(card, (info?.lemma || surface).toLowerCase(), surface);
}

function buildHoverHTML(surface, info, key) {
  let html;
  if (!info) {
    html = `<div class="hc-lemma">${escHtml(surface)}</div>
            <div class="hc-gloss-en" style="margin-top:4px">未在词表中</div>
            <hr class="hc-divider">
            ${externalLinks(surface)}`;
  } else {
    const lemma = info.lemma || surface;
    const level = getMasteryLevel(key);
    const detail = vocabDetail[lemma.toLowerCase()] || {};

    html = `<div class="hc-lemma">${escHtml(lemma)}`;
    html += `<span class="hc-meta">rank ${info.rank || "?"}${info.pos ? " · " + info.pos : ""}</span>`;
    if (level > 0) {
      html += `<span class="hc-mastery">${escHtml(getMasteryLabel(level))}</span>`;
    }
    html += `</div>`;

    if (detail.ipa) {
      html += `<div class="hc-ipa">/${escHtml(detail.ipa)}/</div>`;
    }

    if (info.zh) html += `<div class="hc-gloss-zh">${escHtml(info.zh)}</div>`;
    if (info.en) html += `<div class="hc-gloss-en">${escHtml(info.en)}</div>`;

    const hasExtra = detail.example_da || detail.mnemonic || detail.warning || (detail.confusing && detail.confusing.length);
    if (hasExtra) {
      html += `<hr class="hc-divider">`;
    }

    if (detail.example_da) {
      html += `<div class="hc-example">${escHtml(detail.example_da)}</div>`;
      if (detail.example_zh) {
        html += `<div class="hc-example-zh">${escHtml(detail.example_zh)}</div>`;
      }
    }

    if (detail.mnemonic) {
      html += `<div class="hc-mnemonic">💡 ${escHtml(detail.mnemonic)}</div>`;
    }

    if (detail.warning) {
      html += `<div class="hc-warning">⚠️ ${escHtml(detail.warning)}</div>`;
    }

    if (detail.confusing && detail.confusing.length) {
      html += `<div class="hc-confusing">混淆词: ${detail.confusing.map(escHtml).join(", ")}</div>`;
    }

    html += `<hr class="hc-divider">`;
    html += externalLinks(lemma);
  }
  // Wiktionary cross-reference section — populated asynchronously
  html += `<hr class="hc-divider"><div class="hc-wikt-section"></div>`;
  return html;
}

function externalLinks(word) {
  const enc = encodeURIComponent(word);
  return `<div class="hc-links">
    <a class="hc-link" href="https://ordnet.dk/ddo/ordbog?query=${enc}" target="_blank" rel="noopener">DDO</a>
    <a class="hc-link" href="https://en.wiktionary.org/wiki/${enc}#Danish" target="_blank" rel="noopener">Wiktionary</a>
  </div>`;
}

// ── Wiktionary cross-reference ────────────────────────────────────────────────

function stripHtml(s) {
  const d = document.createElement("div");
  d.innerHTML = s || "";
  return d.textContent || "";
}

function buildWiktHTML(entries) {
  if (!entries || entries.length === 0) {
    return '<div class="hc-wikt-empty">Wiktionary: 未找到丹麦语条目</div>';
  }
  let html = '<div class="hc-wikt-label">Wiktionary 互查</div>';
  for (const entry of entries.slice(0, 2)) {
    const pos = entry.partOfSpeech || "";
    if (pos) html += `<span class="hc-wikt-pos">${escHtml(pos)}</span> `;
    for (const def of (entry.definitions || []).slice(0, 2)) {
      const text = stripHtml(def.definition || "");
      if (text) html += `<div class="hc-wikt-def">${escHtml(text)}</div>`;
    }
  }
  return html;
}

async function updateWiktSection(card, lemma, surface) {
  const el = card.querySelector(".hc-wikt-section");
  if (!el) return;
  if (wiktionaryCache.has(lemma)) {
    el.innerHTML = buildWiktHTML(wiktionaryCache.get(lemma));
    return;
  }
  el.innerHTML = '<div class="hc-wikt-loading">Wiktionary…</div>';
  try {
    const resp = await fetch(
      `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(lemma)}`
    );
    const entries = resp.ok ? ((await resp.json()).da || []) : null;
    wiktionaryCache.set(lemma, entries);
    if (currentHoveredSurface === surface && card.style.display !== "none") {
      el.innerHTML = buildWiktHTML(entries);
    }
  } catch (e) {
    wiktionaryCache.set(lemma, null);
    if (currentHoveredSurface === surface && card.style.display !== "none") {
      el.innerHTML = '<div class="hc-wikt-empty">Wiktionary 查询失败</div>';
    }
  }
}

function onWordLeave() {
  scheduleHide();
}

function onWordClick(ev) {
  const surface = (ev.target.dataset.surface || ev.target.textContent || "").toLowerCase();
  const key = vocabSurfaceToKey[surface] || surface;
  toggleMastery(key);
  const info = vocabIndex[key] || null;
  applyMasteryClass(ev.target, key, info);
  // Update all other spans for the same key
  document.querySelectorAll(".word").forEach((el) => {
    const s = (el.dataset.surface || "").toLowerCase();
    const k = vocabSurfaceToKey[s] || s;
    if (k === key) applyMasteryClass(el, key, info);
  });
  renderVocabList();
}

// ── Transcript rendering ──────────────────────────────────────────────────────

function renderTranscript() {
  transcriptContainer.innerHTML = "";
  contentWordKeys.clear();
  sentences.forEach((s) => {
    const node = sentenceTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.start = s.start;
    node.dataset.end = s.end;
    const textSpan = node.querySelector(".text");
    const parts = s.text.replace(/\r?\n/g, " ").split(/(\s+)/);
    parts.forEach((p) => {
      if (/\s+/.test(p)) textSpan.appendChild(document.createTextNode(p));
      else {
        const norm = p.replace(/[.,!?;:()"""'«»–—]/g, "").toLowerCase();
        const display = p.replace(/[.,!?;:()"""'«»–—]/g, "");
        textSpan.appendChild(makeWordSpan(display, norm));
      }
    });
    node.addEventListener("click", () => {
      const useTTSChecked = useTTSCheckbox && useTTSCheckbox.checked;
      if (useTTSChecked || !audio.src) {
        speakText(s.text);
      } else {
        audio.currentTime = parseFloat(s.start) || 0;
        audio.play();
      }
    });
    transcriptContainer.appendChild(node);
  });
}

// ── TTS ───────────────────────────────────────────────────────────────────────

function speakText(text) {
  if (!("speechSynthesis" in window)) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text).replace(/\s+/g, " "));
      u.lang = "da-DK";
      let r = parseFloat(speed.value) || 1;
      if (!isFinite(r) || r <= 0) r = 1;
      u.rate = Math.min(Math.max(r, 0.5), 2.0);
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    } catch (e) {
      resolve();
    }
  });
}

async function startTTSAuto(fromIndex = 0) {
  if (!("speechSynthesis" in window)) return;
  ttsAutoPlaying = true;
  for (let i = fromIndex; i < sentences.length && ttsAutoPlaying; i++) {
    transcriptContainer.querySelectorAll(".sentence").forEach((n) => n.classList.remove("active"));
    const node = transcriptContainer.querySelectorAll(".sentence")[i];
    if (node) {
      node.classList.add("active");
      node.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    await speakText(sentences[i].text);
    if (!ttsAutoPlaying) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  ttsAutoPlaying = false;
  if (ttsAutoCheckbox) ttsAutoCheckbox.checked = false;
}

function stopTTSAuto() {
  ttsAutoPlaying = false;
  try { speechSynthesis.cancel(); } catch (e) {}
}

function speakCurrentSentence() {
  const active =
    transcriptContainer.querySelector(".sentence.active") ||
    transcriptContainer.querySelector(".sentence");
  if (!active) return;
  const idx = Array.from(transcriptContainer.querySelectorAll(".sentence")).indexOf(active);
  if (sentences[idx]) speakText(sentences[idx].text);
}

if (ttsSpeakBtn) ttsSpeakBtn.addEventListener("click", speakCurrentSentence);
if (ttsAutoCheckbox)
  ttsAutoCheckbox.addEventListener("change", (e) => {
    if (e.target.checked) startTTSAuto();
    else stopTTSAuto();
  });

// ── Vocab panel ───────────────────────────────────────────────────────────────

function renderVocabList() {
  vocabList.innerHTML = "";

  // Determine source: words in current content, or all if no content loaded
  const sourceKeys = contentWordKeys.size > 0
    ? Array.from(contentWordKeys)
    : Object.keys(vocabIndex);

  const entries = sourceKeys.map((k) => {
    const v = vocabIndex[k] || {};
    return { key: k, lemma: (v.lemma || k).toString(), rank: v.rank || 1000000 };
  });
  entries.sort((a, b) => a.rank - b.rank);

  // Deduplicate by lemma
  const seen = new Set();
  const unique = [];
  entries.forEach((e) => {
    const lk = e.lemma.toLowerCase();
    if (!seen.has(lk)) { seen.add(lk); unique.push(e); }
  });

  // Split into unknown (level < 4) and known
  const unknown = unique.filter((e) => getMasteryLevel(e.key) < 4);
  const knownCount = unique.length - unknown.length;

  if (unknown.length === 0 && contentWordKeys.size > 0) {
    vocabList.innerHTML = "<div style='color:#888;font-size:13px'>当前内容的单词都已掌握！</div>";
  }

  unknown.forEach((e) => {
    const l = e.key;
    const v = vocabIndex[l] || {};
    const chip = document.createElement("div");
    chip.className = "vocabChip";
    const level = getMasteryLevel(l);
    if (level >= 1) chip.classList.add(`mastery-${level}`);
    if (selectedSet.has(l)) chip.classList.add("selected");

    const textSpan = document.createElement("span");
    textSpan.textContent = `${v.lemma || l} — ${v.zh || ""}`;
    textSpan.style.marginRight = "8px";

    // Mark known button (auth-required)
    const knownBtn = document.createElement("button");
    knownBtn.textContent = "已掌握";
    knownBtn.className = "auth-required";
    knownBtn.style.fontSize = "11px";
    knownBtn.style.padding = "3px 8px";
    knownBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!isLoggedIn()) { alert("请先登录"); return; }
      toggleMastery(l);
      renderVocabList();
      document.querySelectorAll(".word").forEach((el) => {
        const s = (el.dataset.surface || "").toLowerCase();
        const k = vocabSurfaceToKey[s] || s;
        if (k === l) applyMasteryClass(el, k, vocabIndex[k] || null);
      });
    });

    const selBtn = document.createElement("button");
    selBtn.textContent = selectedSet.has(l) ? "Selected" : "Select";
    selBtn.style.fontSize = "11px";
    selBtn.style.padding = "3px 8px";
    selBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (selectedSet.has(l)) selectedSet.delete(l);
      else selectedSet.add(l);
      renderVocabList();
    });

    chip.appendChild(textSpan);
    chip.appendChild(knownBtn);
    chip.appendChild(selBtn);
    vocabList.appendChild(chip);
  });

  const total = unique.length;
  const src = contentWordKeys.size > 0 ? "本文" : "全库";
  vocabStats.textContent = `${src} ${total} 词  ·  生词 ${unknown.length}  ·  已掌握 ${knownCount}`;
  updateAuthUI();
}

// ── Anki export ───────────────────────────────────────────────────────────────

function exportAnkiTSV() {
  const rows = [];
  const keys = selectedSet.size ? Array.from(selectedSet) : Object.keys(vocabIndex);
  keys.forEach((k) => {
    const v = vocabIndex[k];
    if (!v) return;
    const level = getMasteryLevel(k);
    const front = v.lemma;
    const back = `${v.zh || ""} — ${v.en || ""}`;
    const tags = getMasteryLabel(level) || "未学";
    rows.push([front, back, tags].join("\t"));
  });
  const blob = new Blob([rows.join("\n")], { type: "text/tab-separated-values" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "vocab_anki_export.tsv";
  a.click();
}

if (loadSample) loadSample.addEventListener("click", loadSampleData);
if (exportAnki) exportAnki.addEventListener("click", exportAnkiTSV);

const exportSelectedFullBtn = document.getElementById("exportSelectedFull");
if (exportSelectedFullBtn) {
  exportSelectedFullBtn.addEventListener("click", () => {
    if (selectedSet.size === 0) {
      alert('No selected lemmas. Click "Select" on chips to choose words to export.');
      return;
    }
    const list = Array.from(selectedSet).map((s) =>
      vocabIndex[s] && vocabIndex[s].lemma ? vocabIndex[s].lemma : s,
    );
    const blob = new Blob([list.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "selected_lemmas.txt";
    a.click();
  });
}

// ── Audio controls ────────────────────────────────────────────────────────────

speed.addEventListener("change", () => {
  audio.playbackRate = parseFloat(speed.value);
});

audio.addEventListener("timeupdate", () => {
  const t = audio.currentTime;
  let active = null;
  for (const node of transcriptContainer.querySelectorAll(".sentence")) {
    const s = parseFloat(node.dataset.start), e = parseFloat(node.dataset.end);
    if (t >= s && t <= e) { active = node; break; }
  }
  transcriptContainer.querySelectorAll(".sentence").forEach((n) => n.classList.remove("active"));
  if (active) {
    active.classList.add("active");
    active.scrollIntoView({ behavior: "smooth", block: "center" });
  }
});

// ── File loaders ──────────────────────────────────────────────────────────────

transcriptInput.addEventListener("change", async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  const text = await f.text();
  sentences = text.includes("WEBVTT") ? parseVTT(text) : plainTextToSentences(text);
  renderTranscript();
  playerSection.classList.remove("hidden");
});

audioInput.addEventListener("change", (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  audio.src = URL.createObjectURL(f);
  playerSection.classList.remove("hidden");
});

function parseVTT(text) {
  const lines = text.split(/\r?\n/);
  const cues = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line && line.includes("-->")) {
      const parts = line.split("-->");
      const start = vttTimeToSec(parts[0].trim());
      const end = vttTimeToSec(parts[1].trim().split(/\s/)[0]);
      i++;
      let txt = "";
      while (i < lines.length && lines[i].trim()) { txt += lines[i] + "\n"; i++; }
      cues.push({ start, end, text: txt.trim() });
    } else { i++; }
  }
  return cues;
}

function vttTimeToSec(s) {
  const m = s.split(":").map(parseFloat);
  if (m.length === 3) return m[0] * 3600 + m[1] * 60 + m[2];
  if (m.length === 2) return m[0] * 60 + m[1];
  return parseFloat(s);
}

function plainTextToSentences(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.map((ln, i) => ({ start: i * 3, end: i * 3 + 3, text: ln }));
}

transcriptContainer.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && ev.target.classList.contains("word")) ev.target.click();
});

// ── Remote data loading ───────────────────────────────────────────────────────

async function loadRemoteIndex() {
  // vocab_index.json: surface form → {lemma, zh, en, rank, pos}
  try {
    const resp = await fetch("vocab_index.json");
    if (resp.ok) {
      const raw = await resp.json();
      vocabIndex = raw || {};
      Object.values(vocabIndex).forEach((v) => { v.rank = v.rank || 1000000; });
      vocabSurfaceToKey = {};
      Object.entries(vocabIndex).forEach(([k, v]) => {
        try {
          vocabSurfaceToKey[String(k).toLowerCase()] = k;
          if (v && v.lemma) vocabSurfaceToKey[String(v.lemma).toLowerCase()] = k;
        } catch (e) {}
      });
      renderVocabList();
      vocabStats.textContent = `${Object.keys(vocabIndex).length} 词索引已加载`;
    }
  } catch (e) {
    console.warn("vocab_index.json not available", e);
  }

  // vocab_detail.json: lemma → rich hover data
  try {
    const resp = await fetch("vocab_detail.json");
    if (resp.ok) {
      vocabDetail = (await resp.json()) || {};
    }
  } catch (e) {
    console.warn("vocab_detail.json not available", e);
  }

  // user_mastery.json: lemma → {level, interval, reps}  or legacy bool
  try {
    const r2 = await fetch("user_mastery.json");
    if (r2.ok) {
      const remote = await r2.json();
      Object.entries(remote).forEach(([k, v]) => {
        try { userMastery[k.toLowerCase()] = v; } catch (e) {}
      });
      savePersistence();
      renderVocabList();
      document.querySelectorAll(".word").forEach((el) => {
        const s = (el.dataset.surface || "").toLowerCase();
        const key = vocabSurfaceToKey[s] || s;
        applyMasteryClass(el, key, vocabIndex[key] || null);
      });
    }
  } catch (e) {}

  // flagged_entries.json
  try {
    const r = await fetch("flagged_entries.json");
    if (r.ok) { flaggedEntries = await r.json(); }
  } catch (e) {}
}

loadRemoteIndex();

// ── Sample data ───────────────────────────────────────────────────────────────

function loadSampleData() {
  sentences = [
    { start: 0.0, end: 4.0, text: "Hej, mit navn er Anna." },
    { start: 4.1, end: 9.0, text: "Jeg bor i København og jeg lærer dansk hver dag." },
  ];
  // tiny inline sample so hover works without the full index
  if (Object.keys(vocabIndex).length === 0) {
    vocabIndex = {
      hej: { lemma: "hej", zh: "嗨/你好", en: "hi", rank: 100 },
      navn: { lemma: "navn", zh: "名字", en: "name", rank: 500 },
      jeg: { lemma: "jeg", zh: "我", en: "I", rank: 1 },
      bor: { lemma: "bo", zh: "居住", en: "live", rank: 1200 },
      københavn: { lemma: "København", zh: "哥本哈根", en: "Copenhagen", rank: 2000 },
      lærer: { lemma: "lære", zh: "学习/教", en: "learn/teach", rank: 800 },
    };
    vocabSurfaceToKey = Object.fromEntries(Object.keys(vocabIndex).map((k) => [k, k]));
  }
  userMastery = {};
  audio.src = "";
  playerSection.classList.remove("hidden");
  renderTranscript();
  renderVocabList();
}

// ── Flagged entries panel ─────────────────────────────────────────────────────

const showFlaggedBtn = document.getElementById("showFlagged");
const flaggedPanelEl = document.getElementById("flaggedPanel");

function renderFlaggedPanel() {
  if (!flaggedPanelEl) return;
  flaggedPanelEl.innerHTML = "";
  const items = (flaggedEntries || []).filter((e) => {
    return !flaggedReviewedSet.has(`${e.source_file}:${e.source_line}`);
  });
  if (items.length === 0) {
    flaggedPanelEl.innerHTML = "<div>没有未处理的待复核条目。</div>";
    return;
  }
  const exportBtn = document.createElement("button");
  exportBtn.textContent = "Export flagged as JSON";
  exportBtn.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(items, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "flagged_entries.json";
    a.click();
  });
  flaggedPanelEl.appendChild(exportBtn);
  items.slice(0, 200).forEach((e) => {
    const div = document.createElement("div");
    div.style.cssText = "border-bottom:1px solid #eee;padding:6px";
    div.innerHTML = `<div><b>${escHtml(e.lemma || "?")}</b> — rank:${e.rank} — ${escHtml(e.source_file)}:${e.source_line}</div>
      <div style="color:#5f6b7a">notes: ${Array.isArray(e.notes) ? e.notes.map(escHtml).join(", ") : ""}</div>`;
    const btn = document.createElement("button");
    btn.textContent = "Mark reviewed";
    btn.addEventListener("click", () => {
      flaggedReviewedSet.add(`${e.source_file}:${e.source_line}`);
      savePersistence();
      renderFlaggedPanel();
    });
    div.appendChild(btn);
    flaggedPanelEl.appendChild(div);
  });
}

if (showFlaggedBtn) {
  showFlaggedBtn.addEventListener("click", () => {
    if (flaggedPanelEl.classList.contains("hidden")) {
      flaggedPanelEl.classList.remove("hidden");
      renderFlaggedPanel();
    } else {
      flaggedPanelEl.classList.add("hidden");
    }
  });
}

// ── Episodes ──────────────────────────────────────────────────────────────────

let episodes = [];

async function loadEpisodes() {
  try {
    const resp = await fetch("data/episodes.json");
    if (!resp.ok) return;
    episodes = await resp.json();
    if (episodeSelect) {
      episodeSelect.innerHTML = "";
      episodes.forEach((ep) => {
        const opt = document.createElement("option");
        opt.value = ep.id;
        opt.textContent = `${ep.id} — ${ep.title}`;
        episodeSelect.appendChild(opt);
      });
    }
    const ep108 = episodes.find((e) => String(e.id) === "108");
    if (ep108) {
      if (episodeSelect) episodeSelect.value = ep108.id;
      await loadEpisode(ep108);
    }
  } catch (e) {
    console.warn("failed loading episodes.json", e);
  }
}

async function loadEpisode(ep) {
  try {
    const audioPath = ep.audio ? "data/" + encodeURIComponent(ep.audio) : "";
    const transcriptPath = "data/" + encodeURIComponent(ep.transcript);
    if (audioPath) audio.src = audioPath;
    else audio.removeAttribute("src");
    let txt = "";
    try {
      const r = await fetch(transcriptPath);
      if (r.ok) txt = await r.text();
    } catch (e) {}
    if (txt) {
      if (txt.includes("WEBVTT")) {
        sentences = parseVTT(txt);
      } else {
        const lines = txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        let dur = lines.length * 3;
        if (audioPath) {
          await new Promise((resolve) => {
            if (audio.readyState >= 1 && audio.duration && !isNaN(audio.duration))
              return resolve();
            audio.addEventListener("loadedmetadata", resolve, { once: true });
            setTimeout(resolve, 1500);
          });
          if (audio.duration && !isNaN(audio.duration) && audio.duration > 0)
            dur = audio.duration;
        }
        const step = dur / Math.max(lines.length, 1);
        sentences = lines.map((ln, i) => ({
          start: Math.round(i * step * 100) / 100,
          end: Math.round((i + 1) * step * 100) / 100,
          text: ln,
        }));
      }
      renderTranscript();
      playerSection.classList.remove("hidden");
    }
  } catch (e) {
    console.warn("loadEpisode error", e);
  }
}

if (loadEpisodeBtn) {
  loadEpisodeBtn.addEventListener("click", () => {
    const id = episodeSelect?.value;
    const ep = episodes.find((e) => String(e.id) === String(id));
    if (ep) loadEpisode(ep);
  });
}

loadEpisodes();

// ── Reading tab ───────────────────────────────────────────────────────────────

let readingRenderDebounce = null;

function renderReadingFromText(text) {
  if (!readingPreview) return;
  readingPreview.innerHTML = "";
  if (!text || !text.trim()) return;
  contentWordKeys.clear();
  String(text).split(/\n\s*\n/).filter(Boolean).forEach((p) => {
    const para = document.createElement("div");
    para.className = "sentence";
    const textSpan = document.createElement("span");
    textSpan.className = "text";
    p.replace(/\r?\n/g, " ").split(/(\s+)/).forEach((t) => {
      if (/\s+/.test(t)) textSpan.appendChild(document.createTextNode(t));
      else {
        const norm = t.replace(/[.,!?;:()"""'«»–—]/g, "").toLowerCase();
        const display = t.replace(/[.,!?;:()"""'«»–—]/g, "");
        textSpan.appendChild(makeWordSpan(display, norm));
      }
    });
    para.appendChild(textSpan);
    readingPreview.appendChild(para);
  });
}

if (readingInput) {
  readingInput.addEventListener("input", (e) => {
    if (readingRenderDebounce) clearTimeout(readingRenderDebounce);
    readingRenderDebounce = setTimeout(() => renderReadingFromText(e.target.value), 250);
  });
}

if (clearArticleBtn) {
  clearArticleBtn.addEventListener("click", () => {
    if (readingInput) readingInput.value = "";
    if (readingPreview) readingPreview.innerHTML = "";
  });
}

if (saveArticleBtn) {
  saveArticleBtn.addEventListener("click", () => {
    const text = (readingInput && readingInput.value) || "";
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `article-${Date.now()}.txt`;
    a.click();
  });
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function showTab(name) {
  const player = document.getElementById("player");
  const vocab = document.getElementById("vocabPanel");
  const reading = document.getElementById("readingSection");
  if (name === "reading") {
    tabReading && tabReading.classList.add("active");
    tabPodcast && tabPodcast.classList.remove("active");
    if (player) player.classList.add("hidden");
    if (vocab) vocab.classList.add("hidden");
    if (reading) reading.classList.remove("hidden");
  } else {
    tabPodcast && tabPodcast.classList.add("active");
    tabReading && tabReading.classList.remove("active");
    if (player) player.classList.remove("hidden");
    if (vocab) vocab.classList.remove("hidden");
    if (reading) reading.classList.add("hidden");
  }
}

if (tabPodcast) tabPodcast.addEventListener("click", () => showTab("podcast"));
if (tabReading) tabReading.addEventListener("click", () => showTab("reading"));

showTab("podcast");

// ── Login button ──────────────────────────────────────────────────────────────
const loginBtn = document.getElementById("loginBtn");
if (loginBtn) loginBtn.addEventListener("click", handleLoginBtn);
updateAuthUI();

// ── Debug ─────────────────────────────────────────────────────────────────────
window._vocabIndex = vocabIndex;
window._userMastery = userMastery;
window._vocabDetail = vocabDetail;
