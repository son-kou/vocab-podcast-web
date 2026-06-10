/* ═══════════════════════════════════════════════════════════════
   Danish Vocabulary Web App — app.js
   ═══════════════════════════════════════════════════════════════ */

// ── Storage keys ───────────────────────────────────────────────────────────────
const SK_MASTERY = "vocab_mastery_v3";
const SK_NEEDS   = "vocab_needs_study_v1";
const SK_ARTICLES= "vocab_articles_v1";
const SK_DIARY   = "vocab_diary_v1";
const SK_ACTIONS = "vocab_web_actions_v1";
const SK_FLAGS   = "vocab_flagged_reviewed_v1";
const SK_OOV     = "vocab_podcast_oov_cache_v1";

// ── Application state ──────────────────────────────────────────────────────────
let vocabIndex        = {};   // key → {lemma, zh, en, rank, pos}
let vocabSurfaceToKey = {};   // normalized surface → canonical key
let vocabDetail       = {};   // lemma.lower → {ipa, example_da, example_zh, mnemonic, warning, confusing}
let userMastery       = {};   // lemma.lower → {level, interval, reps, lapses, ease, manual, updated_at}
let extraVocab        = {};   // lemma/surface → {lemma, zh, en, pos, source, status, count, ...}
let oovCache          = {};   // surface → {count, isProper, firstSeen, lastSeen, contexts, wiktSuggestion}
let oovIgnoreSet      = new Set();

let needsStudySet    = new Set();
let webActions       = [];
let flaggedEntries   = [];
let flaggedReviewedSet = new Set();

let sentences        = [];
let episodes         = [];
let articles         = [];
let currentArticleId = null;
let diaryEntries     = [];
let currentDiaryId   = null;

// Per-content word tracking
let contentWordKeys  = new Set();   // main vocab keys
let contentOovKeys   = new Set();   // OOV surfaces
let contentWordFreq  = new Map();   // key → count
let contentOovFreq   = new Map();   // surface → count

let currentTab = "podcast";

// Hover card
let currentHoveredSurface = null;
const wiktionaryCache = new Map();
let hoverCard = null;
let hoverHideTimer = null;

// Vocab panel controls state
let vpSortMode     = "priority"; // "priority"|"freq"|"rank"|"alpha"
let vpShowMastered = false;
let vpShowOov      = true;
let vpShowProper   = false;

// 生词库 filter state
let vbFilter = { q:"", level:"", rank:"", pos:"", sort:"priority" };

// OOV save debounce
let oovCacheDirty = false;
let oovSaveTimer  = null;

// Anki snapshot date (from user_mastery.json)
let ankiSnapshotDate = null;

// ── Privacy gate (NOT real security — local-only convenience) ─────────────────
const EDIT_HASH = "e48971b4ee5ef14bbe1bb3189045cc1e9853cc7fb3d9075dd75b3509dc1a3f6b";
const SK_EDIT   = "vocab_edit_mode_v1";
function isEditMode() { return sessionStorage.getItem(SK_EDIT) === "ok"; }
async function hashPw(pw) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}
async function handleEditModeBtn() {
  if (isEditMode()) { sessionStorage.removeItem(SK_EDIT); updateAuthUI(); return; }
  const pw = prompt("本地编辑密码（本地隐私保护，非真正安全）:");
  if (!pw) return;
  if (await hashPw(pw) === EDIT_HASH) { sessionStorage.setItem(SK_EDIT,"ok"); updateAuthUI(); }
  else alert("密码错误");
}
function updateAuthUI() {
  const on = isEditMode();
  const btn = document.getElementById("editModeBtn");
  if (btn) btn.textContent = on ? "退出编辑" : "Edit Mode";
  document.querySelectorAll(".auth-required").forEach(el => { el.style.display = on ? "" : "none"; });
}

// ── Persistence ────────────────────────────────────────────────────────────────
function loadPersistence() {
  try { const r=localStorage.getItem(SK_MASTERY); if(r) userMastery=JSON.parse(r); } catch(e){}
  try { const r=localStorage.getItem(SK_NEEDS); if(r) JSON.parse(r).forEach(k=>needsStudySet.add(k)); } catch(e){}
  try { const r=localStorage.getItem(SK_ACTIONS); if(r) webActions=JSON.parse(r); } catch(e){}
  try { const r=localStorage.getItem(SK_FLAGS); if(r) JSON.parse(r).forEach(k=>flaggedReviewedSet.add(k)); } catch(e){}
  try { const r=localStorage.getItem(SK_OOV); if(r) oovCache=JSON.parse(r); } catch(e){}
}
function saveMastery()    { try { localStorage.setItem(SK_MASTERY, JSON.stringify(userMastery)); } catch(e){} }
function saveNeedsStudy() { try { localStorage.setItem(SK_NEEDS, JSON.stringify([...needsStudySet])); } catch(e){} }
function saveWebActions() { try { localStorage.setItem(SK_ACTIONS, JSON.stringify(webActions)); } catch(e){} }
function saveFlags()      { try { localStorage.setItem(SK_FLAGS, JSON.stringify([...flaggedReviewedSet])); } catch(e){} }
function saveOovCache()   { try { localStorage.setItem(SK_OOV, JSON.stringify(oovCache)); oovCacheDirty=false; } catch(e){} }
function scheduleOovSave() {
  oovCacheDirty = true;
  clearTimeout(oovSaveTimer);
  oovSaveTimer = setTimeout(() => { if(oovCacheDirty) saveOovCache(); }, 1500);
}

// ── Mastery system (0–4 web levels) ───────────────────────────────────────────
function resolveKey(key) {
  let m = userMastery[key];
  if (m === undefined && vocabIndex[key]?.lemma)
    m = userMastery[vocabIndex[key].lemma.toLowerCase()];
  return m;
}
function getWebLevel(key) {
  const m = resolveKey(key);
  if (!m) return 0;
  if (typeof m === "boolean") return m ? 4 : 0;
  if (typeof m !== "object") return 0;
  if (m.manual) return m.level >= 4 ? 4 : Math.max(0, m.level||0);
  const iv = m.interval||0, rp = m.reps||0;
  if (iv <= 0 && rp === 0) return 1;
  if (iv < 1)  return 1;
  if (iv < 7)  return 2;
  if (iv < 30) return 3;
  return 4;
}
function getLemmaKey(key) { return vocabIndex[key]?.lemma?.toLowerCase() || key; }
function getMasteryLabel(level) { return ["未学","学习中","复习中","熟悉","已掌握"][level]||""; }
function markKnown(key) {
  const lk = getLemmaKey(key);
  userMastery[lk] = {level:4,interval:30,reps:1,manual:true,updated_at:new Date().toISOString()};
  needsStudySet.delete(lk);
  saveMastery(); saveNeedsStudy();
}
function unmarkKnown(key) { const lk=getLemmaKey(key); delete userMastery[lk]; saveMastery(); }

// ── OOV system ─────────────────────────────────────────────────────────────────

// Tokens to ignore — not real Danish vocabulary
const OOV_SINGLE_LETTER_OK = new Set(["i","a","å","e","o"]);

function isOovNoise(surface) {
  if (!surface || surface.length === 0) return true;
  // Numbers and purely numeric
  if (/^\d+([.,]\d+)*$/.test(surface)) return true;
  // URLs
  if (/^https?:\/\//.test(surface)) return true;
  // Email
  if (/@/.test(surface)) return true;
  // No Danish letters at all
  if (!/[a-zA-ZæøåÆØÅ]/.test(surface)) return true;
  // Single-letter except known function words
  if (surface.length === 1 && !OOV_SINGLE_LETTER_OK.has(surface.toLowerCase())) return true;
  // Explicitly ignored
  if (oovIgnoreSet.has(surface.toLowerCase())) return true;
  return false;
}

function captureOovWord(surface, displayText, isProper) {
  if (oovIgnoreSet.has(surface)) return;
  const now = new Date().toISOString();
  if (!oovCache[surface]) {
    oovCache[surface] = {
      surface, displayText, isProper:!!isProper,
      count:0, firstSeen:now, lastSeen:now, contexts:[], wiktSuggestion:null,
    };
  }
  oovCache[surface].count = (oovCache[surface].count||0) + 1;
  oovCache[surface].lastSeen = now;
  // Add context snapshot (limit to 3 unique per word)
  const ctx = {type:currentTab, title:getCurrentContextTitle(), date:now.slice(0,10)};
  const exists = oovCache[surface].contexts.some(c=>c.title===ctx.title&&c.type===ctx.type);
  if (!exists && oovCache[surface].contexts.length < 3) oovCache[surface].contexts.push(ctx);
  scheduleOovSave();
}

function addOovToLocalExtra(surface) {
  if (!surface) return;
  const existing = extraVocab[surface];
  if (!existing) {
    extraVocab[surface] = {
      lemma: surface, zh:"待补充", en:"pending lookup",
      pos:"", source:["web-captured"], status:"auto", count:1,
      contexts: oovCache[surface]?.contexts || [],
      first_seen: oovCache[surface]?.firstSeen || new Date().toISOString(),
      last_seen: new Date().toISOString(),
    };
  }
  // Refresh spans
  document.querySelectorAll(`.word[data-surface="${surface}"]`).forEach(el=>{
    el.dataset.oov = "extra";
    applyWordClass(el, surface);
  });
  alert(`"${surface}" 已加入本地扩展词表。请导出 OOV 并运行 update_extra_vocab.py 合并到 extra_vocab.json。`);
}

function getUnfamiliarityScore(e) {
  if (e.isStudy) return 100;
  if (e.isOov && e.oovStatus === "local") return 80;
  if (e.isOov && e.oovStatus === "auto")  return 70;
  if (e.isOov)                            return 65;
  const lvl = e.level||0;
  if (lvl === 0) return 60;
  if (lvl === 1) return 50;
  if (lvl === 2) return 30;
  if (lvl === 3) return 10;
  return -80;
}

function clearContentKeys() {
  contentWordKeys.clear(); contentOovKeys.clear();
  contentWordFreq = new Map(); contentOovFreq = new Map();
}

// Export OOV cache as JSON
function exportOovCache() {
  const today = new Date().toISOString().slice(0,10);
  const entries = Object.values(oovCache).filter(e=>!e.isProper);
  downloadBlob(JSON.stringify(entries, null, 2), `oov_export_${today}.json`, "application/json");
}

// Export OOV for ChatGPT enrichment
function exportOovForChatGPT() {
  const today = new Date().toISOString().slice(0,10);
  const entries = Object.values(oovCache)
    .filter(e => !e.isProper)
    .map(e => ({
      lemma: e.surface,
      count: e.count,
      context_snippets: (e.contexts||[]).map(c=>c.title),
      current_en: e.wiktSuggestion || "",
      current_zh: extraVocab[e.surface]?.zh || "",
      requested_output: {
        lemma: e.surface,
        zh_brief: "< 15 chars Chinese definition, NO hallucination >",
        en_brief: "< 8 words English gloss >",
        pos: "N/V/A/Adv/etc",
        note: "optional: grammar/usage note",
      }
    }));
  const prompt = {
    instruction: "Below are Danish words found outside my 8000-word vocabulary. For each, provide zh_brief, en_brief, and pos. Base answers on real Danish dictionary meaning ONLY. If unsure, set zh_brief to '待确认'. Return as JSON array with the same structure.",
    words: entries
  };
  downloadBlob(JSON.stringify(prompt, null, 2), `oov_for_chatgpt_${today}.json`, "application/json");
}

// ── Web actions ────────────────────────────────────────────────────────────────
function getCurrentContextTitle() {
  if (currentTab === "podcast") {
    const s = document.getElementById("episodeSelect");
    const ep = episodes.find(e => s && String(e.id)===String(s.value));
    return ep ? `Ep.${ep.id}: ${ep.title}` : "Podcast";
  }
  if (currentTab === "reading" && currentArticleId) {
    const a = articles.find(x=>x.id===currentArticleId);
    return a ? getArticleTitle(a) : "Reading";
  }
  if (currentTab === "diary" && currentDiaryId) {
    const e = diaryEntries.find(x=>x.id===currentDiaryId);
    return e ? (e.title||e.date) : "Diary";
  }
  return currentTab;
}
function recordWebAction(lemma, action, surface) {
  webActions.push({lemma, action, surface, contextType:currentTab,
    contextTitle:getCurrentContextTitle(), ts:new Date().toISOString()});
  if (webActions.length > 2000) webActions = webActions.slice(-2000);
  saveWebActions();
}

// ── Word engine ────────────────────────────────────────────────────────────────
function applyWordClass(el, key) {
  el.className = "word";
  const surface = (el.dataset.surface || "").toLowerCase();
  const oovType = el.dataset.oov;

  // Determine study key (OOV uses surface directly)
  const lk = oovType ? surface : getLemmaKey(key);

  if (needsStudySet.has(lk) || needsStudySet.has(surface)) {
    el.classList.add("w-study");
    return;
  }
  if (oovType === "proper") { el.classList.add("w-proper"); return; }
  if (oovType === "true" || oovType === "extra") { el.classList.add("w-oov"); return; }

  const level = getWebLevel(key);
  if (level > 0) el.classList.add(`w-m${level}`);
}

function normalizeToken(t) {
  return t.replace(/^[.,!?;:()"'«»–—\[\]]+|[.,!?;:()"'«»–—\[\]]+$/g, "").toLowerCase();
}
function displayToken(t) {
  return t.replace(/^[.,!?;:()"'«»–—\[\]]+|[.,!?;:()"'«»–—\[\]]+$/g, "");
}

function makeWordSpan(displayText, lookupKey) {
  const norm = lookupKey || displayText.toLowerCase();

  // Lookup: main vocab → extra vocab → OOV
  const key      = vocabSurfaceToKey[norm] || norm;
  const info     = vocabIndex[key] || null;
  const extraInfo = !info ? (extraVocab[norm] || extraVocab[key] || null) : null;

  const span = document.createElement("span");
  span.className = "word";
  span.textContent = displayText;
  span.dataset.surface = norm;

  if (info || vocabSurfaceToKey[norm]) {
    // ─ Main vocab
    contentWordKeys.add(key);
    contentWordFreq.set(key, (contentWordFreq.get(key)||0)+1);
  } else if (extraInfo) {
    // ─ Extra vocab (from extra_vocab.json)
    span.dataset.oov = "extra";
    contentOovKeys.add(norm);
    contentOovFreq.set(norm, (contentOovFreq.get(norm)||0)+1);
  } else if (!isOovNoise(norm)) {
    // ─ True OOV
    const isProper = /^[A-ZÆØÅ]/.test(displayText);
    span.dataset.oov = isProper ? "proper" : "true";
    contentOovKeys.add(norm);
    contentOovFreq.set(norm, (contentOovFreq.get(norm)||0)+1);
    captureOovWord(norm, displayText, isProper);
  }

  span.addEventListener("mouseenter", onWordHover);
  span.addEventListener("mouseleave", onWordLeave);
  span.addEventListener("click", onWordClick);
  applyWordClass(span, key);
  return span;
}

function renderTokensInto(container, text) {
  const paras = String(text).split(/\n\s*\n/).filter(Boolean);
  paras.forEach(rawPara => {
    const para = document.createElement("div");
    para.className = "sentence";
    const trimmed = rawPara.trimStart();
    if      (trimmed.startsWith("### ")) { para.classList.add("para-h3"); rawPara = rawPara.replace(/^#+\s*/,""); }
    else if (trimmed.startsWith("## "))  { para.classList.add("para-h2"); rawPara = rawPara.replace(/^#+\s*/,""); }
    else if (trimmed.startsWith("# "))   { para.classList.add("para-h1"); rawPara = rawPara.replace(/^#+\s*/,""); }
    const span = document.createElement("span");
    span.className = "text";
    rawPara.replace(/\r?\n/g," ").split(/(\s+)/).forEach(t => {
      if (/\s+/.test(t)) span.appendChild(document.createTextNode(t));
      else {
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
    const s = (el.dataset.surface||"").toLowerCase();
    const oovType = el.dataset.oov;
    if (oovType) {
      // OOV: match by surface
      if (s === lemmaKey) applyWordClass(el, s);
    } else {
      const k  = vocabSurfaceToKey[s]||s;
      const lk = getLemmaKey(k);
      if (lk === lemmaKey || k === lemmaKey) applyWordClass(el, k);
    }
  });
}

// ── Hover card ─────────────────────────────────────────────────────────────────
function scheduleHide() {
  clearTimeout(hoverHideTimer);
  hoverHideTimer = setTimeout(() => {
    if (hoverCard && !hoverCard.matches(":hover")) {
      hoverCard.style.display = "none"; currentHoveredSurface = null;
    }
  }, 280);
}
function getHoverCard() {
  if (!hoverCard) {
    hoverCard = document.createElement("div");
    hoverCard.className = "hoverCard";
    hoverCard.addEventListener("mouseenter", ()=>clearTimeout(hoverHideTimer));
    hoverCard.addEventListener("mouseleave", scheduleHide);
    document.body.appendChild(hoverCard);
  }
  return hoverCard;
}
function escH(s) {
  return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function buildHoverHTML(surface, info, key, oovType) {
  const extraInfo = !info ? (extraVocab[surface]||extraVocab[key]||null) : null;
  const oovEntry  = oovCache[surface] || null;
  let html = "";

  if (!info && !extraInfo) {
    // Pure OOV / not in any vocab
    const isProper = oovType === "proper";
    html  = `<div class="hc-lemma">${escH(surface)}`;
    html += `<span class="hc-badge ${isProper?"badge-proper":"badge-oov"}">${isProper?"专名?":"8000外"}</span></div>`;
    html += `<div class="hc-oov-note">未在 Basic Danish 8000 词表中</div>`;
    if (oovEntry?.count > 1) html += `<div class="hc-oov-count">已见 ${oovEntry.count} 次</div>`;
    html += `<hr class="hc-divider">${externalLinks(surface)}`;
    if (!isProper) {
      const safe = surface.replace(/['"\\<>]/g,"");
      html += `<div class="hc-oov-actions"><button class="hc-oov-btn" onclick="addOovToLocalExtra('${safe}')">+ 扩展词表</button></div>`;
    }
  } else {
    // Main vocab or extra vocab
    const lemma = info ? (info.lemma||surface) : (extraInfo.lemma||surface);
    const level  = info ? getWebLevel(key) : 0;
    const lk     = info ? getLemmaKey(key) : surface;
    const detail = vocabDetail[lemma.toLowerCase()]||{};
    const isStudy = needsStudySet.has(lk)||needsStudySet.has(surface);
    const zh = info?.zh||extraInfo?.zh||"";
    const en = info?.en||extraInfo?.en||"";

    html  = `<div class="hc-lemma">${escH(lemma)}`;
    if (info?.rank) html += `<span class="hc-meta">rank ${info.rank}${info.pos?" · "+info.pos:""}</span>`;
    else            html += `<span class="hc-badge badge-oov">extra</span>`;
    if (isStudy)        html += `<span class="hc-mastery study">需学</span>`;
    else if (level > 0) html += `<span class="hc-mastery">${escH(getMasteryLabel(level))}</span>`;
    html += `</div>`;
    if (detail.ipa) html += `<div class="hc-ipa">/${escH(detail.ipa)}/</div>`;
    if (zh) html += `<div class="hc-gloss-zh">${escH(zh)}</div>`;
    else    html += `<div class="hc-gloss-zh hc-pending">待补充</div>`;
    if (en) html += `<div class="hc-gloss-en">${escH(en)}</div>`;

    const hasExtra = detail.example_da||detail.mnemonic||detail.warning||(detail.confusing?.length);
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
  const el = ev.target;
  const surface = (el.dataset.surface||el.textContent||"").toLowerCase();
  const oovType = el.dataset.oov||null;
  currentHoveredSurface = surface;
  const key  = vocabSurfaceToKey[surface];
  const info = key ? vocabIndex[key] : null;
  const card = getHoverCard();
  card.innerHTML = buildHoverHTML(surface, info, key, oovType);

  const rect = ev.target.getBoundingClientRect();
  const cardW = 320, cardH = 400;
  let left = rect.right + 8;
  if (left + cardW > window.innerWidth - 8) left = Math.max(4, rect.left - cardW - 8);
  let top = rect.top;
  if (top + cardH > window.innerHeight - 8) top = Math.max(4, window.innerHeight - cardH - 8);
  card.style.left = left + "px";
  card.style.top  = top + "px";
  card.style.display = "block";
  clearTimeout(hoverHideTimer);

  const lookupLemma = info?.lemma?.toLowerCase() || extraVocab[surface]?.lemma?.toLowerCase() || surface;
  updateWiktSection(card, lookupLemma, surface);
}
function onWordLeave() { scheduleHide(); }

// ── Wiktionary ─────────────────────────────────────────────────────────────────
function stripHtml(s) {
  const d = document.createElement("div"); d.innerHTML = s||""; return d.textContent||"";
}
function buildWiktHTML(entries) {
  if (!entries?.length) return '<div class="hc-wikt-empty">Wiktionary: 未找到丹麦语条目</div>';
  let html = '<div class="hc-wikt-label">Wiktionary 互查</div>';
  for (const entry of entries.slice(0,2)) {
    if (entry.partOfSpeech) html += `<span class="hc-wikt-pos">${escH(entry.partOfSpeech)}</span> `;
    for (const def of (entry.definitions||[]).slice(0,2)) {
      const t = stripHtml(def.definition||"");
      if (t) html += `<div class="hc-wikt-def">${escH(t)}</div>`;
    }
  }
  return html;
}
async function updateWiktSection(card, lemma, surface) {
  const el = card.querySelector(".hc-wikt-section");
  if (!el) return;
  if (wiktionaryCache.has(lemma)) {
    const cached = wiktionaryCache.get(lemma);
    el.innerHTML = buildWiktHTML(cached);
    // Store suggestion in OOV cache if relevant
    if (cached?.length && oovCache[surface]) {
      const def = cached[0]?.definitions?.[0];
      if (def) oovCache[surface].wiktSuggestion = stripHtml(def.definition||"").slice(0,120);
    }
    return;
  }
  el.innerHTML = '<div class="hc-wikt-loading">Wiktionary…</div>';
  try {
    const resp = await fetch(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(lemma)}`);
    const entries = resp.ok ? ((await resp.json()).da||[]) : null;
    wiktionaryCache.set(lemma, entries);
    if (currentHoveredSurface === surface && card.style.display !== "none")
      el.innerHTML = buildWiktHTML(entries);
    if (entries?.length && oovCache[surface]) {
      const def = entries[0]?.definitions?.[0];
      if (def) { oovCache[surface].wiktSuggestion = stripHtml(def.definition||"").slice(0,120); scheduleOovSave(); }
    }
  } catch(e) {
    wiktionaryCache.set(lemma, null);
    if (currentHoveredSurface === surface && card.style.display !== "none")
      el.innerHTML = '<div class="hc-wikt-empty">Wiktionary 查询失败</div>';
  }
}

// ── Word click — toggle needsStudy ────────────────────────────────────────────
function onWordClick(ev) {
  ev.stopPropagation();
  const el = ev.target;
  const surface = (el.dataset.surface||"").toLowerCase();
  const oovType = el.dataset.oov;
  const key = oovType ? surface : (vocabSurfaceToKey[surface]||surface);
  const lk  = oovType ? surface : getLemmaKey(key);

  if (needsStudySet.has(lk)) {
    needsStudySet.delete(lk);
    recordWebAction(lk, "unstudy", surface);
  } else {
    needsStudySet.add(lk);
    recordWebAction(lk, "study", surface);
    if (oovType === "true") addOovToLocalExtra(surface);
  }
  saveNeedsStudy();
  // Refresh all spans matching this lemma/surface
  document.querySelectorAll(".word").forEach(span => {
    const s = (span.dataset.surface||"").toLowerCase();
    const st = span.dataset.oov;
    if (st) { if (s === lk) applyWordClass(span, s); }
    else    { const k2=vocabSurfaceToKey[s]||s; if(getLemmaKey(k2)===lk||k2===lk) applyWordClass(span,k2); }
  });
  renderVocabList();
  if (currentTab === "vocab") renderVocabBrowser();
}

// ── Transcript rendering (Podcast) ────────────────────────────────────────────
const transcriptContainer = document.getElementById("transcriptContainer");
const sentenceTemplate    = document.getElementById("sentenceTemplate");

function renderTranscript() {
  if (!transcriptContainer) return;
  transcriptContainer.innerHTML = "";
  clearContentKeys();
  sentences.forEach(s => {
    const node = sentenceTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.start = s.start; node.dataset.end = s.end;
    const textSpan = node.querySelector(".text");
    s.text.replace(/\r?\n/g," ").split(/(\s+)/).forEach(t => {
      if (/\s+/.test(t)) textSpan.appendChild(document.createTextNode(t));
      else {
        const norm = normalizeToken(t), disp = displayToken(t);
        if (norm) textSpan.appendChild(makeWordSpan(disp, norm));
        else if (t) textSpan.appendChild(document.createTextNode(t));
      }
    });
    node.addEventListener("click", () => {
      const useTTS = document.getElementById("useTTS");
      const audio  = document.getElementById("audio");
      if ((useTTS&&useTTS.checked)||!audio?.src) speakText(s.text);
      else { audio.currentTime = parseFloat(s.start)||0; audio.play(); }
    });
    transcriptContainer.appendChild(node);
  });
  scheduleOovSave();
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
      const r = parseFloat(document.getElementById("speed")?.value)||1;
      u.rate = Math.min(Math.max(isFinite(r)&&r>0?r:1, 0.5), 2.0);
      u.onend=()=>resolve(); u.onerror=()=>resolve();
      speechSynthesis.speak(u);
    } catch(e) { resolve(); }
  });
}
async function startTTSAuto(fromIndex=0) {
  if (!("speechSynthesis" in window)) return;
  ttsAutoPlaying = true;
  for (let i=fromIndex; i<sentences.length&&ttsAutoPlaying; i++) {
    transcriptContainer?.querySelectorAll(".sentence").forEach(n=>n.classList.remove("active"));
    const node = transcriptContainer?.querySelectorAll(".sentence")[i];
    if (node) { node.classList.add("active"); node.scrollIntoView({behavior:"smooth",block:"center"}); }
    await speakText(sentences[i].text);
    if (!ttsAutoPlaying) break;
    await new Promise(r=>setTimeout(r,200));
  }
  ttsAutoPlaying = false;
  const c = document.getElementById("ttsAuto"); if(c) c.checked=false;
}
function stopTTSAuto() { ttsAutoPlaying=false; try{speechSynthesis.cancel();}catch(e){} }
function speakCurrentSentence() {
  const active = transcriptContainer?.querySelector(".sentence.active")
              || transcriptContainer?.querySelector(".sentence");
  if (!active) return;
  const idx = [...(transcriptContainer?.querySelectorAll(".sentence")||[])].indexOf(active);
  if (sentences[idx]) speakText(sentences[idx].text);
}
document.getElementById("ttsSpeak")?.addEventListener("click", speakCurrentSentence);
document.getElementById("ttsAuto") ?.addEventListener("change", e => {
  if (e.target.checked) startTTSAuto(); else stopTTSAuto();
});
const audio = document.getElementById("audio");
if (audio) {
  audio.addEventListener("timeupdate", () => {
    const t = audio.currentTime;
    let active = null;
    for (const node of (transcriptContainer?.querySelectorAll(".sentence")||[])) {
      const s=parseFloat(node.dataset.start), e=parseFloat(node.dataset.end);
      if (t>=s&&t<=e) { active=node; break; }
    }
    transcriptContainer?.querySelectorAll(".sentence").forEach(n=>n.classList.remove("active"));
    if (active) { active.classList.add("active"); active.scrollIntoView({behavior:"smooth",block:"center"}); }
  });
}
const speedEl = document.getElementById("speed");
if (speedEl && audio) speedEl.addEventListener("change", ()=>{ audio.playbackRate=parseFloat(speedEl.value); });

// ── Vocab panel ────────────────────────────────────────────────────────────────

function buildVocabEntries() {
  // Build structured entry list from current content keys
  const entries = [];
  const seenLemmas = new Set();

  // From main vocab
  const sortedKeys = [...contentWordKeys].sort((a,b)=>(vocabIndex[a]?.rank||999999)-(vocabIndex[b]?.rank||999999));
  sortedKeys.forEach(k => {
    const v = vocabIndex[k]; if (!v) return;
    const lemma = (v.lemma||k).toLowerCase();
    if (seenLemmas.has(lemma)) return;
    seenLemmas.add(lemma);
    const lk = getLemmaKey(k);
    entries.push({
      key: k, lemma: v.lemma||k, zh: v.zh||"", en: v.en||"",
      rank: v.rank||999999, pos: v.pos||"",
      level: getWebLevel(k),
      isStudy: needsStudySet.has(lk),
      isOov: false, oovStatus: null,
      freq: contentWordFreq.get(k)||1,
      source: "main-8000",
    });
  });

  // From OOV
  [...contentOovKeys].forEach(surface => {
    if (seenLemmas.has(surface)) return;
    seenLemmas.add(surface);
    const extra = extraVocab[surface]||null;
    const oovEntry = oovCache[surface]||null;
    const isProper = oovEntry?.isProper||false;
    if (isProper && !vpShowProper) return;
    entries.push({
      key: surface, lemma: extra?.lemma||surface, zh: extra?.zh||"", en: extra?.en||"",
      rank: Infinity, pos: extra?.pos||"",
      level: 0,
      isStudy: needsStudySet.has(surface),
      isOov: true, isProper,
      oovStatus: extra ? extra.status : "local",
      freq: contentOovFreq.get(surface)||1,
      source: extra ? "extra-vocab" : "local-oov",
    });
  });

  return entries;
}

function sortEntries(entries, sortMode) {
  if (sortMode === "priority") {
    return [...entries].sort((a,b) => {
      const sd = getUnfamiliarityScore(b) - getUnfamiliarityScore(a);
      if (sd !== 0) return sd;
      const fd = (b.freq||0) - (a.freq||0);
      if (fd !== 0) return fd;
      return (a.rank||Infinity) - (b.rank||Infinity);
    });
  }
  if (sortMode === "freq") return [...entries].sort((a,b)=>(b.freq||0)-(a.freq||0));
  if (sortMode === "rank") return [...entries].sort((a,b)=>(a.rank||Infinity)-(b.rank||Infinity));
  if (sortMode === "alpha") return [...entries].sort((a,b)=>a.lemma.localeCompare(b.lemma));
  return entries;
}

function buildVocabRow(entry) {
  const { key, lemma, zh, en, rank, level, isStudy, isOov, isProper, freq, source } = entry;
  const lk = isOov ? key : getLemmaKey(key);

  const row = document.createElement("div");
  row.className = "vrow";
  if (isStudy) row.classList.add("vrow-study");
  else if (isOov && !isProper) row.classList.add("vrow-oov");
  else if (!isOov && level >= 1) row.classList.add(`vrow-m${level}`);

  // Head: lemma + badge + freq + button
  const head = document.createElement("div"); head.className = "vrow-head";

  const lemmaEl = document.createElement("span"); lemmaEl.className = "vrow-lemma"; lemmaEl.textContent = lemma;
  head.appendChild(lemmaEl);

  const badge = document.createElement("span"); badge.className = "vrow-badge";
  if (isStudy)          { badge.classList.add("badge-study");  badge.textContent = "★学"; }
  else if (isProper)    { badge.classList.add("badge-proper"); badge.textContent = "专名"; }
  else if (isOov)       { badge.classList.add("badge-oov");    badge.textContent = "OOV"; }
  else if (level === 0) { badge.classList.add("badge-l0");     badge.textContent = "L0"; }
  else if (level === 1) { badge.classList.add("badge-l1");     badge.textContent = "L1"; }
  else if (level === 2) { badge.classList.add("badge-l2");     badge.textContent = "L2"; }
  else if (level === 3) { badge.classList.add("badge-l3");     badge.textContent = "L3"; }
  else                  { badge.classList.add("badge-l4");     badge.textContent = "✓"; }
  head.appendChild(badge);

  if (freq > 1) {
    const freqEl = document.createElement("span"); freqEl.className = "vrow-freq";
    freqEl.textContent = `${freq}x`; head.appendChild(freqEl);
  }

  const btn = document.createElement("button");
  btn.className = "vrow-btn";
  if (isStudy) {
    btn.textContent = "取消";
    btn.addEventListener("click", ev => {
      ev.stopPropagation();
      needsStudySet.delete(lk); saveNeedsStudy();
      refreshAllSpansForLemma(lk); renderVocabList();
    });
  } else if (!isOov && level >= 4) {
    btn.textContent = "已掌握"; btn.classList.add("known");
    btn.addEventListener("click", ev => {
      ev.stopPropagation();
      unmarkKnown(key); refreshAllSpansForLemma(lk); renderVocabList();
    });
  } else {
    btn.textContent = isOov ? "标记" : "学习";
    btn.addEventListener("click", ev => {
      ev.stopPropagation();
      needsStudySet.add(lk); saveNeedsStudy();
      refreshAllSpansForLemma(lk); renderVocabList();
      if (currentTab === "vocab") renderVocabBrowser();
    });
  }
  head.appendChild(btn);
  row.appendChild(head);

  // Gloss line
  const gloss = zh || en;
  if (gloss) {
    const glossEl = document.createElement("div"); glossEl.className = "vrow-gloss";
    glossEl.textContent = [zh, en?`/ ${en}`:""].filter(Boolean).join(" ");
    row.appendChild(glossEl);
  }

  return row;
}

function renderVocabGroup(container, items, label) {
  if (!items.length) return;
  const heading = document.createElement("div");
  heading.className = "vgroup-head";
  heading.innerHTML = `<span class="vgroup-label">${escH(label)}</span><span class="vgroup-count">${items.length}</span>`;
  container.appendChild(heading);
  items.forEach(e => container.appendChild(buildVocabRow(e)));
}

function renderVocabList() {
  const vocabList  = document.getElementById("vocabList");
  const vocabStats = document.getElementById("vocabStats");
  if (!vocabList || !vocabStats) return;
  vocabList.innerHTML = "";

  // Empty state
  if ((currentTab==="reading"||currentTab==="diary") && contentWordKeys.size===0 && contentOovKeys.size===0) {
    vocabStats.textContent = currentTab==="diary" ? "打开日记后显示生词" : "请选择文章或粘贴文本";
    return;
  }

  const allEntries = buildVocabEntries();
  if (allEntries.length === 0) {
    if (contentWordKeys.size===0&&contentOovKeys.size===0) {
      vocabStats.textContent = "No vocab loaded."; return;
    }
    vocabStats.textContent = "当前内容无生词"; return;
  }

  const sorted = sortEntries(allEntries, vpSortMode);

  // Partition into groups
  const groups = {
    study:  sorted.filter(e => e.isStudy),
    oov:    sorted.filter(e => !e.isStudy && e.isOov && !e.isProper),
    proper: sorted.filter(e => !e.isStudy && e.isOov && e.isProper),
    l0:     sorted.filter(e => !e.isStudy && !e.isOov && e.level === 0),
    l1:     sorted.filter(e => !e.isStudy && !e.isOov && e.level === 1),
    l2:     sorted.filter(e => !e.isStudy && !e.isOov && e.level === 2),
    l3:     sorted.filter(e => !e.isStudy && !e.isOov && e.level === 3),
    l4:     sorted.filter(e => !e.isStudy && !e.isOov && e.level === 4),
  };

  renderVocabGroup(vocabList, groups.study, "★ 需学习");
  if (vpShowOov) renderVocabGroup(vocabList, groups.oov, "8000以外");
  renderVocabGroup(vocabList, groups.l0, "未见过");
  renderVocabGroup(vocabList, groups.l1, "学习中");
  renderVocabGroup(vocabList, groups.l2, "复习中");
  renderVocabGroup(vocabList, groups.l3, "熟悉");
  if (vpShowMastered) renderVocabGroup(vocabList, groups.l4, "已掌握");
  if (vpShowProper && groups.proper.length)
    renderVocabGroup(vocabList, groups.proper, "专有名词?");

  if (vocabList.children.length === 0)
    vocabList.innerHTML = "<div class='vrow' style='color:#aaa;font-size:12px;padding:4px 8px'>当前内容词汇都已掌握！</div>";

  // Stats
  const total    = allEntries.length;
  const oovCount = groups.oov.length;
  const knownCnt = groups.l4.length;
  const studyCnt = groups.study.length;
  const unkCnt   = groups.l0.length + groups.l1.length + oovCount;
  const mainTotal = allEntries.filter(e=>!e.isOov).length;
  const coverage = mainTotal > 0 ? Math.round(knownCnt/mainTotal*100) : 0;
  const src = (contentWordKeys.size+contentOovKeys.size) > 0 ? "本文" : "全库";
  vocabStats.textContent = `${src} ${total}词 · 生词${unkCnt} · OOV ${oovCount} · 掌握${knownCnt} · 覆盖${coverage}%`;
  updateAuthUI();
}

// Vocab panel controls
document.getElementById("vpSortSelect")?.addEventListener("change", e => {
  vpSortMode = e.target.value; renderVocabList();
});
document.getElementById("vpShowMastered")?.addEventListener("change", e => {
  vpShowMastered = e.target.checked; renderVocabList();
});
document.getElementById("vpShowOov")?.addEventListener("change", e => {
  vpShowOov = e.target.checked; renderVocabList();
});

// ── Vocab browser (生词库 tab) ──────────────────────────────────────────────────
function renderVocabBrowser() {
  const list  = document.getElementById("vocabBrowserList");
  const stats = document.getElementById("vocabBrowserStats");
  if (!list) return;

  // Build combined entry list: main vocab + extra vocab + local OOV
  const allEntries = [];
  const seenLemmas = new Set();

  // Main vocab entries
  Object.entries(vocabIndex).forEach(([k,v]) => {
    const lemma = (v.lemma||k).toLowerCase();
    if (seenLemmas.has(lemma)) return;
    seenLemmas.add(lemma);
    const lk = getLemmaKey(k);
    allEntries.push({
      key:k, lemma:v.lemma||k, zh:v.zh||"", en:v.en||"",
      rank:v.rank||999999, pos:v.pos||"",
      level:getWebLevel(k), isStudy:needsStudySet.has(lk),
      isOov:false, source:"main-8000",
    });
  });

  // Extra vocab entries
  Object.entries(extraVocab).forEach(([surface, ev]) => {
    const lemma = (ev.lemma||surface).toLowerCase();
    if (seenLemmas.has(lemma)) return;
    seenLemmas.add(lemma);
    allEntries.push({
      key:surface, lemma:ev.lemma||surface, zh:ev.zh||"", en:ev.en||"",
      rank:Infinity, pos:ev.pos||"",
      level:0, isStudy:needsStudySet.has(surface),
      isOov:true, oovStatus:ev.status, source:"extra-vocab",
    });
  });

  // Local OOV cache (not in extraVocab)
  Object.keys(oovCache).forEach(surface => {
    const lemma = surface.toLowerCase();
    if (seenLemmas.has(lemma)) return;
    if (oovCache[surface]?.isProper) return;
    seenLemmas.add(lemma);
    allEntries.push({
      key:surface, lemma:surface, zh:"", en:"",
      rank:Infinity, pos:"",
      level:0, isStudy:needsStudySet.has(surface),
      isOov:true, oovStatus:"local", source:"local-oov",
    });
  });

  // Apply filters
  const q      = vbFilter.q.toLowerCase().trim();
  const fLevel = vbFilter.level;
  const fRank  = vbFilter.rank ? parseInt(vbFilter.rank) : 0;
  const fPos   = vbFilter.pos;

  let filtered = allEntries.filter(e => {
    if (q && !e.lemma.toLowerCase().includes(q) && !e.zh.includes(q)) return false;
    if (fRank && (e.rank||Infinity) > fRank) return false;
    if (fPos  && e.pos !== fPos) return false;
    if (fLevel === "study")  return e.isStudy;
    if (fLevel === "oov")    return e.isOov;
    if (fLevel === "0")      return !e.isStudy && !e.isOov && e.level === 0;
    if (fLevel === "1")      return !e.isStudy && !e.isOov && e.level === 1;
    if (fLevel === "2")      return !e.isStudy && !e.isOov && e.level === 2;
    if (fLevel === "3")      return !e.isStudy && !e.isOov && e.level === 3;
    if (fLevel === "4")      return !e.isStudy && !e.isOov && e.level === 4;
    // Default: don't show all 8000 — show learning-relevant words only
    if (!q && !fLevel && !fRank && !fPos)
      return e.isStudy || e.isOov || e.level < 3;
    return true;
  });

  // Sort
  filtered = sortEntries(filtered, vbFilter.sort);

  list.innerHTML = "";
  filtered.slice(0, 1500).forEach(e => {
    const lk = e.isOov ? e.key : getLemmaKey(e.key);
    const chip = document.createElement("div");
    chip.className = "vbChip";
    if (e.isStudy)      chip.classList.add("w-study");
    else if (e.isOov)   chip.classList.add("vb-oov");
    else if (e.level>=4) chip.classList.add("w-m4");

    const ls = document.createElement("span"); ls.className="vb-lemma"; ls.textContent=e.lemma;
    const zs = document.createElement("span"); zs.className="vb-zh";
    zs.textContent = e.zh ? `— ${e.zh}` : (e.isOov ? "待补充" : "");
    const rs = document.createElement("span"); rs.className="vb-rank";
    rs.textContent = isFinite(e.rank) ? `#${e.rank}` : "OOV";

    chip.appendChild(ls);
    if (e.zh||e.isOov) chip.appendChild(zs);
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

  // Anki snapshot note
  const snapEl = document.getElementById("ankiSnapshotNote");
  if (snapEl) {
    snapEl.textContent = ankiSnapshotDate
      ? `Anki 快照: ${ankiSnapshotDate} · 运行 push_update.sh 同步`
      : "Anki 数据从 user_mastery.json 加载 · 非实时同步";
  }

  // Stats
  const totalUnknown = allEntries.filter(e=>!e.isOov&&getWebLevel(e.key)<3).length;
  const totalStudy   = allEntries.filter(e=>needsStudySet.has(e.isOov?e.key:getLemmaKey(e.key))).length;
  const totalKnown   = allEntries.filter(e=>!e.isOov&&getWebLevel(e.key)>=4).length;
  const totalOov     = allEntries.filter(e=>e.isOov).length;
  if (stats) {
    stats.textContent = (q||fLevel||fRank||fPos)
      ? `显示 ${filtered.length}${filtered.length>1500?" (前1500)":""}词`
      : `共 ${allEntries.length}词 · 生词${totalUnknown} · OOV ${totalOov} · 需学${totalStudy} · 已掌握${totalKnown}`;
  }
}

// 生词库 filter/sort controls
document.getElementById("vocabSearch")  ?.addEventListener("input",  e => { vbFilter.q    = e.target.value; renderVocabBrowser(); });
document.getElementById("vbFilterLevel")?.addEventListener("change", e => { vbFilter.level = e.target.value; renderVocabBrowser(); });
document.getElementById("vbFilterRank") ?.addEventListener("change", e => { vbFilter.rank  = e.target.value; renderVocabBrowser(); });
document.getElementById("vbFilterPos")  ?.addEventListener("change", e => { vbFilter.pos   = e.target.value; renderVocabBrowser(); });
document.getElementById("vbSortSelect") ?.addEventListener("change", e => { vbFilter.sort  = e.target.value; renderVocabBrowser(); });

// ── Export functions ───────────────────────────────────────────────────────────
function exportAnkiTSV() {
  const rows = [];
  const keys = contentWordKeys.size > 0 ? [...contentWordKeys] : Object.keys(vocabIndex);
  keys.forEach(k => {
    const v = vocabIndex[k]; if (!v) return;
    rows.push([v.lemma||k, `${v.zh||""} — ${v.en||""}`, getMasteryLabel(getWebLevel(k))||"未学"].join("\t"));
  });
  downloadBlob(rows.join("\n"), "vocab_anki_export.tsv", "text/tab-separated-values");
}
function exportWebActions() {
  const today = new Date().toISOString().slice(0,10);
  downloadBlob(JSON.stringify(webActions,null,2), `web_anki_actions_${today}.json`, "application/json");
}
function resetVisualState() {
  if (!confirm("重置所有手动高亮（保留 Anki 掌握数据）？\n\n将会：\n- 清除所有「需学」标记\n- 不影响 user_mastery.json")) return;
  needsStudySet.clear(); saveNeedsStudy();
  document.querySelectorAll(".word").forEach(el => {
    const s=(el.dataset.surface||"").toLowerCase(), k=vocabSurfaceToKey[s]||s;
    applyWordClass(el, k);
  });
  renderVocabList(); if (currentTab==="vocab") renderVocabBrowser();
}
function clearOovCache() {
  if (!confirm("清除本地 OOV 缓存？（不影响 extra_vocab.json）")) return;
  oovCache = {}; saveOovCache();
  clearContentKeys();
  document.querySelectorAll(".word[data-oov]").forEach(el => { delete el.dataset.oov; el.className="word"; });
  renderVocabList(); if (currentTab==="vocab") renderVocabBrowser();
  alert("OOV 缓存已清除");
}
function downloadBlob(content, filename, type) {
  const blob = new Blob([content], {type});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
}

// ── File parsers ───────────────────────────────────────────────────────────────
function parseVTT(text) {
  const lines = text.split(/\r?\n/); const cues=[]; let i=0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes("-->")) {
      const parts = line.split("-->"); const start=vttToSec(parts[0].trim()); const end=vttToSec(parts[1].trim().split(/\s/)[0]);
      i++; let txt="";
      while (i<lines.length&&lines[i].trim()) { txt+=lines[i]+"\n"; i++; }
      cues.push({start,end,text:txt.trim()});
    } else i++;
  }
  return cues;
}
function vttToSec(s) {
  const m=s.split(":").map(parseFloat);
  if (m.length===3) return m[0]*3600+m[1]*60+m[2];
  if (m.length===2) return m[0]*60+m[1];
  return parseFloat(s);
}
function plainToSentences(text) {
  return text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean)
    .map((ln,i)=>({start:i*3,end:i*3+3,text:ln}));
}

// File input handlers
const transcriptInput = document.getElementById("transcriptInput");
const audioInput      = document.getElementById("audioInput");
if (transcriptInput) transcriptInput.addEventListener("change", async ev => {
  const f=ev.target.files[0]; if(!f) return;
  const text=await f.text();
  sentences = text.includes("WEBVTT") ? parseVTT(text) : plainToSentences(text);
  renderTranscript();
  document.getElementById("podcastSection")?.classList.remove("hidden");
});
if (audioInput && audio) audioInput.addEventListener("change", ev => {
  const f=ev.target.files[0]; if(!f) return;
  audio.src=URL.createObjectURL(f);
});
if (transcriptContainer) {
  transcriptContainer.addEventListener("keydown", ev => {
    if (ev.key==="Enter"&&ev.target.classList.contains("word")) ev.target.click();
  });
}

// ── Episodes / Podcast ─────────────────────────────────────────────────────────
const episodeSelect = document.getElementById("episodeSelect");
async function loadEpisodes() {
  try {
    const resp = await fetch("data/podcast/episodes.json"); if(!resp.ok) return;
    episodes = await resp.json();
    if (episodeSelect) {
      episodeSelect.innerHTML = "";
      episodes.forEach(ep => {
        const opt=document.createElement("option"); opt.value=ep.id; opt.textContent=`${ep.id} — ${ep.title}`;
        episodeSelect.appendChild(opt);
      });
    }
    if (episodes.length>0) { if(episodeSelect) episodeSelect.value=episodes[0].id; await loadEpisode(episodes[0]); }
  } catch(e) { console.warn("episodes.json not available",e); }
}
async function loadEpisode(ep) {
  try {
    const audioPath = ep.audio ? "data/podcast/"+encodeURIComponent(ep.audio) : "";
    const txPath    = "data/podcast/"+encodeURIComponent(ep.transcript);
    if (audio) { if(audioPath) audio.src=audioPath; else audio.removeAttribute("src"); }
    const r=await fetch(txPath); if(!r.ok) return;
    const txt=await r.text();
    if (txt.includes("WEBVTT")) {
      sentences = parseVTT(txt);
    } else {
      const lines = txt.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
      let dur = lines.length*3;
      if (audioPath&&audio) {
        await new Promise(resolve => {
          if (audio.readyState>=1&&audio.duration&&!isNaN(audio.duration)) return resolve();
          audio.addEventListener("loadedmetadata",resolve,{once:true}); setTimeout(resolve,1500);
        });
        if (audio.duration&&!isNaN(audio.duration)&&audio.duration>0) dur=audio.duration;
      }
      const step=dur/Math.max(lines.length,1);
      sentences=lines.map((ln,i)=>({start:Math.round(i*step*100)/100,end:Math.round((i+1)*step*100)/100,text:ln}));
    }
    renderTranscript();
    document.getElementById("podcastSection")?.classList.remove("hidden");
    renderVocabList();
  } catch(e) { console.warn("loadEpisode error",e); }
}
document.getElementById("loadEpisodeBtn")?.addEventListener("click", () => {
  const id=episodeSelect?.value; const ep=episodes.find(e=>String(e.id)===String(id)); if(ep) loadEpisode(ep);
});
document.getElementById("loadSample")?.addEventListener("click", () => {
  sentences=[
    {start:0,   end:4,  text:"Hej, mit navn er Anna."},
    {start:4.1, end:9,  text:"Jeg bor i København og jeg lærer dansk hver dag."},
    {start:9.1, end:14, text:"Det er meget svært, men jeg nyder det virkelig."},
  ];
  renderTranscript(); renderVocabList();
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
  return a.title || (a.text||a.body||"").trimStart().split("\n")[0].replace(/^#+\s*/,"").slice(0,50) || "无标题";
}

function calcArticleStats(text) {
  const words = text.match(/\b[a-zA-ZæøåÆØÅ][a-zA-ZæøåÆØÅ'-]*\b/g)||[];
  let total=0, known=0, study=0, unknown=0, oov=0;
  const seenLemmas = new Set();
  words.forEach(w => {
    total++;
    const norm=w.toLowerCase();
    if (isOovNoise(norm)) return;
    const k=vocabSurfaceToKey[norm]||norm;
    const v=vocabIndex[k];
    if (!v) { if (!seenLemmas.has("oov:"+norm)){seenLemmas.add("oov:"+norm);oov++;} return; }
    const lk=getLemmaKey(k);
    if (seenLemmas.has(lk)) return;
    seenLemmas.add(lk);
    const level=getWebLevel(k);
    if (needsStudySet.has(lk)) study++;
    else if (level>=3) known++;
    else unknown++;
  });
  const coverage = seenLemmas.size > 0 ? Math.round(known/seenLemmas.size*100) : 0;
  return {total, unique:seenLemmas.size, known, study, unknown, oov, coverage};
}

function renderReadingFromText(text) {
  const preview = document.getElementById("readingPreview");
  if (!preview) return;
  preview.innerHTML = "";
  if (!text?.trim()) return;
  clearContentKeys();
  renderTokensInto(preview, text);
  scheduleOovSave();
}

function openArticle(article) {
  currentArticleId = article.id;
  document.getElementById("articleComposer")?.classList.add("hidden");
  document.getElementById("readingPlaceholder")?.classList.add("hidden");
  document.getElementById("readingViewer")?.classList.remove("hidden");
  const titleEl = document.getElementById("readingTitle");
  if (titleEl) titleEl.textContent = getArticleTitle(article);
  renderReadingFromText(article.text || article.body || "");
  const statsEl = document.getElementById("articleStats");
  if (statsEl) {
    const s = calcArticleStats(article.text||article.body||"");
    statsEl.innerHTML = `<span>${s.total} 字</span><span>${s.unique} 词</span><span>覆盖率 ${s.coverage}%</span><span>生词 ${s.unknown}</span><span>OOV ${s.oov}</span><span>需学 ${s.study}</span>`;
  }
  renderVocabList();
  renderArticleTree();
}

function renderArticleTree() {
  const list = document.getElementById("articleList"); if (!list) return;
  const q = (document.getElementById("articleSearch")?.value||"").toLowerCase();
  list.innerHTML = "";

  // Separate public (readonly) and personal articles
  const publicArticles  = articles.filter(a =>  a.readonly && (!q||getArticleTitle(a).toLowerCase().includes(q)));
  const privateArticles = articles.filter(a => !a.readonly && (!q||getArticleTitle(a).toLowerCase().includes(q)));

  function makeGroup(groupLabel, items) {
    if (!items.length) return;
    const gh = document.createElement("div"); gh.className="article-group-head"; gh.textContent=groupLabel;
    list.appendChild(gh);
    items.forEach(a => {
      const item = document.createElement("div");
      item.className = "article-item" + (a.id===currentArticleId?" active":"");
      const title = document.createElement("span");
      title.className="article-item-title"; title.textContent=getArticleTitle(a); title.title=getArticleTitle(a);
      title.addEventListener("click", ()=>openArticle(a));
      item.appendChild(title);
      if (!a.readonly) {
        const del = document.createElement("button");
        del.className="article-del-btn"; del.textContent="✕"; del.title="删除";
        del.addEventListener("click", ev => {
          ev.stopPropagation();
          if (!confirm(`删除"${getArticleTitle(a)}"？`)) return;
          articles = articles.filter(x=>x.id!==a.id); saveArticles();
          if (currentArticleId===a.id) {
            currentArticleId=null;
            document.getElementById("readingViewer")?.classList.add("hidden");
            document.getElementById("readingPlaceholder")?.classList.remove("hidden");
            clearContentKeys(); renderVocabList();
          }
          renderArticleTree();
        });
        item.appendChild(del);
      }
      list.appendChild(item);
    });
  }

  makeGroup("公开文章", publicArticles);
  makeGroup("我的文章", privateArticles);

  if (!publicArticles.length && !privateArticles.length)
    list.innerHTML = `<div style="color:#aaa;font-size:12px;padding:8px 10px">${q?"无匹配":"暂无文章"}</div>`;
  updateAuthUI();
}

document.getElementById("articleSearch")?.addEventListener("input", ()=>renderArticleTree());

document.getElementById("newArticleBtn")?.addEventListener("click", () => {
  // No edit mode required for composing/pasting
  document.getElementById("articleComposer")?.classList.remove("hidden");
  document.getElementById("readingViewer")?.classList.add("hidden");
  document.getElementById("readingPlaceholder")?.classList.add("hidden");
  const ti=document.getElementById("articleTitleInput"), ri=document.getElementById("readingInput");
  if (ti) ti.value=""; if (ri) { ri.value=""; ri.focus(); }
  clearContentKeys(); renderVocabList();
});

// Live preview as you type in the reading composer
let readingComposerTimer = null;
document.getElementById("readingInput")?.addEventListener("input", () => {
  clearTimeout(readingComposerTimer);
  readingComposerTimer = setTimeout(() => {
    const text = document.getElementById("readingInput")?.value||"";
    const preview = document.getElementById("readingPreview");
    const viewer  = document.getElementById("readingViewer");
    if (!text.trim()) return;
    if (preview && viewer) {
      viewer.classList.remove("hidden");
      document.getElementById("readingTitle").textContent = document.getElementById("articleTitleInput")?.value || "预览";
      document.getElementById("articleStats").textContent = "";
      preview.innerHTML=""; clearContentKeys();
      renderTokensInto(preview, text);
      renderVocabList();
    }
  }, 500);
});

document.getElementById("cancelCompose")?.addEventListener("click", () => {
  document.getElementById("articleComposer")?.classList.add("hidden");
  if (currentArticleId) { const a=articles.find(x=>x.id===currentArticleId); if(a){openArticle(a);return;} }
  document.getElementById("readingPlaceholder")?.classList.remove("hidden");
  document.getElementById("readingViewer")?.classList.add("hidden");
  clearContentKeys(); renderVocabList();
});

document.getElementById("saveArticle")?.addEventListener("click", () => {
  const text = document.getElementById("readingInput")?.value||"";
  if (!text.trim()) { alert("请输入文章内容"); return; }
  const title = document.getElementById("articleTitleInput")?.value?.trim()||"";
  const article = {id:genId(), title, text, savedAt:Date.now()};
  articles.unshift(article); saveArticles();
  document.getElementById("articleComposer")?.classList.add("hidden");
  openArticle(article);
});

document.getElementById("clearArticle")?.addEventListener("click", () => {
  const ri=document.getElementById("readingInput"); if(ri) ri.value="";
  const preview=document.getElementById("readingPreview"); if(preview) preview.innerHTML="";
  clearContentKeys(); renderVocabList();
});

// Import/export local articles
document.getElementById("exportArticlesBtn")?.addEventListener("click", () => {
  const today=new Date().toISOString().slice(0,10);
  const personal=articles.filter(a=>!a.readonly);
  downloadBlob(JSON.stringify(personal,null,2), `articles_backup_${today}.json`, "application/json");
});
document.getElementById("importArticlesBtn")?.addEventListener("click", ()=>document.getElementById("importArticlesFile")?.click());
document.getElementById("importArticlesFile")?.addEventListener("change", async ev => {
  const f=ev.target.files[0]; if(!f) return;
  try {
    const data=JSON.parse(await f.text());
    if (!Array.isArray(data)) { alert("格式错误"); return; }
    if (!confirm(`导入 ${data.length} 篇文章？`)) return;
    const existingIds=new Set(articles.map(a=>a.id));
    data.forEach(a=>{ if(!existingIds.has(a.id)) articles.push(a); });
    saveArticles(); renderArticleTree(); alert(`已导入 ${data.length} 篇`);
  } catch(e) { alert("导入失败: "+e.message); }
  ev.target.value="";
});

// Load static reading articles from data/reading/index.json
async function loadReadingIndex() {
  try {
    const resp=await fetch("data/reading/index.json"); if(!resp.ok) return;
    const index=await resp.json();
    for (const entry of index) {
      if (articles.some(a=>a.filename===entry.filename)) continue;
      try {
        const r=await fetch("data/reading/"+encodeURIComponent(entry.filename)); if(!r.ok) continue;
        const text=await r.text();
        articles.push({id:"file:"+entry.filename, title:entry.title||entry.filename,
          text, savedAt:0, readonly:true, filename:entry.filename});
      } catch(e){}
    }
    renderArticleTree();
  } catch(e){}
}

// ── Diary ──────────────────────────────────────────────────────────────────────
function loadDiary() {
  try { const r=localStorage.getItem(SK_DIARY); diaryEntries=r?JSON.parse(r):[]; } catch(e){diaryEntries=[];}
}
function saveDiary() { try { localStorage.setItem(SK_DIARY, JSON.stringify(diaryEntries)); } catch(e){} }
function todayDate() { return new Date().toISOString().slice(0,10); }
function getDiaryTitle(e) { return e.title||e.date||"日记"; }

function renderDiaryList() {
  const list=document.getElementById("diaryEntryList"); if(!list) return;
  const q=(document.getElementById("diarySearch")?.value||"").toLowerCase();
  list.innerHTML="";
  const filtered=diaryEntries.filter(e=>!q||getDiaryTitle(e).toLowerCase().includes(q)||(e.body||"").toLowerCase().includes(q));
  if (!filtered.length) {
    list.innerHTML=`<div style="color:#aaa;font-size:12px;padding:8px 10px">${q?"无匹配":"暂无日记"}</div>`; return;
  }
  filtered.forEach(e => {
    const item=document.createElement("div");
    item.className="diary-entry-item"+(e.id===currentDiaryId?" active":"");
    const dateEl=document.createElement("div"); dateEl.className="diary-entry-date"; dateEl.textContent=e.date;
    const titleEl=document.createElement("div"); titleEl.className="diary-entry-title"; titleEl.textContent=getDiaryTitle(e);
    item.appendChild(dateEl); item.appendChild(titleEl);
    item.addEventListener("click",()=>openDiaryEntry(e));
    list.appendChild(item);
  });
}

function openDiaryEntry(entry) {
  currentDiaryId=entry.id;
  document.getElementById("diaryPlaceholder")?.classList.add("hidden");
  document.getElementById("diaryEditor")?.classList.remove("hidden");
  const dateEl=document.getElementById("diaryDate"), titleEl=document.getElementById("diaryTitle");
  const bodyEl=document.getElementById("diaryBody"), delBtn=document.getElementById("deleteDiaryBtn");
  if(dateEl)  dateEl.value=entry.date||"";
  if(titleEl) titleEl.value=entry.title||"";
  if(bodyEl)  bodyEl.value=entry.body||"";
  if(delBtn)  delBtn.classList.remove("hidden");
  renderDiaryPreview(); renderDiaryList();
  clearContentKeys();
  const preview=document.getElementById("diaryPreview");
  if(preview){ preview.innerHTML=""; renderTokensInto(preview,entry.body||""); }
  renderVocabList(); updateDiaryWordStats();
}

function newDiaryEntry() {
  currentDiaryId=null;
  document.getElementById("diaryPlaceholder")?.classList.add("hidden");
  document.getElementById("diaryEditor")?.classList.remove("hidden");
  const dateEl=document.getElementById("diaryDate"), titleEl=document.getElementById("diaryTitle");
  const bodyEl=document.getElementById("diaryBody"), delBtn=document.getElementById("deleteDiaryBtn");
  if(dateEl)  dateEl.value=todayDate();
  if(titleEl) titleEl.value="";
  if(bodyEl)  { bodyEl.value=""; bodyEl.focus(); }
  if(delBtn)  delBtn.classList.add("hidden");
  const preview=document.getElementById("diaryPreview"); if(preview) preview.innerHTML="";
  clearContentKeys(); renderVocabList();
}

let diaryPreviewTimer=null;
function renderDiaryPreview() {
  const bodyEl=document.getElementById("diaryBody"), preview=document.getElementById("diaryPreview");
  if(!preview||!bodyEl) return;
  preview.innerHTML=""; clearContentKeys();
  if(bodyEl.value.trim()) renderTokensInto(preview,bodyEl.value);
  renderVocabList(); updateDiaryWordStats();
}
function updateDiaryWordStats() {
  const statsEl=document.getElementById("diaryWordStats"); if(!statsEl) return;
  const body=document.getElementById("diaryBody")?.value||"";
  if(!body.trim()){ statsEl.textContent=""; return; }
  const s=calcArticleStats(body);
  statsEl.textContent=`${s.total} 字 · 覆盖率 ${s.coverage}% · 生词 ${s.unknown} · OOV ${s.oov}`;
}
document.getElementById("diaryBody")?.addEventListener("input",()=>{ clearTimeout(diaryPreviewTimer); diaryPreviewTimer=setTimeout(renderDiaryPreview,350); });
document.getElementById("newDiaryBtn")   ?.addEventListener("click", newDiaryEntry);
document.getElementById("diarySearch")  ?.addEventListener("input", ()=>renderDiaryList());
document.getElementById("cancelDiaryBtn")?.addEventListener("click", ()=>{
  if(currentDiaryId){ const e=diaryEntries.find(x=>x.id===currentDiaryId); if(e){openDiaryEntry(e);return;} }
  document.getElementById("diaryEditor")?.classList.add("hidden");
  document.getElementById("diaryPlaceholder")?.classList.remove("hidden");
  currentDiaryId=null; clearContentKeys(); renderVocabList();
});
document.getElementById("saveDiaryBtn")?.addEventListener("click", ()=>{
  const dateVal=document.getElementById("diaryDate")?.value||"";
  const titleVal=document.getElementById("diaryTitle")?.value?.trim()||"";
  const bodyVal=document.getElementById("diaryBody")?.value||"";
  if(!bodyVal.trim()){ alert("请输入内容"); return; }
  const now=new Date().toISOString();
  if(currentDiaryId){
    const idx=diaryEntries.findIndex(x=>x.id===currentDiaryId);
    if(idx>=0) diaryEntries[idx]={...diaryEntries[idx],date:dateVal,title:titleVal,body:bodyVal,updatedAt:now};
  } else {
    const entry={id:genId(),date:dateVal,title:titleVal,body:bodyVal,tags:[],createdAt:now,updatedAt:now};
    currentDiaryId=entry.id; diaryEntries.unshift(entry);
    document.getElementById("deleteDiaryBtn")?.classList.remove("hidden");
  }
  saveDiary(); renderDiaryList(); alert("已保存");
});
document.getElementById("deleteDiaryBtn")?.addEventListener("click", ()=>{
  if(!currentDiaryId) return;
  const e=diaryEntries.find(x=>x.id===currentDiaryId);
  if(!confirm(`删除日记"${getDiaryTitle(e||{})}"？`)) return;
  diaryEntries=diaryEntries.filter(x=>x.id!==currentDiaryId); saveDiary();
  currentDiaryId=null;
  document.getElementById("diaryEditor")?.classList.add("hidden");
  document.getElementById("diaryPlaceholder")?.classList.remove("hidden");
  clearContentKeys(); renderVocabList(); renderDiaryList();
});
document.getElementById("exportDiaryBtn")?.addEventListener("click", ()=>{
  const today=new Date().toISOString().slice(0,10);
  downloadBlob(JSON.stringify(diaryEntries,null,2),`diary_backup_${today}.json`,"application/json");
});
document.getElementById("importDiaryBtn")?.addEventListener("click",()=>document.getElementById("importDiaryFile")?.click());
document.getElementById("importDiaryFile")?.addEventListener("change", async ev=>{
  const f=ev.target.files[0]; if(!f) return;
  try {
    const data=JSON.parse(await f.text());
    if(!Array.isArray(data)){alert("格式错误");return;}
    if(!confirm(`导入 ${data.length} 条日记（将与现有日记合并）？`)) return;
    const existingIds=new Set(diaryEntries.map(e=>e.id));
    data.forEach(e=>{if(!existingIds.has(e.id)) diaryEntries.push(e);});
    diaryEntries.sort((a,b)=>b.date?.localeCompare(a.date||"")||0);
    saveDiary(); renderDiaryList(); alert(`已导入 ${data.length} 条`);
  } catch(e){alert("导入失败: "+e.message);}
  ev.target.value="";
});
document.getElementById("copyPromptBtn")?.addEventListener("click", ()=>{
  const body=document.getElementById("diaryBody")?.value||"";
  const prompt=`请帮我修改我的丹麦语日记。保留我的意思，用中文解释语法错误，并给出自然的丹麦语版本。\n\n${body}`;
  const btn=document.getElementById("copyPromptBtn");
  navigator.clipboard?.writeText(prompt).then(()=>{
    if(btn){btn.textContent="已复制！";setTimeout(()=>btn.textContent="复制纠错提示",2000);}
  }).catch(()=>{
    const ta=document.createElement("textarea");ta.value=prompt;document.body.appendChild(ta);ta.select();document.execCommand("copy");document.body.removeChild(ta);
    if(btn){btn.textContent="已复制！";setTimeout(()=>btn.textContent="复制纠错提示",2000);}
  });
});

// ── Header stats ───────────────────────────────────────────────────────────────
function updateHeaderStats() {
  const el=document.getElementById("headerStats"); if(!el) return;
  const total=Object.keys(vocabIndex).length;
  const lemmas=new Set(Object.values(vocabIndex).map(v=>(v.lemma||"").toLowerCase()));
  const known=[...lemmas].filter(lk=>getWebLevel(vocabSurfaceToKey[lk]||lk)>=4).length;
  const study=needsStudySet.size;
  const oovTotal=Object.keys(oovCache).filter(s=>!oovCache[s]?.isProper).length;
  el.innerHTML=`<span class="header-stat">词库 <strong>${total}</strong></span>
    <span class="header-stat">已掌握 <strong>${known}</strong></span>
    <span class="header-stat">需学 <strong>${study}</strong></span>
    <span class="header-stat">OOV <strong>${oovTotal}</strong></span>`;
}

// ── Tab switching ──────────────────────────────────────────────────────────────
function showTab(name) {
  currentTab = name;
  const tabs = { podcast:"podcastSection", reading:"readingSection", diary:"diarySection", vocab:"vocabBrowserSection" };
  ["tabPodcast","tabReading","tabDiary","tabVocab"].forEach(id=>document.getElementById(id)?.classList.remove("active"));
  document.getElementById("tab"+name.charAt(0).toUpperCase()+name.slice(1))?.classList.add("active");
  Object.values(tabs).forEach(id=>document.getElementById(id)?.classList.add("hidden"));
  const vp=document.getElementById("vocabPanel");
  if (vp) vp.style.display=(name==="vocab")?"none":"";
  document.getElementById(tabs[name])?.classList.remove("hidden");

  clearContentKeys();
  if (name==="podcast") {
    document.querySelectorAll("#transcriptContainer .word").forEach(el=>{
      const s=(el.dataset.surface||"").toLowerCase();
      const k=vocabSurfaceToKey[s]||s;
      if (vocabIndex[k]) { contentWordKeys.add(k); contentWordFreq.set(k,(contentWordFreq.get(k)||0)+1); }
      else if (el.dataset.oov) { contentOovKeys.add(s); contentOovFreq.set(s,(contentOovFreq.get(s)||0)+1); }
    });
  } else if (name==="reading" && currentArticleId) {
    const a=articles.find(x=>x.id===currentArticleId);
    if (a) renderReadingFromText(a.text||a.body||"");
  } else if (name==="diary" && currentDiaryId) {
    const e=diaryEntries.find(x=>x.id===currentDiaryId);
    if (e) {
      const preview=document.getElementById("diaryPreview");
      if(preview){preview.innerHTML="";renderTokensInto(preview,e.body||"");}
    }
  }
  renderVocabList();
  if (name==="vocab") renderVocabBrowser();
  updateHeaderStats();
}
document.getElementById("tabPodcast")?.addEventListener("click",()=>showTab("podcast"));
document.getElementById("tabReading")?.addEventListener("click",()=>showTab("reading"));
document.getElementById("tabDiary")  ?.addEventListener("click",()=>showTab("diary"));
document.getElementById("tabVocab")  ?.addEventListener("click",()=>showTab("vocab"));

// ── Button handlers ────────────────────────────────────────────────────────────
document.getElementById("editModeBtn")        ?.addEventListener("click", handleEditModeBtn);
document.getElementById("exportAnkiBtn")      ?.addEventListener("click", exportAnkiTSV);
document.getElementById("exportWebActionsBtn")?.addEventListener("click", exportWebActions);
document.getElementById("exportOovBtn")       ?.addEventListener("click", exportOovCache);
document.getElementById("exportOovChatGPTBtn")?.addEventListener("click", exportOovForChatGPT);
document.getElementById("resetStateBtn")      ?.addEventListener("click", resetVisualState);
document.getElementById("clearOovBtn")        ?.addEventListener("click", clearOovCache);

// Legacy flagged panel
const flaggedPanelEl = document.getElementById("flaggedPanel");
document.getElementById("showFlagged")?.addEventListener("click", ()=>{
  if(flaggedPanelEl){flaggedPanelEl.classList.toggle("hidden");if(!flaggedPanelEl.classList.contains("hidden")) renderFlaggedPanel();}
});
function renderFlaggedPanel() {
  if(!flaggedPanelEl) return;
  flaggedPanelEl.innerHTML="";
  const items=(flaggedEntries||[]).filter(e=>!flaggedReviewedSet.has(`${e.source_file}:${e.source_line}`));
  if(!items.length){flaggedPanelEl.innerHTML="<div style='padding:8px;font-size:12px'>无待复核条目</div>";return;}
  items.slice(0,100).forEach(e=>{
    const div=document.createElement("div");
    div.style.cssText="padding:6px;border-bottom:1px solid #eee;font-size:12px";
    div.innerHTML=`<b>${escH(e.lemma||"?")}</b> rank:${e.rank} — ${escH(e.source_file)}:${e.source_line}`;
    const btn=document.createElement("button");btn.className="btn btn-sm";btn.textContent="已复核";
    btn.addEventListener("click",()=>{ flaggedReviewedSet.add(`${e.source_file}:${e.source_line}`); saveFlags();renderFlaggedPanel(); });
    div.appendChild(btn);flaggedPanelEl.appendChild(div);
  });
}

// ── Remote data loading ────────────────────────────────────────────────────────
async function loadRemoteIndex() {
  // 1. Load vocab_index.json
  try {
    const resp=await fetch("vocab_index.json"); if(resp.ok) {
      const raw=await resp.json(); vocabIndex=raw||{};
      Object.values(vocabIndex).forEach(v=>{v.rank=v.rank||999999;});
      vocabSurfaceToKey={};
      Object.entries(vocabIndex).forEach(([k,v])=>{
        try { vocabSurfaceToKey[String(k).toLowerCase()]=k; if(v?.lemma) vocabSurfaceToKey[String(v.lemma).toLowerCase()]=k; } catch(e){}
      });
      renderVocabList();
      const syncEl=document.getElementById("syncStatus");
      if(syncEl) syncEl.textContent=`${Object.keys(vocabIndex).length} 词`;
    }
  } catch(e){ console.warn("vocab_index.json not available",e); }

  // 2. Load vocab_detail.json
  try { const resp=await fetch("vocab_detail.json"); if(resp.ok) vocabDetail=(await resp.json())||{}; }
  catch(e){ console.warn("vocab_detail.json not available",e); }

  // 3. Load extra_vocab.json
  try {
    const resp=await fetch("extra_vocab.json"); if(resp.ok) {
      const raw=await resp.json();
      // Merge: file takes precedence over browser-local, but don't overwrite manual local edits
      Object.entries(raw||{}).forEach(([k,v])=>{
        if(!extraVocab[k] || extraVocab[k].status !== "manual") extraVocab[k]=v;
      });
    }
  } catch(e){ console.warn("extra_vocab.json not available (will create on export)",e); }

  // 4. Load oov_ignore.json
  try {
    const resp=await fetch("oov_ignore.json"); if(resp.ok) {
      const list=await resp.json();
      if(Array.isArray(list)) list.forEach(w=>oovIgnoreSet.add(w.toLowerCase()));
    }
  } catch(e){}

  // 5. Load user_mastery.json
  try {
    const r2=await fetch("user_mastery.json"); if(r2.ok) {
      const remote=await r2.json();
      Object.entries(remote).forEach(([k,v])=>{
        if(typeof v==="boolean"&&!v) return;
        if(!/^[a-zA-ZæøåÆØÅ\s''\-]+$/.test(k)) return;
        const kl=k.toLowerCase();
        if(typeof v==="boolean"||(typeof v==="object"&&(v.level||v.interval||v.reps))){
          userMastery[kl]=v;
        }
      });
      saveMastery();
      // Find snapshot date
      const dates=Object.values(userMastery).filter(v=>v?.updated_at).map(v=>v.updated_at).sort();
      if(dates.length) {
        ankiSnapshotDate = dates[dates.length-1].slice(0,10);
        const syncEl=document.getElementById("syncStatus");
        if(syncEl) syncEl.textContent+= ` · Anki快照 ${ankiSnapshotDate}`;
      }
      document.querySelectorAll(".word").forEach(el=>{
        const s=(el.dataset.surface||"").toLowerCase(), k=vocabSurfaceToKey[s]||s; applyWordClass(el,k);
      });
      renderVocabList(); updateHeaderStats();
    }
  } catch(e){ console.warn("user_mastery.json not available",e); }

  // 6. Load flagged_entries.json
  try { const r=await fetch("flagged_entries.json"); if(r.ok) flaggedEntries=await r.json(); } catch(e){}
}

// ── Init ───────────────────────────────────────────────────────────────────────
loadPersistence();
loadArticlesFromStorage();
loadDiary();
updateAuthUI();
showTab("podcast");
loadRemoteIndex();
loadEpisodes();
loadReadingIndex().then(()=>renderArticleTree());
renderDiaryList();
updateHeaderStats();

// Debug handle
window._app = {
  vocabIndex, vocabSurfaceToKey, userMastery, vocabDetail, extraVocab, oovCache,
  needsStudySet, webActions, articles, diaryEntries,
};
