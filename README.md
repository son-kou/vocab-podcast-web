# Vocab Podcast Web

Minimal static web app to support synchronized podcast transcripts with vocabulary integration and Anki export.

Features:

- Upload audio and transcript (JSON with timestamps or sentence-per-line simple transcript).
- Play audio with per-sentence highlighting and controls (play/pause, seek, speed).
- Hover over words to show quick dictionary card from local vocab index.
- Mark words as known/unknown; mastery reflected by color shading.
- Export selected vocab to Anki TSV using existing TSV template.

Developer notes:

- Designed to host on GitHub Pages (pure static site).
- For automatic sentence-level alignment, use external tools like `aeneas` or `gentle` to produce WebVTT or JSON with offsets.
- This prototype focuses on client-side UI and local JSON vocab index integration.

Quick start:

- Serve the `apps/vocab-podcast-web` directory with a static server (e.g., `python3 -m http.server 8000`) and open `index.html`.
