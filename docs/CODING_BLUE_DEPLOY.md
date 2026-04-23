# Coding-Blue Side-by-Side Deploy

The coding-blue refactor (Phase 3+4 runtime reducer routing, `task-store`
persistence, task-anchor UI) ships alongside the legacy web client instead of
replacing it. This document describes how the two bundles are built and how a
web server should host them.

## Two builds, two roots

| Command        | Base path | Output directory | Who serves it             |
|----------------|-----------|------------------|---------------------------|
| `npm run build`       | `/`       | `dist/`          | Legacy bundle (primary)   |
| `npm run build:next`  | `/next/`  | `dist-next/`     | Coding-blue bundle (next) |

`npm run build` continues to behave exactly as before — `tsc -b` followed by
`vite build`. It is the gate used by CI/typecheck.

`npm run build:next` sets `CODING_BLUE_NEXT=1`. `vite.config.ts` reads that
environment variable and switches `base` to `/next/` and `outDir` to
`dist-next`. The coding-blue client is served at the `/next/` URL prefix, and
all of its assets carry the `/next/` path so they can coexist with the legacy
bundle's assets at `/`.

## Deploy layout

Copy each bundle into its own URL root on the web server:

```
<web-root>/
    index.html              (from dist/)
    assets/                 (from dist/assets/)
    ...                     (all other dist/ files)
    next/
        index.html          (from dist-next/)
        assets/             (from dist-next/assets/)
        ...                 (all other dist-next/ files)
```

The API (`/api/*`) is shared between the two bundles — no backend work is
needed for the split. Users visiting `/` reach the legacy client; users
visiting `/next/` reach the coding-blue client.

## Why the split matters

Phase 3+4 reshapes several hot paths (SSE routing through reducers,
task-store persistence, task-anchor UI driven by `task-store` state). Shipping
it behind `/next/` lets the supervisor compare before/after behaviour without
forcing a risky all-at-once cut-over on the main surface.

## Router behaviour

`src/App.tsx` already uses
`basename={import.meta.env.BASE_URL}` on `BrowserRouter`, so the router
picks up `/` or `/next/` at build time. No code change is required to support
the two roots. When you add new absolute-URL fetches or links, use
`import.meta.env.BASE_URL` rather than hard-coding `/`.

## Verifying locally

```bash
npm run build        # legacy  -> dist/
npm run build:next   # next    -> dist-next/
```

Both invocations are expected to succeed without changes to existing tests.
`npm run build` is the typecheck gate (since `vitest` is not used); running
it after every commit catches TypeScript regressions introduced by the
runtime routing changes.
