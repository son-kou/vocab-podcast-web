/* Minimal client-side prototype for transcript-sync + vocab hover + Anki export */

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
// Tabs & Reading UI elements
const tabPodcast = document.getElementById("tabPodcast");
const tabReading = document.getElementById("tabReading");
const readingInput = document.getElementById("readingInput");
const readingPreview = document.getElementById("readingPreview");
const saveArticleBtn = document.getElementById("saveArticle");
const clearArticleBtn = document.getElementById("clearArticle");
const savedArticlesEl = document.getElementById("savedArticles");

// local saved articles key
const STORAGE_KEY_SAVED_ARTICLES = "vocab_podcast_saved_articles_v1";

let sentences = [];
let vocabIndex = {}; // lemma -> {lemma, zh, en, rank, known:false}
let vocabSurfaceToKey = {}; // normalized surface form or lemma -> key in vocabIndex
let userMastery = {}; // lemma -> known boolean
let flaggedEntries = [];
let selectedSet = new Set();

const STORAGE_KEY_MASTERY = "vocab_podcast_mastery_v1";
const STORAGE_KEY_FLAGGED_REVIEWED = "vocab_podcast_flagged_reviewed_v1";
let flaggedReviewedSet = new Set();

function loadPersistence() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_MASTERY);
    if (raw) userMastery = JSON.parse(raw);
  } catch (e) {
    console.warn("failed to load mastery", e);
  }
  try {
    const raw2 = localStorage.getItem(STORAGE_KEY_FLAGGED_REVIEWED);
    if (raw2) {
      JSON.parse(raw2).forEach((k) => flaggedReviewedSet.add(k));
    }
  } catch (e) {
    console.warn("failed to load flagged reviewed", e);
  }
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

function makeWordSpan(word) {
  const span = document.createElement("span");
  span.className = "word";
  span.textContent = word;
  span.addEventListener("mouseenter", onWordHover);
  span.addEventListener("mouseleave", onWordLeave);
  span.addEventListener("click", onWordClick);
  span.dataset.surface = word;
  // reflect persisted mastery state if present
  try {
    const key = vocabSurfaceToKey[word] || word;
    const st = userMastery[key];
    if (st === true) span.classList.add("known");
    else if (st === false) span.classList.add("unknown");
  } catch (e) {}
  return span;
}

function onWordHover(ev) {
  const text = (
    ev.target.dataset.surface ||
    ev.target.textContent ||
    ""
  ).toLowerCase();
  const rect = ev.target.getBoundingClientRect();
  const card = document.getElementById("hoverCard") || createHoverCard();
  const key = vocabSurfaceToKey[text];
  const info = key ? vocabIndex[key] : null;
  if (info) {
    card.innerHTML = `<b>${info.lemma}</b><div>${info.zh || ""}</div><div style="color:#5f6b7a">${info.en || ""}</div>`;
  } else {
    card.innerHTML = `<b>${text}</b><div>未在词表中</div>`;
  }
  card.style.left = rect.right + 6 + "px";
  card.style.top = rect.top + "px";
  card.style.display = "block";
}
function createHoverCard() {
  const card = document.createElement("div");
  card.id = "hoverCard";
  card.className = "hoverCard";
  document.body.appendChild(card);
  return card;
}
function onWordLeave() {
  const card = document.getElementById("hoverCard");
  if (card) card.style.display = "none";
}
function onWordClick(ev) {
  const text = (
    ev.target.dataset.surface ||
    ev.target.textContent ||
    ""
  ).toLowerCase();
  const key = vocabSurfaceToKey[text] || text;
  userMastery[key] = !userMastery[key];
  ev.target.classList.toggle("known", !!userMastery[key]);
  ev.target.classList.toggle("unknown", !userMastery[key]);
  renderVocabList();
  savePersistence();
}

function renderTranscript() {
  transcriptContainer.innerHTML = "";
  sentences.forEach((s, i) => {
    const node = sentenceTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.start = s.start;
    node.dataset.end = s.end;
    const textSpan = node.querySelector(".text");
    // split words and wrap spans
    const parts = s.text.replace(/\r?\n/g, " ").split(/(\s+)/);
    parts.forEach((p) => {
      if (/\s+/.test(p)) textSpan.appendChild(document.createTextNode(p));
      else {
        const norm = p.replace(/[.,!?;:()"“”]/g, "").toLowerCase();
        textSpan.appendChild(makeWordSpan(norm));
      }
    });
    // click sentence: if TTS enabled or no audio, speak; else seek audio
    node.addEventListener("click", () => {
      const useTTS = document.getElementById("useTTS");
      const useTTSChecked = useTTS && useTTS.checked;
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
    const s = sentences[i];
    transcriptContainer
      .querySelectorAll(".sentence")
      .forEach((n) => n.classList.remove("active"));
    const node = transcriptContainer.querySelectorAll(".sentence")[i];
    if (node) {
      node.classList.add("active");
      node.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    await speakText(s.text);
    if (!ttsAutoPlaying) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  ttsAutoPlaying = false;
  const ttsAuto = document.getElementById("ttsAuto");
  if (ttsAuto) ttsAuto.checked = false;
}

function stopTTSAuto() {
  ttsAutoPlaying = false;
  try {
    speechSynthesis.cancel();
  } catch (e) {}
}

function speakCurrentSentence() {
  const active =
    transcriptContainer.querySelector(".sentence.active") ||
    transcriptContainer.querySelector(".sentence");
  if (!active) return;
  const idx = Array.from(
    transcriptContainer.querySelectorAll(".sentence"),
  ).indexOf(active);
  const s = sentences[idx];
  if (s) speakText(s.text);
}

if (ttsSpeakBtn) ttsSpeakBtn.addEventListener("click", speakCurrentSentence);
if (ttsAutoCheckbox)
  ttsAutoCheckbox.addEventListener("change", (e) => {
    if (e.target.checked) startTTSAuto();
    else stopTTSAuto();
  });

function loadSampleData() {
  // sample: two sentences with start/end
  sentences = [
    { start: 0.0, end: 4.0, text: "Hej, mit navn er Anna." },
    {
      start: 4.1,
      end: 9.0,
      text: "Jeg bor i København og jeg lærer dansk hver dag.",
    },
  ];
  // load a tiny sample vocab index
  vocabIndex = {
    hej: { lemma: "hej", zh: "嗨/你好", en: "hi", rank: 100 },
    navn: { lemma: "navn", zh: "名字", en: "name", rank: 500 },
    jeg: { lemma: "jeg", zh: "我", en: "I", rank: 1 },
    bor: { lemma: "bo", zh: "居住", en: "live", rank: 1200 },
    københavn: {
      lemma: "København",
      zh: "哥本哈根",
      en: "Copenhagen",
      rank: 2000,
    },
    lærer: { lemma: "lære", zh: "学习/教", en: "learn/teach", rank: 800 },
  };
  userMastery = {};
  document.getElementById("audio").src = "";
  playerSection.classList.remove("hidden");
  renderTranscript();
  renderVocabList();
}

function renderVocabList() {
  vocabList.innerHTML = "";
  // Deduplicate by lemma for display: prefer lowest rank entry per lemma
  const entries = Object.keys(vocabIndex).map((k) => {
    const v = vocabIndex[k] || {};
    return {
      key: k,
      lemma: (v.lemma || k).toString(),
      rank: v.rank || 1000000,
    };
  });
  entries.sort((a, b) => a.rank - b.rank);
  const seen = new Set();
  const unique = [];
  entries.forEach((e) => {
    const lk = e.lemma.toLowerCase();
    if (!seen.has(lk)) {
      seen.add(lk);
      unique.push(e);
    }
  });
  unique.forEach((e) => {
    const l = e.key;
    const chip = document.createElement("div");
    chip.className = "vocabChip";
    if (userMastery[l]) chip.classList.add("known");
    if (selectedSet.has(l)) chip.classList.add("selected");
    const textSpan = document.createElement("span");
    textSpan.textContent = `${vocabIndex[l].lemma} — ${vocabIndex[l].zh || ""}`;
    textSpan.style.marginRight = "8px";
    const selBtn = document.createElement("button");
    selBtn.textContent = selectedSet.has(l) ? "Selected" : "Select";
    selBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (selectedSet.has(l)) selectedSet.delete(l);
      else selectedSet.add(l);
      renderVocabList();
    });
    chip.appendChild(textSpan);
    chip.appendChild(selBtn);
    chip.addEventListener("click", () => {
      userMastery[l] = !userMastery[l];
      renderVocabList();
      savePersistence();
    });
    vocabList.appendChild(chip);
  });
  vocabStats.textContent = `${unique.length} vocab loaded`;
}

function exportAnkiTSV() {
  // very small TSV: Front (lemma), Back (zh + en), Tags (known/unknown)
  const rows = [];
  const keys = selectedSet.size
    ? Array.from(selectedSet)
    : Object.keys(vocabIndex);
  keys.forEach((k) => {
    const v = vocabIndex[k];
    if (!v) return;
    const known = !!userMastery[k];
    const front = v.lemma;
    const back = `${v.zh || ""} — ${v.en || ""}`;
    const tags = known ? "known" : "unknown";
    rows.push([front, back, tags].join("\t"));
  });
  const blob = new Blob([rows.join("\n")], {
    type: "text/tab-separated-values",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "vocab_anki_export.tsv";
  a.click();
}

loadSample.addEventListener("click", loadSampleData);
exportAnki.addEventListener("click", exportAnkiTSV);
const exportSelectedFullBtn = document.getElementById("exportSelectedFull");
if (exportSelectedFullBtn) {
  exportSelectedFullBtn.addEventListener("click", () => {
    if (selectedSet.size === 0) {
      alert(
        'No selected lemmas. Click "Select" on chips to choose words to export.',
      );
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

speed.addEventListener("change", () => {
  audio.playbackRate = parseFloat(speed.value);
});

audio.addEventListener("timeupdate", () => {
  const t = audio.currentTime;
  // find active sentence
  let active = null;
  for (const node of transcriptContainer.querySelectorAll(".sentence")) {
    const s = parseFloat(node.dataset.start),
      e = parseFloat(node.dataset.end);
    if (t >= s && t <= e) {
      active = node;
      break;
    }
  }
  transcriptContainer
    .querySelectorAll(".sentence")
    .forEach((n) => n.classList.remove("active"));
  if (active) {
    active.classList.add("active");
    // scroll into view
    active.scrollIntoView({ behavior: "smooth", block: "center" });
  }
});

// basic file loaders (audio + transcript text - naive)
transcriptInput.addEventListener("change", async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  const text = await f.text();
  // try WebVTT cues -> sentences, else split lines
  if (text.includes("WEBVTT")) {
    sentences = parseVTT(text);
  } else {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    let start = 0;
    sentences = lines.map((ln, i) => ({
      start: start + i * 3,
      end: start + i * 3 + 3,
      text: ln,
    }));
  }
  renderTranscript();
  playerSection.classList.remove("hidden");
});

audioInput.addEventListener("change", (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  audio.src = url;
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
      const end = vttTimeToSec(parts[1].trim());
      i += 1;
      let txt = "";
      while (i < lines.length && lines[i].trim()) {
        txt += lines[i] + "\n";
        i++;
      }
      cues.push({ start, end, text: txt.trim() });
    } else {
      i++;
    }
  }
  return cues;
}
function vttTimeToSec(s) {
  const m = s.split(":").map(parseFloat);
  if (m.length === 3) return m[0] * 3600 + m[1] * 60 + m[2];
  if (m.length === 2) return m[0] * 60 + m[1];
  return parseFloat(s);
}

// accessibility: allow keyboard toggle of word known/unknown
transcriptContainer.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter" && ev.target.classList.contains("word")) {
    ev.target.click();
  }
});

// expose small debug helper
// attempt to load vocab_index.json and flagged_entries.json if present
async function loadRemoteIndex() {
  try {
    const resp = await fetch("vocab_index.json");
    if (resp.ok) {
      const raw = await resp.json();
      vocabIndex = raw || {};
      Object.values(vocabIndex).forEach((v) => {
        v.rank = v.rank || 1000000;
      });
      // build surface->key mapping for quick lookup (surface forms and lemma)
      vocabSurfaceToKey = {};
      Object.entries(vocabIndex).forEach(([k, v]) => {
        try {
          vocabSurfaceToKey[String(k).toLowerCase()] = k;
          if (v && v.lemma)
            vocabSurfaceToKey[String(v.lemma).toLowerCase()] = k;
        } catch (e) {}
      });
      renderVocabList();
      vocabStats.textContent = `${Object.keys(vocabIndex).length} vocab loaded (index)`;
    }
  } catch (e) {
    console.warn("vocab_index.json not available", e);
  }
  // try to load server-provided user_mastery.json and merge with localStorage
  try {
    const r2 = await fetch("user_mastery.json");
    if (r2.ok) {
      const remote = await r2.json();
      // merge remote into userMastery (remote wins)
      Object.entries(remote).forEach(([k, v]) => {
        try {
          userMastery[k.toLowerCase()] = !!v;
        } catch (e) {}
      });
      savePersistence();
      // re-render UI reflecting new mastery
      renderVocabList();
      // update transcript spans classes
      document.querySelectorAll(".word").forEach((el) => {
        try {
          const s = (el.dataset.surface || el.textContent || "").toLowerCase();
          const key = vocabSurfaceToKey[s] || s;
          el.classList.toggle("known", !!userMastery[key]);
          el.classList.toggle("unknown", userMastery[key] === false);
        } catch (e) {}
      });
    }
  } catch (e) {
    // silent
  }
  try {
    const r = await fetch("flagged_entries.json");
    if (r.ok) {
      flaggedEntries = await r.json();
      console.log("flagged entries", flaggedEntries.length);
    }
  } catch (e) {
    console.warn("flagged_entries.json not available", e);
  }
}

loadRemoteIndex();

// flagged entries UI
const showFlaggedBtn = document.getElementById("showFlagged");
const flaggedPanelEl = document.getElementById("flaggedPanel");
function renderFlaggedPanel() {
  if (!flaggedPanelEl) return;
  flaggedPanelEl.innerHTML = "";
  const items = (flaggedEntries || []).filter((e) => {
    const key = `${e.source_file}:${e.source_line}`;
    return !flaggedReviewedSet.has(key);
  });
  if (items.length === 0) {
    flaggedPanelEl.innerHTML = "<div>没有未处理的待复核条目。</div>";
    return;
  }
  const exportBtn = document.createElement("button");
  exportBtn.textContent = "Export flagged as JSON";
  exportBtn.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(items, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "flagged_entries.json";
    a.click();
  });
  flaggedPanelEl.appendChild(exportBtn);
  items.slice(0, 200).forEach((e) => {
    const div = document.createElement("div");
    div.style.borderBottom = "1px solid #eee";
    div.style.padding = "6px";
    const title = document.createElement("div");
    title.innerHTML = `<b>${e.lemma || "UNKNOWN"}</b> — rank:${e.rank} — ${e.source_file}:${e.source_line}`;
    const notes = document.createElement("div");
    notes.style.color = "#5f6b7a";
    notes.textContent = `notes: ${Array.isArray(e.notes) ? e.notes.join(", ") : ""}`;
    const btn = document.createElement("button");
    btn.textContent = "Mark reviewed";
    btn.addEventListener("click", () => {
      const key = `${e.source_file}:${e.source_line}`;
      flaggedReviewedSet.add(key);
      savePersistence();
      renderFlaggedPanel();
    });
    div.appendChild(title);
    div.appendChild(notes);
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

window._vocabIndex = vocabIndex;
window._userMastery = userMastery;

// episodes loader
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
    // auto-select episode 108 if present
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
    // set audio src (if present)
    if (audioPath) audio.src = audioPath;
    else audio.removeAttribute("src");
    // fetch transcript
    let txt = "";
    try {
      const r = await fetch(transcriptPath);
      if (r.ok) txt = await r.text();
    } catch (e) {
      console.warn("transcript fetch failed", e);
    }
    if (txt) {
      if (txt.includes("WEBVTT")) {
        sentences = parseVTT(txt);
      } else {
        const lines = txt
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        // try to use audio duration; wait for metadata if audio present
        let dur = lines.length * 3;
        if (audioPath) {
          await new Promise((resolve) => {
            if (
              audio.readyState >= 1 &&
              audio.duration &&
              !isNaN(audio.duration)
            )
              return resolve();
            const onMeta = () => resolve();
            audio.addEventListener("loadedmetadata", onMeta, { once: true });
            // fallback timeout
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

// --- Reading tab: render pasted text with vocab hover and simple controls ---
let readingRenderDebounce = null;
function renderReadingFromText(text) {
  const container = readingPreview;
  if (!container) return;
  container.innerHTML = "";
  if (!text || !text.trim()) return;
  const paragraphs = String(text)
    .split(/\n\s*\n/)
    .filter(Boolean);
  paragraphs.forEach((p) => {
    const para = document.createElement("div");
    para.className = "sentence";
    const textSpan = document.createElement("span");
    textSpan.className = "text";
    const parts = p.replace(/\r?\n/g, " ").split(/(\s+)/);
    parts.forEach((t) => {
      if (/\s+/.test(t)) textSpan.appendChild(document.createTextNode(t));
      else {
        const norm = t.replace(/[.,!?;:()"“”]/g, "").toLowerCase();
        textSpan.appendChild(makeWordSpan(norm));
      }
    });
    para.appendChild(textSpan);
    container.appendChild(para);
  });
}

if (readingInput) {
  readingInput.addEventListener("input", (e) => {
    if (readingRenderDebounce) clearTimeout(readingRenderDebounce);
    readingRenderDebounce = setTimeout(
      () => renderReadingFromText(e.target.value),
      250,
    );
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
    a.download = `article-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    a.click();
  });
}

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

// ensure initial tab
showTab("podcast");
