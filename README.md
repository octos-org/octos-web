# MoFa Notebook (octos-web)

Open-source, self-hosted AI reading platform. Turn every book into an interactive notebook with chat, courseware generation, and more.

Built on [Octos](https://github.com/mofa-org/octos) AI agent framework.

## Features

**Notebook Core** — Create notebooks, upload sources (PDF/URL/text), chat with AI grounded in your sources with inline citations `[src:N]`

**Notes** — Save chat replies as notes, split Markdown editor, AI synthesis (multi-select → summarize), export (MD/PDF)

**Studio** — Generate courseware from your sources:
- Slides (6 styles, page-by-page editing)
- Quiz (interactive scoring)
- Flashcards (flip cards with spaced repetition)
- Mind Map (Mermaid diagrams)
- Infographic / Report / Comic

**Audio** — Podcast script generation (Deep Dive / Brief / Critique), TTS player with chapters and speed control

**Research** — Fast web search + Deep Research (multi-angle analysis with progress tracking), import results as sources

**Collaboration** — Notebook sharing (Viewer/Editor roles), template library

**Library** — Bookshelf browsing by subject/grade, usage statistics

**Channel Push** — Share to WeChat/Feishu/Telegram/Discord, scheduled push

## Quick Start

```bash
# 1. Start Octos backend
ANTHROPIC_API_KEY=your-key crew serve --port 9326 --auth-token your-token

# 2. Start frontend
cd octos-web
npm install
npm run dev

# 3. Open http://localhost:5174, login with your auth token
```

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | React 19 + TypeScript 5.9 |
| Build | Vite 7.3 |
| Styling | Tailwind CSS 4.2 |
| Chat | @assistant-ui/react + custom SSE adapter |
| Markdown | react-markdown + GFM + KaTeX + Mermaid |
| Routing | React Router v7 |
| Testing | Playwright (8 E2E tests) |
| Backend | Octos (Rust) — REST API + SSE streaming |

## Architecture

```
Browser (React SPA)  ──HTTP REST + SSE──▶  Octos Gateway (:9326)

In dev, Vite proxies /api/* → localhost:9326
In production, the SPA is served from the same origin (API_BASE = "")
```

## Project Structure

```
src/
  api/              # Base API client, auth, chat, sessions
  auth/             # Login page, auth guard, context
  runtime/          # @assistant-ui/react SSE adapter
  layouts/          # Chat layout with sidebar
  components/       # Thread, markdown renderer, media player, tool UIs
  notebook/         # MoFa Notebook module
    api/            # Notebook/Source/Note API calls (real Octos backend)
    pages/          # NotebookListPage, NotebookDetailPage, LibraryPage
    components/     # Citation markdown, Studio UIs (slides, quiz, etc.)
  hooks/            # Status polling, theme
  tools/            # Tool call UIs (shell, file, search, etc.)
tests/              # Playwright E2E tests
```

## Development

```bash
npm run dev          # Start dev server (port 5174)
npm run build        # Production build
npx tsc --noEmit     # Type check
npx playwright test  # Run E2E tests
```

## Related

- [Octos](https://github.com/mofa-org/octos) — Rust AI agent framework (backend)
- [MoFa Skills](https://github.com/mofa-org/mofa-skills) — Skill library (PPT, research, TTS, etc.)
- [PRD](docs/prd-notebook-web.md) — Product requirements document
