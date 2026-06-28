# AGENT.md

This file provides strict architectural guidance and code behavior rules for Code Agents (Codex, Copilot, Cursor, etc.) when working inside the **LingFlow (灵流)** repository.

## 🌊 Project Overview
"LingFlow (灵流)" is a seamless, cross-platform bilingual translation tool designed to let translations flow naturally into reading scenarios. It operates across multiple targets using a single Monorepo codebase.

### Core Targets:
1. **Browser Extension**: Chrome/Edge Manifest V3 extension for web-based paragraph-level bilingual injection.
2. **Cross-Platform App**: Desktop (Windows) and Mobile (Android/iOS) client built via Tauri v2, sharing a unified React console UI.

---

## 🏗️ Monorepo Architecture Rules
We utilize `pnpm workspaces` + `Turborepo`. The project is strictly decoupled into App Layers (`apps/`) and Shared Logic Packages (`packages/`).

### 1. Key Directory Structure
- `packages/core/` — Translation Core Engine (Decoupled into `provider`, `cache`, `scheduler`, and `type`). Supports mock, google-free, baidu-free, and AI (OpenAI/DeepSeek) stream translations.
  - Entry: `packages/core/src/index.ts`
- `packages/dom/` — DOM parsing, paragraph extraction, bilingual injection, deduplication, and cleanup algorithms.
  - Entry: `packages/dom/src/index.ts`
- `apps/extension/` — Browser Extension (MV3)
  - `manifest.ts` — Extension manifest definition.
  - `src/background.ts` — Service worker acting as a translation proxy to bypass CORS.
  - `src/content.ts` — Injected script handling paragraph extraction & DOM bilingual styling.
  - `src/App.tsx` — Configuration & Settings Popup UI.
- `apps/app/` — Tauri v2 Multi-platform App (Windows, Android, iOS)
  - `src/App.tsx` — Desktop-first translation control console UI.
  - `src-tauri/src/lib.rs` — Rust backend command center exposed to frontend via `invoke`.

### 2. CRITICAL ARCHITECTURE GUARDRAILS:
- **NO CENTRAL BACKEND SERVER**: LingFlow is a client-only architecture. All translation calls happen via the user's local network using Free public APIs or BYO-Key (Bring Your Own Key) models for AI. Do not write any centralized authentication or database storage logic.
- **EXTENSION CORS BYPASS**: Browser content scripts (`apps/extension/src/content.ts`) MUST NEVER fetch translation APIs directly due to CSP/CORS limits. They MUST delegate translation jobs via `chrome.runtime.sendMessage` to `background.ts`.
- **TAURI NATIVE BRIDGE**: The App UI (`apps/app/src/App.tsx`) communicates with native OS capabilities (clipboard listening, window controls, local proxies) exclusively through Tauri commands in `lib.rs`. Do not write browser-native Node.js fs/process mockups in the frontend.

---

## 🛠️ Essential Project Commands
Always invoke commands from the workspace root using `pnpm`:
- `pnpm typecheck` : Run TypeScript validation across all workspaces.
- `pnpm build` : Build all packages and applications via Turborepo.
- `pnpm test` : Run unit tests for `@lingflow/core` and `@lingflow/dom`.
- `pnpm --filter app tauri dev` : Run Windows Desktop dev environment (Ensure Rust toolchain is available in the shell environment).
- `pnpm --filter app tauri android dev` : Run Android Mobile dev environment (Requires Android SDK & NDK).

---

## 📝 Code Style & Implementation Standards
1. **TypeScript / React**: 
   - Follow strict typing. Avoid using `any`.
   - Use functional components with hooks. Prefer Tailwind CSS for styling. Ensure UI in `apps/app` is highly responsive (`md:` breakpoints) since it targets both wide desktop monitors and narrow mobile screens.
2. **Rust (Tauri)**:
   - Keep Tauri commands inside `lib.rs` clean and predictable. Return structured errors that map cleanly to JavaScript promises.
3. **DOM Manipulation Safety**:
   - When injecting translation blocks in `@lingflow/dom`, never destroy existing event listeners or blow away `innerHTML`. Inject dedicated child elements with isolated class names (e.g., `.lingflow-translation-text`) to enable clean deletion/toggling.
4. **Comments**: 中文优先 (Chinese preferred for in-line annotations, logic justifications, and Git commits).

---

## 🤖 AI Collaboration Workflow
- **Validation Checkpoint**: Before modifying structural parts of `@lingflow/core`, ensure you run `pnpm test` to prevent regressions on memory caching or scheduling logic.
- **Manifest V3 Alert**: When writing code for the extension, remember that `background.ts` is a Service Worker—it is ephemeral. Do not store permanent in-memory global state there; use `chrome.storage.local` or `chrome.storage.sync`.
- **Think Before You Code**: If a requested feature asks for a third-party module, evaluate if it blows up the Tauri bundle size or violates MV3 Extension execution safety (no unsafe-eval allowed).