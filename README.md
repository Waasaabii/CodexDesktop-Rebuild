# Codex Tauri Refactor

This folder is a parallel refactor workspace focused on performance architecture while preserving the existing UI.

## Goals

- Keep UI visuals and layout unchanged (reuse existing built webview assets).
- Replace Electron runtime bridge with a Tauri-compatible bridge.
- Move incremental event sync and sequence tracking to Rust backend state.

## Run

```bash
npm install
npm run rust:test
npm run rust:check
npm run tauri:dev
```

## Build

```bash
npm run tauri:build
```

