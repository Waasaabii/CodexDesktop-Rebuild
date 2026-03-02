# Codex Desktop (Tauri + React + Tailwind + SVG)

Refactored desktop stack:

- Runtime: `Tauri` + Rust backend event bridge
- Frontend: `React` + `Tailwind CSS` + inline `SVG` icon system
- Performance: virtualized lists and incremental background-safe sync

## Run

```bash
npm install --include=dev
npm run rust:test
npm run rust:check
npm run tauri:dev
```

## Build

```bash
npm run build:web
npm run tauri:build
```
