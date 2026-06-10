/* ═══════════════════════════════════════════════════════════════
   Danish Vocabulary Web App — app.js
   Static, GitHub Pages compatible. No backend required.
   ═══════════════════════════════════════════════════════════════ */

// ── Storage keys ───────────────────────────────────────────────────────────────
const SK_MASTERY    = "vocab_mastery_v3";
const SK_NEEDS      = "vocab_needs_study_v1";
const SK_ARTICLES   = "vocab_articles_v1";
const SK_DIARY      = "vocab_diary_v1";
const SK_ACTIONS    = "vocab_web_actions_v1";
const SK_FLAGS      = "vocab_flagged_reviewed_v1";

// ── Application state ──────────────────────────────────────────────────────────
let vocabIndex       = {};  // surface/key -> {lemma, zh, en, rank, pos}
let vocabSurfaceToKey = {}; // normalized surface -> canonical key in vocabIndex
let vocabDetail      = {};  // lemma.lower -> {ipa, example_da, example_zh, mnemonic, warning, confusing}
let userMastery      = {};  // lemma.lower -> {level, interval, reps, lapses, ease, manual, updated_at}
let needsStudySet    = new Set();  // lemma keys the user clicked to study
let webActions       = [];  // [{lemma, action, surface, contextType, contextTitle, ts}]
let flaggedEntries   = [];
let flaggedReviewedSet = new Set();

let sentences        = [];
let episodes         = [];
let articles         = [];
let currentArticleId = null;
let diaryEntries     = [];
let currentDiaryId   = null;
let contentWordKeys  = new Set(); // keys present in current transcript/article/diary
let currentTab       = "podcast";

let currentHoveredSurface = null;
const wiktionaryCache = new Map();
let hoverCard = null;
let hoverHideTimer = null;

// ── Privacy gate (NOT real security — local-only convenience) ─────────────────
const EDIT_HASH = "e48971b4ee5ef14bbe1bb3189045cc1e9853cc7fb3d9075dd75b3509dc1a3f6b"; // "vocab2024"
const SK_EDIT   = "vocab_edit_mode_v1";

function isEditMode() { return sessionStorage.getItem(SK_EDIT) === "ok"; }

async function hashPw(pw) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}

async function handleEditModeBtn() {
  const btn = document.getElementById("editModeBtn");
  if (isEditMode()) {
    sessionStorage.removeItem(SK_EDIT);
    updateAuthUI();
    return;
  }
  const pw = prompt("本地编辑密码（本地隐私保护，非真正安全）:");
  if (!pw) return;
  if (await hashPw(pw) === EDIT_HASH) {
    sessionStorage.setItem(SK_EDIT, "ok");
    updateAuthUI();
  } else {
    alert("密码错误");
  }
}

function updateAuthUI() {
  const on = isEditMode();
  const btn = document.getElementById("editModeBtn");
  if (btn) btn.textContent = on ? "退出编辑" : "Edit Mode";
  document.querySelectorAll(".auth-required").forEach(el => {
    el.style.display = on ? "" : "none";
  });
}

// ── Persistence ────────────────────────────────────────────────────────────────
function loadPersistence() {
  try { const r = localStorage.getItem(SK_MASTERY); if (r) userMastery = JSON.parse(r); } catch(e){}
  try {
    const r = localStorage.getItem(SK_NEEDS);
    if (r) JSON.parse(r).forEach(k => needsStudySet.add(k));
  } catch(e){}
  try {
    const r = localStorage.getItem(SK_ACTIONS);
    if (r) webActions = JSON.parse(r);
  } catch(e){}
  try {
    const r = localStorage.getItem(SK_FLAGS);
    if (r) JSON.parse(r).forEach(k => flaggedReviewedSet.add(k));
  } catch(e){}
}

function saveMastery() {
  try { localStorage.setItem(SK_MASTERY, JSON.stringify(userMastery)); } catch(e){}
}
function saveNeedsStudy() {
  try { localStorage.setItem(SK_NEEDS, JSON.stringify([...needsStudySet])); } catch(e){}
}
function saveWebActions() {
  try { localStorage.setItem(SK_ACTIONS, JSON.stringify(webActions)); } catch(e){}
}
function saveFlags() {
  try { localStorage.setItem(SK_FLAGS, JSON.stringify([...flaggedReviewedSet])); } catch(e){}
}

loadPersistence();

// ── Mastery system (0–4 web levels) ───────────────────────────────────────────
/**
 * Web mastery levels:
 *   0 = unseen / no data
 *   1 = new/learning  (interval < 1d, or reps = 0)
 *   2 = young review  (1 <= interval < 7d)
 *   3 = familiar      (7 <= interval < 30d)
 *   4 = known/mature  (interval >= 30d, or manually marked)
 *
 * Click a word → toggles needsStudy (amber highlight)
 * "已掌握" chip button → marks level 4 (manual)
 */
function resolveKey(key) {
  // Try direct, then via lemma fallback
  let m = userMastery[key];
  if (m === undefined && vocabIndex[key]?.lemma) {
    m = userMastery[vocabIndex[key].lemma.toLowerCase()];
  }
  return m;
}

function getWebLevel(key) {
  const m = resolveKey(key);
  if (!m) return 0;
  if (typeof m === "boolean") return m ? 4 : 0;
  if (typeof m !== "object") return 0;
  // Manually marked via web app → trust stored level
  if (m.manual) return m.level >= 4 ? 4 : Math.max(0, m.level || 0);
  // Compute from Anki interval
  const iv = m.interval || 0;
  const rp = m.reps || 0;
  if (iv <= 0 && rp === 0) return 1;  // seen in Anki but never reviewed successfully
  if (iv < 1)  return 1;
  if (iv < 7)  return 2;
  if (iv < 30) return 3;
  return 4;
}

function getLemmaKey(key) {
  return vocabIndex[key]?.lemma?.toLowerCase() || key;
}

function getMasteryLabel(level) {
  return ["未学","学习中","复习中","熟悉","已掌握"][level] || "";
}

function markKnown(key) {
  const lk = getLemmaKey(key);
  userMastery[lk] = { level: 4, interval: 30, reps: 1, manual: true, updated_at: new Date().toISOString() };
  needsStudySet.delete(lk);
  saveMastery(); saveNeedsStudy();
}

function unmarkKnown(key) {
  const lk = getLemmaKey(key);
  delete userMastery[lk];
  saveMastery();
}

// ── Web actions ────────────────────────────────────────────────────────────────
function getCurrentContextTitle() {
  if (currentTab === "podcast") {
    const ep = episodes.find(e => {
      const s = document.getElementById("episodeSelect");
      return s && String(e.id) === String(s.value);
    });
    return ep ? `Ep. ${ep.id}: ${ep.title}` : "Podcast";
  }
  if (currentTab === "reading" && currentArticleId) {
    const a = articles.find(x => x.id === currentArticleId);
    return a ? getArticleTitle(a) : "Reading";
  }
  if (currentTab === "diary" && currentDiaryId) {
    const e = diaryEntries.find(x => x.id === currentDiaryId);
    return e ? (e.title || e.date) : "Diary";
  }
  return currentTab;
}

function recordWebAction(lemma, action, surface) {
  webActions.push({ lemma, action, surface, contextType: currentTab,
    contextTitle: getCurrentContextTitle(), ts: new Date().toISOString() });
  if (webActions.length > 2000) webActions = webActions.slice(-2000);
  saveWebActions();
}

// ── Word engine ────────────────────────────────────────────────────────────────

function applyWordClass(el, key) {
  el.className = "word";
  const lk = getLemmaKey(key);
  if (needsStudySet.has(lk)) {
    el.classList.add("w-study");
    return;
  }
  const level = getWebLevel(key);
  if (level > 0) el.classList.add(`w-m${level}`);
}

function tokenizeLine(text) {
  // Split text into [word, nonword] tokens preserving spaces/punctuation
  return text.replace(/\r?\n/g, " ").split(/(\s+)/);
}

function normalizeToken(t) {
  // Strip leading/trailing punctuation for lookup, keep core word
  return t.replace(/^[.,!?;:()"'«»–—\[\]]+|[.,!?;:()"'«»–—\[\]]+$/g, "").toLowerCase();
}

function displayToken(t) {
  return t.replace(/^[.,!?;:()"'«»–—\[\]]+|[.,!?;:()"'«»–—\[\]]+$/g, "");
}

function makeWordSpan(displayText, lookupKey) {
  const norm  = lookupKey || displayText.toLowerCase();
  const key   = vocabSurfaceToKey[norm] || norm;
  const info  = vocabIndex[key] || null;
  const span  = document.createElement("span");
  span.className = "word";
  span.textContent = displayText;
  span.dataset.surface = norm;
  span.addEventListener("mouseenter", onWordHover);
  span.addEventListener("mouseleave", onWordLeave);
  span.addEventListener("click", onWordClick);
  applyWordClass(span, key);
  if (info || vocabSurfaceToKey[norm]) contentWordKeys.add(key);
  return span;
}

function renderTokensInto(container, text) {
  // Parse text with markdown-ish heading detection (# ## ###)
  const paras = String(text).split(/\n\s*\n/).filter(Boolean);
  paras.forEach(rawPara => {
    const para = document.createElement("div");
    para.className = "sentence";
    const trimmed = rawPara.trimStart();
    // Heading detection
    if (trimmed.startsWith("### ")) {
      para.classList.add("para-h3");
      rawPara = rawPara.replace(/^#+\s*/, "");
    } else if (trimmed.startsWith("## ")) {
      para.classList.add("para-h2");
      rawPara = rawPara.replace(/^#+\s*/, "");
    } else if (trimmed.startsWith("# ")) {
      para.classList.add("para-h1");
      rawPara = rawPara.replace(/^#+\s*/, "");
    }
    const span = document.createElement("span");
    span.className = "text";
    rawPara.replace(/\r?\n/g, " ").split(/(\s+)/).forEach(t => {
      if (/\s+/.test(t)) {
        span.appendChild(document.createTextNode(t));
      } else {
        const norm = normalizeToken(t);
        const disp = displayToken(t);
        if (norm) span.appendChild(makeWordSpan(disp, norm));
        else if (t) span.appendChild(document.createTextNode(t));
      }
    });
    para.appendChild(span);
    container.appendChild(para);
  });
}

function refreshAllSpansForLemma(lemmaKey) {
  document.querySelectorAll(".word").forEach(el => {
    const s  = (el.dataset.surface || "").toLowerCase();
    const k  = vocabSurfaceToKey[s] || s;
    const lk = getLemmaKey(k);
    if (lk === lemmaKey || k === lemmaKey) applyWordClass(el, k);
  });
}

// ── Hover card ─────────────────────────────────────────────────────────────────
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
    hoverCard.className = "hoverCard";
    hoverCard.addEventListener("mouseenter", () => clearTimeout(hoverHideTimer));
    hoverCard.addEventListener("mouseleave", scheduleHide);
    document.body.appendChild(hoverCard);
  }
  return hoverCard;
}

function escH(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function buildHoverHTML(surface, info, key) {
  let html = "";
  if (!info) {
    html = `<div class="hc-lemma">${escH(surface)}</div>
            <div class="hc-gloss-en" style="margin-top:4px;color:var(--muted)">未在词表中</div>
            <hr class="hc-divider">${externalLinks(surface)}`;
  } else {
    const lemma  = info.lemma || surface;
    const level  = getWebLevel(key);
    const lk     = getLemmaKey(key);
    const detail = vocabDetail[lemma.toLowerCase()] || {};
    const isStudy = needsStudySet.has(lk);

    html  = `<div class="hc-lemma">${escH(lemma)}`;
    html += `<span class="hc-meta">rank ${info.rank||"?"}${info.pos?" · "+info.pos:""}</span>`;
    if (isStudy) {
      html += `<span class="hc-mastery study">需学</span>`;
    } else if (level > 0) {
      html += `<span class="hc-mastery">${escH(getMasteryLabel(level))}</span>`;
    }
    html += `</div>`;
    if (detail.ipa) html += `<div class="hc-ipa">/${escH(detail.ipa)}/</div>`;
    if (info.zh) html += `<div class="hc-gloss-zh">${escH(info.zh)}</div>`;
    if (info.en) html += `<div class="hc-gloss-en">${escH(info.en)}</div>`;

    const hasExtra = detail.example_da || detail.mnemonic || detail.warning ||
                     (detail.confusing && detail.confusing.length);
    if (hasExtra) html += `<hr class="hc-divider">`;
    if (detail.example_da) {
      html += `<div class="hc-example">${escH(detail.example_da)}</div>`;
      if (detail.example_zh) html += `<div class="hc-example-zh">${escH(detail.example_zh)}</div>`;
    }
    if (detail.mnemonic) html += `<div class="hc-mnemonic">💡 ${escH(detail.mnemonic)}</div>`;
    if (detail.warning)  html += `<div class="hc-warning">⚠️ ${escH(detail.warning)}</div>`;
    if (detail.confusing?.length)
      html += `<div class="hc-confusing">混淆词: ${detail.confusing.map(escH).join(", ")}</div>`;

    html += `<hr class="hc-divider">${externalLinks(lemma)}`;
  }
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

function onWordHover(ev) {
  const surface = (ev.target.dataset.surface || ev.target.textContent || "").toLowerCase();
  currentHoveredSurface = surface;
  const key  = vocabSurfaceToKey[surface];
  const info = key ? vocabIndex[key] : null;
  const card = getHoverCard();
  card.innerHTML = buildHoverHTML(surface, info, key);
  const rect = ev.target.getBoundingClientRect();
  const cardW = 320;
  let left = rect.right + 8;
  if (left + cardW > window.innerWidth - 8) left = rect.left - cardW - 8;
  card.style.left = Math.max(4, left) + "px";
  card.style.top  = Math.max(4, Math.min(rect.top, window.innerHeight - 380)) + "px";
  card.style.display = "block";
  clearTimeout(hoverHideTimer);
  updateWiktSection(card, (info?.lemma || surface).toLowerCase(), surface);
}

function onWordLeave() { scheduleHide(); }

// ── Wiktionary ─────────────────────────────────────────────────────────────────
function stripHtml(s) {
  const d = document.createElement("div");
  d.innerHTML = s || "";
  return d.textContent || "";
}

function buildWiktHTML(entries) {
  if (!entries?.length) return '<div class="hc-wikt-empty">Wiktionary: 未找到丹麦语条目</div>';
  let html = '<div class="hc-wikt-label">Wiktionary 互查</div>';
  for (const entry of entries.slice(0,2)) {
    if (entry.partOfSpeech) html += `<span class="hc-wikt-pos">${escH(entry.partOfSpeech)}</span> `;
    for (const def of (entry.definitions||[]).slice(0,2)) {
      const t = stripHtml(def.definition || "");
      if (t) html += `<div class="hc-wikt-def">${escH(t)}</div>`;
    }
  }
  return html;
}

async function updateWiktSection(card, lemma, surface) {
  const el = card.querySelector(".hc-wikt-section");
  if (!el) return;
  if (wiktionaryCache.has(lemma)) {
    el.innerHTML = buildWiktHTML(wiktionaryCache.get(lemma)); return;
  }
  el.innerHTML = '<div class="hc-wikt-loading">Wiktionary…</div>';
  try {
    const resp = await fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(lemma)}`);
    const entries = resp.ok ? ((await resp.json()).da || []) : null;
    wiktionaryCache.set(lemma, entries);
    if (currentHoveredSurface === surface && card.style.display !== "none")
      el.innerHTML = buildWiktHTML(entries);
  } catch(e) {
    wiktionaryCache.set(lemma, null);
    if (currentHoveredSurface === surface && card.style.display !== "none")
      el.innerHTML = '<div class="hc-wikt-empty">Wiktionary 查询失败</div>';
  }
}

// ── Word click — toggles "needs study" ────────────────────────────────────────
function onWordClick(ev) {
  ev.stopPropagation();
  const surface = (ev.target.dataset.surface || "").toLowerCase();
  const key = vocabSurfaceToKey[surface] || surface;
  const lk  = getLemmaKey(key);
  if (needsStudySet.has(lk)) {
    needsStudySet.delete(lk);
    recordWebAction(lk, "unstudy", surface);
  } else {
    needsStudySet.add(lk);
    recordWebAction(lk, "study", surface);
  }
  saveNeedsStudy();
  refreshAllSpansForLemma(lk);
  renderVocabList();
  if (currentTab === "vocab") renderVocabBrowser();
}

// ── Transcript rendering (Podcast) ────────────────────────────────────────────
const transcriptContainer = document.getElementById("transcriptContainer");
const sentenceTemplate    = document.getElementById("sentenceTemplate");

function renderTranscript() {
  if (!transcriptContainer) return;
  transcriptContainer.innerHTML = "";
  contentWordKeys.clear();
  sentences.forEach(s => {
    const node = sentenceTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.start = s.start;
    node.dataset.end   = s.end;
    const textSpan = node.querySelector(".text");
    s.text.replace(/\r?\n/g," ").split(/(\s+)/).forEach(t => {
      if (/\s+/.test(t)) textSpan.appendChild(document.createTextNode(t));
      else {
        const norm = normalizeToken(t);
        const disp = displayToken(t);
        if (norm) textSpan.appendChild(makeWordSpan(disp, norm));
        else if (t) textSpan.appendChild(document.createTextNode(t));
      }
    });
    node.addEventListener("click", () => {
      const useTTS = document.getElementById("useTTS");
      const audio  = document.getElementById("audio");
      if ((useTTS && useTTS.checked) || !audio?.src) speakText(s.text);
      else { audio.currentTime = parseFloat(s.start)||0; audio.play(); }
    });
    transcriptContainer.appendChild(node);
  });
}

// ── TTS ────────────────────────────────────────────────────────────────────────
let ttsAutoPlaying = false;

function speakText(text) {
  if (!("speechSynthesis" in window)) return Promise.resolve();
  return new Promise(resolve => {
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text).replace(/\s+/g," "));
      u.lang = "da-DK";
      const speedEl = document.getElementById("speed");
      let r = parseFloat(speedEl?.value)||1;
      if (!isFinite(r)||r<=0) r=1;
      u.rate = Math.min(Math.max(r,0.5),2.0);
      u.onend = ()=>resolve(); u.onerror = ()=>resolve();
      speechSynthesis.speak(u);
    } catch(e) { resolve(); }
  });
}

async function startTTSAuto(fromIndex=0) {
  if (!("speechSynthesis" in window)) return;
  ttsAutoPlaying = true;
  for (let i=fromIndex; i<sentences.length && ttsAutoPlaying; i++) {
    transcriptContainer?.querySelectorAll(".sentence").forEach(n=>n.classList.remove("active"));
    const node = transcriptContainer?.querySelectorAll(".sentence")[i];
    if (node) { node.classList.add("active"); node.scrollIntoView({behavior:"smooth",block:"center"}); }
    await speakText(sentences[i].text);
    if (!ttsAutoPlaying) break;
    await new Promise(r=>setTimeout(r,200));
  }
  ttsAutoPlaying = false;
  const ttsAuto = document.getElementById("ttsAuto");
  if (ttsAuto) ttsAuto.checked = false;
}

function stopTTSAuto() {
  ttsAutoPlaying = false;
  try { speechSynthesis.cancel(); } catch(e){}
}

function speakCurrentSentence() {
  const active = transcriptContainer?.querySelector(".sentence.active")
               || transcriptContainer?.querySelector(".sentence");
  if (!active) return;
  const idx = [...(transcriptContainer?.querySelectorAll(".sentence")||[])].indexOf(active);
  if (sentences[idx]) speakText(sentences[idx].text);
}

// TTS controls
const ttsSpeakBtn = document.getElementById("ttsSpeak");
const ttsAutoChk  = document.getElementById("ttsAuto");
if (ttsSpeakBtn) ttsSpeakBtn.addEventListener("click", speakCurrentSentence);
if (ttsAutoChk)  ttsAutoChk.addEventListener("change", e => {
  if (e.target.checked) startTTSAuto(); else stopTTSAuto();
});

// Audio playback sync
const audio = document.getElementById("audio");
if (audio) {
  audio.addEventListener("timeupdate", () => {
    const t = audio.currentTime;
    let active = null;
    for (const node of (transcriptContainer?.querySelectorAll(".sentence")||[])) {
      const s = parseFloat(node.dataset.start), e = parseFloat(node.dataset.end);
      if (t >= s && t <= e) { active = node; break; }
    }
    transcriptContainer?.querySelectorAll(".sentence").forEach(n=>n.classList.remove("active"));
    if (active) { active.classList.add("active"); active.scrollIntoView({behavior:"smooth",block:"center"}); }
  });
}

// Speed select
const speedEl = document.getElementById("speed");
if (speedEl && audio) speedEl.addEventListener("change", ()=>{ audio.playbackRate = parseFloat(speedEl.value); });

// ── Vocab panel ────────────────────────────────────────────────────────────────
const vocabList  = document.getElementById("vocabList");
const vocabStats = document.getElementById("vocabStats");

function renderVocabList() {
  if (!vocabList || !vocabStats) return;
  vocabList.innerHTML = "";

  // Empty state when in reading/diary but no content open
  if ((currentTab === "reading" || currentTab === "diary") && contentWordKeys.size === 0) {
    vocabStats.textContent = currentTab === "diary" ? "打开日记后显示生词" : "打开文章后显示生词";
    return;
  }

  // Determine source
  const sourceKeys = contentWordKeys.size > 0
    ? [...contentWordKeys]
    : (currentTab === "podcast" ? Object.keys(vocabIndex) : []);

  if (sourceKeys.length === 0) { vocabStats.textContent = "No vocab loaded."; return; }

  const entries = sourceKeys
    .map(k => { const v = vocabIndex[k]||{}; return {key:k, lemma:(v.lemma||k).toLowerCase(), rank:v.rank||999999}; })
    .sort((a,b)=>a.rank-b.rank);

  // Deduplicate by lemma
  const seen = new Set();
  const unique = [];
  entries.forEach(e => { if (!seen.has(e.lemma)){seen.add(e.lemma);unique.push(e);} });

  // Show: needs-study first, then unknown (level < 3), skip level 4 (known)
  const toShow = unique.filter(e => {
    const lk = getLemmaKey(e.key);
    return needsStudySet.has(lk) || getWebLevel(e.key) < 3;
  }).sort((a,b) => {
    const aStudy = needsStudySet.has(getLemmaKey(a.key)) ? 0 : 1;
    const bStudy = needsStudySet.has(getLemmaKey(b.key)) ? 0 : 1;
    if (aStudy !== bStudy) return aStudy - bStudy;
    return a.rank - b.rank;
  });

  const knownCount = unique.filter(e => getWebLevel(e.key) >= 3).length;
  const studyCount = [...needsStudySet].filter(lk => unique.some(e => getLemmaKey(e.key) === lk)).length;

  if (toShow.length === 0 && contentWordKeys.size > 0) {
    vocabList.innerHTML = "<div style='color:#888;font-size:12px;padding:4px'>当前内容的单词都已掌握！</div>";
  }

  toShow.forEach(e => {
    const l   = e.key;
    const lk  = getLemmaKey(l);
    const v   = vocabIndex[l] || {};
    const level    = getWebLevel(l);
    const isStudy  = needsStudySet.has(lk);

    const chip = document.createElement("div");
    chip.className = "vocabChip";
    if (isStudy) chip.classList.add("w-study");
    else if (level >= 1) chip.classList.add(`w-m${level}`);

    const lemmaSpan = document.createElement("span");
    lemmaSpan.className = "chip-lemma";
    lemmaSpan.textContent = v.lemma || l;

    const zhSpan = document.createElement("span");
    zhSpan.className = "chip-zh";
    zhSpan.textContent = v.zh ? `— ${v.zh}` : "";

    // Mark known button
    const knownBtn = document.createElement("button");
    knownBtn.className = `chip-btn ${level >= 4 ? "known" : ""}`;
    knownBtn.textContent = level >= 4 ? "已掌握" : "掌握";
    knownBtn.addEventListener("click", ev => {
      ev.stopPropagation();
      if (level >= 4) unmarkKnown(l); else markKnown(l);
      refreshAllSpansForLemma(lk);
      renderVocabList();
      if (currentTab === "vocab") renderVocabBrowser();
    });

    chip.appendChild(lemmaSpan);
    chip.appendChild(zhSpan);
    chip.appendChild(knownBtn);
    vocabList.appendChild(chip);
  });

  const src = contentWordKeys.size > 0 ? "本文" : "全库";
  vocabStats.textContent =
    `${src} ${unique.length} 词 · 生词 ${toShow.length - studyCount} · 需学 ${studyCount} · 已掌握 ${knownCount}`;
  updateAuthUI();
}

// ── Vocab browser (生词库 tab) ──────────────────────────────────────────────────
let vbFilter = { q:"", level:"", rank:"", pos:"" };

function renderVocabBrowser() {
  const list  = document.getElementById("vocabBrowserList");
  const stats = document.getElementById("vocabBrowserStats");
  if (!list) return;

  // Build sorted deduplicated entries
  const allEntries = Object.entries(vocabIndex)
    .map(([k,v]) => ({key:k, lemma:(v.lemma||k).toLowerCase(), zh:v.zh||"", rank:v.rank||999999, pos:v.pos||""}))
    .sort((a,b)=>a.rank-b.rank);
  const seen = new Set(); const unique = [];
  allEntries.forEach(e => { if(!seen.has(e.lemma)){seen.add(e.lemma);unique.push(e);} });

  const q      = vbFilter.q.toLowerCase().trim();
  const fLevel = vbFilter.level;
  const fRank  = vbFilter.rank ? parseInt(vbFilter.rank) : 0;
  const fPos   = vbFilter.pos;

  const filtered = unique.filter(e => {
    const level = getWebLevel(e.key);
    const lk    = getLemmaKey(e.key);
    const isStudy = needsStudySet.has(lk);

    if (q && !e.lemma.includes(q) && !e.zh.includes(q)) return false;
    if (fRank && e.rank > fRank) return false;
    if (fPos  && e.pos !== fPos) return false;

    if (fLevel === "study")  return isStudy;
    if (fLevel === "0")      return !isStudy && level === 0;
    if (fLevel === "1")      return !isStudy && level === 1;
    if (fLevel === "2")      return !isStudy && level === 2;
    if (fLevel === "3")      return !isStudy && level === 3;
    if (fLevel === "4")      return !isStudy && level === 4;
    // Default: show all except known (level 4) unless searching/filtering
    if (!q && !fLevel && !fRank && !fPos) return level < 4 || isStudy;
    return true;
  });

  list.innerHTML = "";
  filtered.slice(0, 1500).forEach(e => {
    const level  = getWebLevel(e.key);
    const lk     = getLemmaKey(e.key);
    const isStudy = needsStudySet.has(lk);

    const chip = document.createElement("div");
    chip.className = "vbChip";
    if (isStudy) chip.classList.add("w-study");
    else if (level >= 4) chip.classList.add("w-m4");

    const ls = document.createElement("span"); ls.className="vb-lemma"; ls.textContent=e.lemma;
    const zs = document.createElement("span"); zs.className="vb-zh";   zs.textContent=e.zh?`— ${e.zh}`:"";
    const rs = document.createElement("span"); rs.className="vb-rank";  rs.textContent=`#${e.rank}`;

    chip.appendChild(ls);
    if (e.zh) chip.appendChild(zs);
    chip.appendChild(rs);

    chip.addEventListener("click", () => {
      if (needsStudySet.has(lk)) { needsStudySet.delete(lk); recordWebAction(lk,"unstudy",e.lemma); }
      else                       { needsStudySet.add(lk);    recordWebAction(lk,"study",  e.lemma); }
      saveNeedsStudy();
      refreshAllSpansForLemma(lk);
      renderVocabBrowser();
      renderVocabList();
    });
    list.appendChild(chip);
  });

  const totalUnknown = unique.filter(e => getWebLevel(e.key) < 3).length;
  const totalStudy   = unique.filter(e => needsStudySet.has(getLemmaKey(e.key))).length;
  const totalKnown   = unique.filter(e => getWebLevel(e.key) >= 4).length;
  if (stats) {
    stats.textContent = (q||fLevel||fRank||fPos)
      ? `显示 ${filtered.length}${filtered.length>1500?" (前1500)":""} 词`
      : `共 ${unique.length} 词 · 生词 ${totalUnknown} · 需学 ${totalStudy} · 已掌握 ${totalKnown}`;
  }
}

// Vocab browser filter controls
document.getElementById("vocabSearch")?.addEventListener("input", e => {
  vbFilter.q = e.target.value; renderVocabBrowser();
});
document.getElementById("vbFilterLevel")?.addEventListener("change", e => {
  vbFilter.level = e.target.value; renderVocabBrowser();
});
document.getElementById("vbFilterRank")?.addEventListener("change", e => {
  vbFilter.rank = e.target.value; renderVocabBrowser();
});
document.getElementById("vbFilterPos")?.addEventListener("change", e => {
  vbFilter.pos = e.target.value; renderVocabBrowser();
});

// ── Anki TSV export ────────────────────────────────────────────────────────────
function exportAnkiTSV() {
  const rows = [];
  const keys = contentWordKeys.size > 0 ? [...contentWordKeys] : Object.keys(vocabIndex);
  keys.forEach(k => {
    const v = vocabIndex[k]; if (!v) return;
    const level = getWebLevel(k);
    rows.push([v.lemma||k, `${v.zh||""} — ${v.en||""}`, getMasteryLabel(level)||"未学"].join("\t"));
  });
  downloadBlob(rows.join("\n"), "vocab_anki_export.tsv", "text/tab-separated-values");
}

// ── Web actions export ─────────────────────────────────────────────────────────
function exportWebActions() {
  const today = new Date().toISOString().slice(0,10);
  downloadBlob(JSON.stringify(webActions, null, 2), `web_anki_actions_${today}.json`, "application/json");
}

// ── Reset state ────────────────────────────────────────────────────────────────
function resetVisualState() {
  if (!confirm("重置所有手动高亮（保留 Anki 掌握数据）？\n\n将会：\n- 清除所有「需学」标记\n- 不影响 user_mastery.json")) return;
  needsStudySet.clear();
  saveNeedsStudy();
  document.querySelectorAll(".word").forEach(el => {
    const s = (el.dataset.surface||"").toLowerCase();
    const k = vocabSurfaceToKey[s]||s;
    applyWordClass(el, k);
  });
  renderVocabList();
  if (currentTab === "vocab") renderVocabBrowser();
}

// ── Download helper ────────────────────────────────────────────────────────────
function downloadBlob(content, filename, type) {
  const blob = new Blob([content], {type});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

// ── File parsers ───────────────────────────────────────────────────────────────
function parseVTT(text) {
  const lines = text.split(/\r?\n/);
  const cues = []; let i=0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes("-->")) {
      const parts = line.split("-->");
      const start = vttToSec(parts[0].trim());
      const end   = vttToSec(parts[1].trim().split(/\s/)[0]);
      i++;
      let txt = "";
      while (i < lines.length && lines[i].trim()) { txt += lines[i]+"\n"; i++; }
      cues.push({start, end, text: txt.trim()});
    } else i++;
  }
  return cues;
}
function vttToSec(s) {
  const m = s.split(":").map(parseFloat);
  if (m.length===3) return m[0]*3600+m[1]*60+m[2];
  if (m.length===2) return m[0]*60+m[1];
  return parseFloat(s);
}
function plainToSentences(text) {
  return text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean)
    .map((ln,i)=>({start:i*3, end:i*3+3, text:ln}));
}

// File input handlers
const transcriptInput = document.getElementById("transcriptInput");
const audioInput      = document.getElementById("audioInput");
if (transcriptInput) transcriptInput.addEventListener("change", async ev => {
  const f = ev.target.files[0]; if (!f) return;
  const text = await f.text();
  sentences = text.includes("WEBVTT") ? parseVTT(text) : plainToSentences(text);
  renderTranscript();
  document.getElementById("podcastSection")?.classList.remove("hidden");
});
if (audioInput && audio) audioInput.addEventListener("change", ev => {
  const f = ev.target.files[0]; if (!f) return;
  audio.src = URL.createObjectURL(f);
});
if (transcriptContainer) {
  transcriptContainer.addEventListener("keydown", ev => {
    if (ev.key==="Enter" && ev.target.classList.contains("word")) ev.target.click();
  });
}

// ── Episodes / Podcast ─────────────────────────────────────────────────────────
const episodeSelect = document.getElementById("episodeSelect");

async function loadEpisodes() {
  try {
    const resp = await fetch("data/podcast/episodes.json");
    if (!resp.ok) return;
    episodes = await resp.json();
    if (episodeSelect) {
      episodeSelect.innerHTML = "";
      episodes.forEach(ep => {
        const opt = document.createElement("option");
        opt.value = ep.id;
        opt.textContent = `${ep.id} — ${ep.title}`;
        episodeSelect.appendChild(opt);
      });
    }
    // Auto-load first episode
    if (episodes.length > 0) {
      if (episodeSelect) episodeSelect.value = episodes[0].id;
      await loadEpisode(episodes[0]);
    }
  } catch(e) { console.warn("episodes.json not available", e); }
}

async function loadEpisode(ep) {
  try {
    const audioPath = ep.audio ? "data/podcast/" + encodeURIComponent(ep.audio) : "";
    const txPath    = "data/podcast/" + encodeURIComponent(ep.transcript);
    if (audio) {
      if (audioPath) audio.src = audioPath;
      else audio.removeAttribute("src");
    }
    const r = await fetch(txPath);
    if (!r.ok) return;
    const txt = await r.text();
    if (txt.includes("WEBVTT")) {
      sentences = parseVTT(txt);
    } else {
      const lines = txt.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
      let dur = lines.length * 3;
      if (audioPath && audio) {
        await new Promise(resolve => {
          if (audio.readyState >= 1 && audio.duration && !isNaN(audio.duration)) return resolve();
          audio.addEventListener("loadedmetadata", resolve, {once:true});
          setTimeout(resolve, 1500);
        });
        if (audio.duration && !isNaN(audio.duration) && audio.duration > 0) dur = audio.duration;
      }
      const step = dur / Math.max(lines.length, 1);
      sentences = lines.map((ln,i) => ({
        start: Math.round(i*step*100)/100,
        end:   Math.round((i+1)*step*100)/100,
        text:  ln
      }));
    }
    renderTranscript();
    document.getElementById("podcastSection")?.classList.remove("hidden");
    renderVocabList();
  } catch(e) { console.warn("loadEpisode error", e); }
}

document.getElementById("loadEpisodeBtn")?.addEventListener("click", () => {
  const id = episodeSelect?.value;
  const ep = episodes.find(e => String(e.id) === String(id));
  if (ep) loadEpisode(ep);
});

document.getElementById("loadSample")?.addEventListener("click", () => {
  sentences = [
    {start:0,   end:4,  text:"Hej, mit navn er Anna."},
    {start:4.1, end:9,  text:"Jeg bor i København og jeg lærer dansk hver dag."},
    {start:9.1, end:14, text:"Det er meget svært, men jeg nyder det virkelig."},
  ];
  renderTranscript();
  renderVocabList();
});

// ── Articles / Reading ─────────────────────────────────────────────────────────
function loadArticlesFromStorage() {
  try { const r=localStorage.getItem(SK_ARTICLES); articles=r?JSON.parse(r):[]; } catch(e){articles=[];}
}
function saveArticles() {
  try { localStorage.setItem(SK_ARTICLES, JSON.stringify(articles.filter(a=>!a.readonly))); } catch(e){}
}
function genId() { return Date.now().toString(36)+Math.random().toString(36).slice(2); }
function getArticleTitle(a) {
  return a.title || a.text.trimStart().split("\n")[0].replace(/^#+\s*/,"").slice(0,50) || "无标题";
}

function calcArticleStats(text) {
  const words = text.match(/\b[a-zA-ZæøåÆØÅ][a-zA-ZæøåÆØÅ'-]*\b/g) || [];
  let total=0, known=0, study=0, unknown=0;
  const seenLemmas = new Set();
  words.forEach(w => {
    total++;
    const norm = w.toLowerCase();
    const k = vocabSurfaceToKey[norm] || norm;
    const v = vocabIndex[k];
    if (!v) return;
    const lk = getLemmaKey(k);
    if (seenLemmas.has(lk)) return;
    seenLemmas.add(lk);
    const level = getWebLevel(k);
    if (needsStudySet.has(lk)) study++;
    else if (level >= 3) known++;
    else unknown++;
  });
  const coverage = seenLemmas.size > 0 ? Math.round(known / seenLemmas.size * 100) : 0;
  return {total, unique: seenLemmas.size, known, study, unknown, coverage};
}

function renderReadingFromText(text) {
  const preview = document.getElementById("readingPreview");
  if (!preview) return;
  preview.innerHTML = "";
  if (!text?.trim()) return;
  contentWordKeys.clear();
  renderTokensInto(preview, text);
}

function openArticle(article) {
  currentArticleId = article.id;
  document.getElementById("articleComposer")?.classList.add("hidden");
  document.getElementById("readingPlaceholder")?.classList.add("hidden");
  document.getElementById("readingViewer")?.classList.remove("hidden");
  const titleEl = document.getElementById("readingTitle");
  if (titleEl) titleEl.textContent = getArticleTitle(article);
  renderReadingFromText(article.text);
  // Article stats
  const statsEl = document.getElementById("articleStats");
  if (statsEl) {
    const s = calcArticleStats(article.text);
    statsEl.innerHTML = `
      <span>${s.total} 字</span>
      <span>${s.unique} 词</span>
      <span>覆盖率 ${s.coverage}%</span>
      <span>生词 ${s.unknown}</span>
      <span>需学 ${s.study}</span>
    `;
  }
  renderVocabList();
  renderArticleTree();
}

function renderArticleTree() {
  const list = document.getElementById("articleList");
  if (!list) return;
  const searchEl = document.getElementById("articleSearch");
  const q = (searchEl?.value||"").toLowerCase();
  list.innerHTML = "";
  const filtered = articles.filter(a => !q || getArticleTitle(a).toLowerCase().includes(q));
  if (filtered.length === 0) {
    list.innerHTML = `<div style="color:#aaa;font-size:12px;padding:8px 10px">${q?"无匹配":"暂无文章"}</div>`;
    updateAuthUI(); return;
  }
  filtered.forEach(a => {
    const item = document.createElement("div");
    item.className = "article-item" + (a.id===currentArticleId?" active":"");
    const title = document.createElement("span");
    title.className = "article-item-title";
    title.textContent = getArticleTitle(a);
    title.title = getArticleTitle(a);
    title.addEventListener("click", () => openArticle(a));
    item.appendChild(title);
    if (!a.readonly) {
      const del = document.createElement("button");
      del.className = "article-del-btn auth-required";
      del.textContent = "✕";
      del.title = "删除";
      del.addEventListener("click", ev => {
        ev.stopPropagation();
        if (!isEditMode()) { alert("请先进入编辑模式"); return; }
        if (!confirm(`删除"${getArticleTitle(a)}"？`)) return;
        articles = articles.filter(x=>x.id!==a.id);
        saveArticles();
        if (currentArticleId===a.id) {
          currentArticleId=null;
          document.getElementById("readingViewer")?.classList.add("hidden");
          document.getElementById("readingPlaceholder")?.classList.remove("hidden");
          contentWordKeys.clear(); renderVocabList();
        }
        renderArticleTree();
      });
      item.appendChild(del);
    }
    list.appendChild(item);
  });
  updateAuthUI();
}

document.getElementById("articleSearch")?.addEventListener("input", () => renderArticleTree());

document.getElementById("newArticleBtn")?.addEventListener("click", () => {
  if (!isEditMode()) { alert("请先进入编辑模式"); return; }
  document.getElementById("articleComposer")?.classList.remove("hidden");
  document.getElementById("readingViewer")?.classList.add("hidden");
  document.getElementById("readingPlaceholder")?.classList.add("hidden");
  const ti = document.getElementById("articleTitleInput");
  const ri = document.getElementById("readingInput");
  if (ti) ti.value=""; if (ri) { ri.value=""; ri.focus(); }
});

document.getElementById("cancelCompose")?.addEventListener("click", () => {
  document.getElementById("articleComposer")?.classList.add("hidden");
  if (currentArticleId) {
    const a = articles.find(x=>x.id===currentArticleId);
    if (a) { openArticle(a); return; }
  }
  document.getElementById("readingPlaceholder")?.classList.remove("hidden");
});

document.getElementById("saveArticle")?.addEventListener("click", () => {
  if (!isEditMode()) { alert("请先进入编辑模式"); return; }
  const text = document.getElementById("readingInput")?.value||"";
  if (!text.trim()) { alert("请输入文章内容"); return; }
  const title = document.getElementById("articleTitleInput")?.value?.trim()||"";
  const article = {id:genId(), title, text, savedAt:Date.now()};
  articles.unshift(article);
  saveArticles();
  document.getElementById("articleComposer")?.classList.add("hidden");
  openArticle(article);
});

document.getElementById("clearArticle")?.addEventListener("click", () => {
  const ri = document.getElementById("readingInput");
  if (ri) ri.value="";
});

// Load reading articles from data/reading/index.json
async function loadReadingIndex() {
  try {
    const resp = await fetch("data/reading/index.json");
    if (!resp.ok) return;
    const index = await resp.json();
    for (const entry of index) {
      if (articles.some(a=>a.filename===entry.filename)) continue;
      try {
        const r = await fetch("data/reading/"+encodeURIComponent(entry.filename));
        if (!r.ok) continue;
        const text = await r.text();
        articles.push({
          id: "file:"+entry.filename,
          title: entry.title || entry.filename,
          text, savedAt:0, readonly:true, filename:entry.filename
        });
      } catch(e){}
    }
    renderArticleTree();
  } catch(e){}
}

// ── Diary ──────────────────────────────────────────────────────────────────────
function loadDiary() {
  try { const r=localStorage.getItem(SK_DIARY); diaryEntries=r?JSON.parse(r):[]; } catch(e){diaryEntries=[];}
}
function saveDiary() {
  try { localStorage.setItem(SK_DIARY, JSON.stringify(diaryEntries)); } catch(e){}
}

function todayDate() { return new Date().toISOString().slice(0,10); }

function getDiaryTitle(e) { return e.title || e.date || "日记"; }

function renderDiaryList() {
  const list    = document.getElementById("diaryEntryList");
  const searchEl = document.getElementById("diarySearch");
  if (!list) return;
  const q = (searchEl?.value||"").toLowerCase();
  list.innerHTML = "";
  const filtered = diaryEntries.filter(e =>
    !q || getDiaryTitle(e).toLowerCase().includes(q) || (e.body||"").toLowerCase().includes(q)
  );
  if (filtered.length === 0) {
    list.innerHTML = `<div style="color:#aaa;font-size:12px;padding:8px 10px">${q?"无匹配":"暂无日记"}</div>`;
    return;
  }
  filtered.forEach(e => {
    const item = document.createElement("div");
    item.className = "diary-entry-item" + (e.id===currentDiaryId?" active":"");
    const dateEl = document.createElement("div"); dateEl.className="diary-entry-date"; dateEl.textContent=e.date;
    const titleEl = document.createElement("div"); titleEl.className="diary-entry-title"; titleEl.textContent=getDiaryTitle(e);
    item.appendChild(dateEl); item.appendChild(titleEl);
    item.addEventListener("click", ()=>openDiaryEntry(e));
    list.appendChild(item);
  });
}

function openDiaryEntry(entry) {
  currentDiaryId = entry.id;
  document.getElementById("diaryPlaceholder")?.classList.add("hidden");
  const editor = document.getElementById("diaryEditor");
  editor?.classList.remove("hidden");
  const dateEl  = document.getElementById("diaryDate");
  const titleEl = document.getElementById("diaryTitle");
  const bodyEl  = document.getElementById("diaryBody");
  const delBtn  = document.getElementById("deleteDiaryBtn");
  if (dateEl)  dateEl.value  = entry.date||"";
  if (titleEl) titleEl.value = entry.title||"";
  if (bodyEl)  bodyEl.value  = entry.body||"";
  if (delBtn)  delBtn.classList.remove("hidden");
  renderDiaryPreview();
  renderDiaryList();
  // Populate contentWordKeys from diary body
  contentWordKeys.clear();
  const preview = document.getElementById("diaryPreview");
  if (preview) {
    preview.innerHTML = "";
    renderTokensInto(preview, entry.body||"");
  }
  renderVocabList();
  updateDiaryWordStats();
}

function newDiaryEntry() {
  currentDiaryId = null;
  document.getElementById("diaryPlaceholder")?.classList.add("hidden");
  const editor = document.getElementById("diaryEditor");
  editor?.classList.remove("hidden");
  const dateEl  = document.getElementById("diaryDate");
  const titleEl = document.getElementById("diaryTitle");
  const bodyEl  = document.getElementById("diaryBody");
  const delBtn  = document.getElementById("deleteDiaryBtn");
  if (dateEl)  dateEl.value  = todayDate();
  if (titleEl) titleEl.value = "";
  if (bodyEl)  { bodyEl.value=""; bodyEl.focus(); }
  if (delBtn)  delBtn.classList.add("hidden");
  const preview = document.getElementById("diaryPreview");
  if (preview) preview.innerHTML="";
  contentWordKeys.clear();
  renderVocabList();
}

let diaryPreviewTimer = null;
function renderDiaryPreview() {
  const bodyEl = document.getElementById("diaryBody");
  const preview = document.getElementById("diaryPreview");
  if (!preview || !bodyEl) return;
  preview.innerHTML = "";
  contentWordKeys.clear();
  if (bodyEl.value.trim()) renderTokensInto(preview, bodyEl.value);
  renderVocabList();
  updateDiaryWordStats();
}

function updateDiaryWordStats() {
  const statsEl = document.getElementById("diaryWordStats");
  if (!statsEl) return;
  const body = document.getElementById("diaryBody")?.value||"";
  if (!body.trim()) { statsEl.textContent=""; return; }
  const s = calcArticleStats(body);
  statsEl.textContent = `${s.total} 字 · 覆盖率 ${s.coverage}% · 生词 ${s.unknown}`;
}

document.getElementById("diaryBody")?.addEventListener("input", () => {
  clearTimeout(diaryPreviewTimer);
  diaryPreviewTimer = setTimeout(renderDiaryPreview, 350);
});

document.getElementById("newDiaryBtn")?.addEventListener("click", newDiaryEntry);
document.getElementById("diarySearch")?.addEventListener("input", () => renderDiaryList());

document.getElementById("cancelDiaryBtn")?.addEventListener("click", () => {
  if (currentDiaryId) {
    const e = diaryEntries.find(x=>x.id===currentDiaryId);
    if (e) { openDiaryEntry(e); return; }
  }
  document.getElementById("diaryEditor")?.classList.add("hidden");
  document.getElementById("diaryPlaceholder")?.classList.remove("hidden");
  currentDiaryId=null;
  contentWordKeys.clear();
  renderVocabList();
});

document.getElementById("saveDiaryBtn")?.addEventListener("click", () => {
  const dateVal  = document.getElementById("diaryDate")?.value||"";
  const titleVal = document.getElementById("diaryTitle")?.value?.trim()||"";
  const bodyVal  = document.getElementById("diaryBody")?.value||"";
  if (!bodyVal.trim()) { alert("请输入内容"); return; }
  const now = new Date().toISOString();
  if (currentDiaryId) {
    const idx = diaryEntries.findIndex(x=>x.id===currentDiaryId);
    if (idx >= 0) {
      diaryEntries[idx] = {...diaryEntries[idx], date:dateVal, title:titleVal, body:bodyVal, updatedAt:now};
    }
  } else {
    const entry = {id:genId(), date:dateVal, title:titleVal, body:bodyVal, tags:[], createdAt:now, updatedAt:now};
    currentDiaryId = entry.id;
    diaryEntries.unshift(entry);
    document.getElementById("deleteDiaryBtn")?.classList.remove("hidden");
  }
  saveDiary();
  renderDiaryList();
  alert("已保存");
});

document.getElementById("deleteDiaryBtn")?.addEventListener("click", () => {
  if (!currentDiaryId) return;
  const e = diaryEntries.find(x=>x.id===currentDiaryId);
  if (!confirm(`删除日记"${getDiaryTitle(e||{})}"？`)) return;
  diaryEntries = diaryEntries.filter(x=>x.id!==currentDiaryId);
  saveDiary();
  currentDiaryId=null;
  document.getElementById("diaryEditor")?.classList.add("hidden");
  document.getElementById("diaryPlaceholder")?.classList.remove("hidden");
  contentWordKeys.clear();
  renderVocabList();
  renderDiaryList();
});

document.getElementById("exportDiaryBtn")?.addEventListener("click", () => {
  const today = new Date().toISOString().slice(0,10);
  downloadBlob(JSON.stringify(diaryEntries, null, 2), `diary_backup_${today}.json`, "application/json");
});
document.getElementById("importDiaryBtn")?.addEventListener("click", () => {
  document.getElementById("importDiaryFile")?.click();
});
document.getElementById("importDiaryFile")?.addEventListener("change", async ev => {
  const f = ev.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (!Array.isArray(data)) { alert("格式错误"); return; }
    if (!confirm(`导入 ${data.length} 条日记（将与现有日记合并）？`)) return;
    const existingIds = new Set(diaryEntries.map(e=>e.id));
    data.forEach(e => { if (!existingIds.has(e.id)) diaryEntries.push(e); });
    diaryEntries.sort((a,b)=>b.date?.localeCompare(a.date||"")||0);
    saveDiary();
    renderDiaryList();
    alert(`已导入 ${data.length} 条`);
  } catch(e) { alert("导入失败: "+e.message); }
  ev.target.value="";
});

document.getElementById("copyPromptBtn")?.addEventListener("click", () => {
  const body = document.getElementById("diaryBody")?.value||"";
  const prompt = `请帮我修改我的丹麦语日记。保留我的意思，用中文解释语法错误，并给出自然的丹麦语版本。\n\n${body}`;
  const btn = document.getElementById("copyPromptBtn");
  navigator.clipboard?.writeText(prompt).then(()=>{
    if(btn){btn.textContent="已复制！"; setTimeout(()=>btn.textContent="复制纠错提示",2000);}
  }).catch(()=>{
    // Fallback
    const ta=document.createElement("textarea"); ta.value=prompt;
    document.body.appendChild(ta); ta.select(); document.execCommand("copy");
    document.body.removeChild(ta);
    if(btn){btn.textContent="已复制！"; setTimeout(()=>btn.textContent="复制纠错提示",2000);}
  });
});

// ── Header stats ───────────────────────────────────────────────────────────────
function updateHeaderStats() {
  const el = document.getElementById("headerStats");
  if (!el) return;
  const total   = Object.keys(vocabIndex).length;
  const lemmas  = new Set(Object.values(vocabIndex).map(v=>(v.lemma||"").toLowerCase()));
  const known   = [...lemmas].filter(lk => getWebLevel(vocabSurfaceToKey[lk]||lk) >= 4).length;
  const study   = needsStudySet.size;
  el.innerHTML = `
    <span class="header-stat">词库 <strong>${total}</strong></span>
    <span class="header-stat">已掌握 <strong>${known}</strong></span>
    <span class="header-stat">需学 <strong>${study}</strong></span>
  `;
}

// ── Tab switching ──────────────────────────────────────────────────────────────
function showTab(name) {
  currentTab = name;
  const tabs = {
    podcast: "podcastSection",
    reading: "readingSection",
    diary:   "diarySection",
    vocab:   "vocabBrowserSection",
  };

  // Reset tab buttons
  ["tabPodcast","tabReading","tabDiary","tabVocab"].forEach(id => {
    document.getElementById(id)?.classList.remove("active");
  });
  document.getElementById("tab"+name.charAt(0).toUpperCase()+name.slice(1))?.classList.add("active");

  // Hide all content sections
  Object.values(tabs).forEach(id => {
    document.getElementById(id)?.classList.add("hidden");
  });

  // Hide/show vocab panel
  const vp = document.getElementById("vocabPanel");
  if (vp) vp.style.display = (name === "vocab") ? "none" : "";

  // Show selected section
  document.getElementById(tabs[name])?.classList.remove("hidden");

  // Populate contentWordKeys for the active tab
  contentWordKeys.clear();
  if (name === "podcast") {
    document.querySelectorAll("#transcriptContainer .word").forEach(el => {
      const s = (el.dataset.surface||"").toLowerCase();
      const k = vocabSurfaceToKey[s]||s;
      if (vocabIndex[k]) contentWordKeys.add(k);
    });
  } else if (name === "reading" && currentArticleId) {
    const a = articles.find(x=>x.id===currentArticleId);
    if (a) renderReadingFromText(a.text);
  } else if (name === "diary" && currentDiaryId) {
    const e = diaryEntries.find(x=>x.id===currentDiaryId);
    if (e) {
      const preview = document.getElementById("diaryPreview");
      if (preview) { preview.innerHTML=""; renderTokensInto(preview, e.body||""); }
    }
  }

  renderVocabList();
  if (name === "vocab") renderVocabBrowser();
  updateHeaderStats();
}

document.getElementById("tabPodcast")?.addEventListener("click", ()=>showTab("podcast"));
document.getElementById("tabReading")?.addEventListener("click", ()=>showTab("reading"));
document.getElementById("tabDiary")  ?.addEventListener("click", ()=>showTab("diary"));
document.getElementById("tabVocab")  ?.addEventListener("click", ()=>showTab("vocab"));

// ── Button handlers ────────────────────────────────────────────────────────────
document.getElementById("editModeBtn")  ?.addEventListener("click", handleEditModeBtn);
document.getElementById("exportAnkiBtn")?.addEventListener("click", exportAnkiTSV);
document.getElementById("exportWebActionsBtn")?.addEventListener("click", exportWebActions);
document.getElementById("resetStateBtn")?.addEventListener("click", resetVisualState);

// Legacy flagged entries
const flaggedPanelEl = document.getElementById("flaggedPanel");
document.getElementById("showFlagged")?.addEventListener("click", () => {
  if (flaggedPanelEl) {
    flaggedPanelEl.classList.toggle("hidden");
    if (!flaggedPanelEl.classList.contains("hidden")) renderFlaggedPanel();
  }
});

function renderFlaggedPanel() {
  if (!flaggedPanelEl) return;
  flaggedPanelEl.innerHTML = "";
  const items = (flaggedEntries||[]).filter(e => !flaggedReviewedSet.has(`${e.source_file}:${e.source_line}`));
  if (!items.length) { flaggedPanelEl.innerHTML="<div style='padding:8px;font-size:12px'>无待复核条目</div>"; return; }
  items.slice(0,100).forEach(e => {
    const div = document.createElement("div");
    div.style.cssText="padding:6px;border-bottom:1px solid #eee;font-size:12px";
    div.innerHTML=`<b>${escH(e.lemma||"?")}</b> rank:${e.rank} — ${escH(e.source_file)}:${e.source_line}`;
    const btn=document.createElement("button"); btn.className="btn btn-sm"; btn.textContent="已复核";
    btn.addEventListener("click",()=>{
      flaggedReviewedSet.add(`${e.source_file}:${e.source_line}`);
      saveFlags(); renderFlaggedPanel();
    });
    div.appendChild(btn); flaggedPanelEl.appendChild(div);
  });
}

// ── Remote data loading ────────────────────────────────────────────────────────
async function loadRemoteIndex() {
  try {
    const resp = await fetch("vocab_index.json");
    if (resp.ok) {
      const raw = await resp.json();
      vocabIndex = raw || {};
      Object.values(vocabIndex).forEach(v => { v.rank = v.rank || 999999; });
      // Build surface → key mapping
      vocabSurfaceToKey = {};
      Object.entries(vocabIndex).forEach(([k,v]) => {
        try {
          vocabSurfaceToKey[String(k).toLowerCase()] = k;
          if (v?.lemma) vocabSurfaceToKey[String(v.lemma).toLowerCase()] = k;
        } catch(e){}
      });
      renderVocabList();
      const syncEl = document.getElementById("syncStatus");
      if (syncEl) syncEl.textContent = `${Object.keys(vocabIndex).length} 词`;
    }
  } catch(e) { console.warn("vocab_index.json not available", e); }

  try {
    const resp = await fetch("vocab_detail.json");
    if (resp.ok) vocabDetail = (await resp.json()) || {};
  } catch(e) { console.warn("vocab_detail.json not available", e); }

  try {
    const r2 = await fetch("user_mastery.json");
    if (r2.ok) {
      const remote = await r2.json();
      let updated = 0;
      Object.entries(remote).forEach(([k,v]) => {
        // Skip legacy Chinese/boolean false entries
        if (typeof v === "boolean" && !v) return;
        if (!/^[a-zA-ZæøåÆØÅ\s''\-]+$/.test(k)) return;
        const kl = k.toLowerCase();
        // Only import if entry has useful data
        if (typeof v === "boolean" || (typeof v==="object" && (v.level||v.interval||v.reps))) {
          userMastery[kl] = v;
          updated++;
        }
      });
      saveMastery();
      // Refresh all word spans
      document.querySelectorAll(".word").forEach(el => {
        const s = (el.dataset.surface||"").toLowerCase();
        const k = vocabSurfaceToKey[s]||s;
        applyWordClass(el, k);
      });
      renderVocabList();
      updateHeaderStats();
      const syncEl = document.getElementById("syncStatus");
      // Find latest update date
      const dates = Object.values(userMastery)
        .filter(v=>v?.updated_at)
        .map(v=>v.updated_at)
        .sort();
      if (dates.length && syncEl) {
        syncEl.textContent += ` · Anki ${dates[dates.length-1].slice(0,10)}`;
      }
    }
  } catch(e) { console.warn("user_mastery.json not available", e); }

  try {
    const r = await fetch("flagged_entries.json");
    if (r.ok) { flaggedEntries = await r.json(); }
  } catch(e) {}
}

// ── Init ───────────────────────────────────────────────────────────────────────
loadPersistence();
loadArticlesFromStorage();
loadDiary();
updateAuthUI();
showTab("podcast");
loadRemoteIndex();
loadEpisodes();
loadReadingIndex().then(() => renderArticleTree());
renderDiaryList();
updateHeaderStats();

// Debug handles
window._app = { vocabIndex, vocabSurfaceToKey, userMastery, vocabDetail,
                needsStudySet, webActions, articles, diaryEntries };
