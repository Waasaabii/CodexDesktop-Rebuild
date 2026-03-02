# Codex Desktop (Pure Tauri Refactor)

Current stack:

- Runtime: `Tauri` + Rust command/state service (no Electron compatibility layer)
- Frontend: `React` + `Tailwind CSS` + inline `SVG` icons
- Performance: thread/message virtualized lists + incremental sync

## Functional Coverage

- Thread management: create, select, rename, pin/unpin, archive/unarchive
- Message flow: send user message, assistant auto reply, per-thread message history
- Persistence: `app-state.json` stored under Tauri app data directory
- Sync: realtime event bus (`codex_app:event`) + `app_sync_since` polling fallback
- Packaging: Windows `msi` and `nsis` installers via `tauri build`

## Run

```bash
npm install --include=dev
npm run rust:test
npm run rust:check
npm run build:web
npm run tauri:dev
```

## Build

```bash
npm run build:web
npm run tauri:build
```
