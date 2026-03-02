# Codex Desktop (Pure Tauri Refactor)

Current stack:

- Runtime: `Tauri` + Rust command/state service (no Electron compatibility layer)
- Frontend: `React` + `Tailwind CSS` + inline `SVG` icons
- Performance: thread/message virtualized lists + incremental sync

## Functional Coverage

- Thread management: create, select, rename, pin/unpin, archive/unarchive
- Message flow: send user message, invoke `codex exec/resume` for assistant output, per-thread message history
- Persistence: `app-state.json` stored under Tauri app data directory
- Sync: realtime event bus (`codex_app:event`) + `app_sync_since` polling fallback
- Session continuity: persist `codexThreadId` per thread for follow-up turns
- Packaging: Windows `msi` and `nsis` installers via `tauri build`

## Run

```bash
pnpm install
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
pnpm run build:web
pnpm run tauri:dev
```

## Build

```bash
pnpm run build:web
pnpm run tauri:build
```
