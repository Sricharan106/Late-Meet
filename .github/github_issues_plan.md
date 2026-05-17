# Production-Ready GitHub Issue Bank for Late-Meet (GSSoC 2026 Edition)

This document provides a highly structured bank of **12 validated, production-ready issues** to raise on your GitHub repository, [shouri123/Late-Meet](https://github.com/shouri123/Late-Meet).

These issues are designed specifically for your architecture (Vite, CRXJS, Manifest V3, Chrome Extension APIs, and ElevenLabs Scribe). They have been strictly audited against your current codebase to guarantee viability and **completely exclude any features currently in progress by other developers** (specifically meeting history, local search, multi-language options, keyboard shortcuts, and custom dropdown templates).

---

## 📋 Overview of Audited Issues

| Issue ID   | Issue Title                                                                 | Difficulty      | Target Area     | Value Proposition                                                                                     |
| :--------- | :-------------------------------------------------------------------------- | :-------------- | :-------------- | :---------------------------------------------------------------------------------------------------- |
| **LM-001** | Migrate Core Utility Modules (`api.js`, `prompts.js`) to Strict TypeScript  | 🟢 Beginner     | Code Health     | Enforces strict type-safety, removes JS imports, and speeds up the build pipeline.                    |
| **LM-002** | Silent Audio Chunk Filtering via Client-Side Voice Activity Detection (VAD) | 🔴 Advanced     | API Cost        | Drops silent audio slices locally inside offscreen context to minimize ElevenLabs token expenses.     |
| **LM-003** | Zero-Overhead Speaker Diarization using Google Meet's DOM Indicators        | 🟡 Intermediate | Core UX / AI    | Replaces generic `"Audio"` speaker tags with actual names by scraping Meet active-speaking borders.   |
| **LM-004** | Offline-Resilient API Request Queue with Jittered Exponential Backoff       | 🟡 Intermediate | Robustness      | Enqueues and retries requests dynamically during brief internet dropouts without losing audio slices. |
| **LM-005** | Dual-Channel Exporter (Markdown & JSON Files) with Side-Panel Toast Alerts  | 🟢 Beginner     | Usability       | Replaces browser-native `alert()` popups with high-quality downloadable files and custom toasts.      |
| **LM-006** | Dynamic Conversational Slicing via Vocal Pause Detection                    | 🔴 Advanced     | AI Quality      | Cuts recording chunks at natural pauses (breathing silence) instead of rigid 10s intervals.           |
| **LM-007** | Context Menu Capturer for Generalized Tab Audio Integration                 | 🟡 Intermediate | Scope           | Expands Late-Meet to transcribe YouTube webinars, Zoom web player, or WebEx calls via context menu.   |
| **LM-008** | Asynchronous Onboarding Key Validation with UX Shaking Feedback             | 🟢 Beginner     | Onboarding      | Prevents silent failures by verifying keys via official endpoints before committing them to storage.  |
| **LM-009** | Sleek Dark/Light Mode Theme Synchronization & Accent Palette Picker         | 🟡 Intermediate | Aesthetics      | Syncs options and popup layouts with standard system color schemes for a visually premium UI.         |
| **LM-010** | Real-Time Canvas Audio Waveform Visualizer in Dashboard Panel               | 🔴 Advanced     | Core UX         | Animates standard HTML5 Canvas waves when capture is active, making the dashboard feel alive.         |
| **LM-011** | Interactive Action-Item Checker with Native Chrome Notification Alerts      | 🟡 Intermediate | UX / Utility    | Notifies users immediately when action items are detected and allows checking them off in-panel.      |
| **LM-012** | Local API Cost & Token Usage Statistics Tracker Dashboard Widget            | 🟢 Beginner     | Cost Management | Injects a clean card tracking usage limits and estimated monthly expenses locally in the popup.       |

---

## 🚫 Excluded & Postponed Issues

- **AES-GCM Local Database Encryption:** Excluded to avoid file conflict since another contributor is actively building the local IndexedDB meeting history storage engine.
- **LLM Prompt Customizer Editor:** Excluded to prevent conflicts with the in-progress "Meeting summary templates" feature.

---

# Issue 1: Migrate Core Utility Modules (`api.js`, `prompts.js`) to Strict TypeScript

### 🟢 Difficulty: Beginner (Good First Issue)

### Description

Currently, our repository has a highly modern TypeScript 5.x build chain with strict compile checks enabled (`"strict": true`). However, two vital utility modules in `src/utils/` remain written in JavaScript:

- `src/utils/api.js` — Houses API request wrappers for ElevenLabs and OpenAI.
- `src/utils/prompts.js` — Outlines system, summary, late-joiner, and speaker analysis prompts.

Because these modules are in JavaScript, we are forced to explicitly include `.js` patterns in our `include` list in `tsconfig.json` and lose compile-time type verification, parameter safety, and autocomplete in `background.ts` and `dashboard.ts`.

### Proposed Solution

1. Migrate both modules to `.ts` extensions.
2. Define structural type definitions for transcripts, summaries, topics, decisions, action items, and API responses.
3. Remove JavaScript inclusions from the TypeScript configuration.

### Affected Files

- `src/utils/api.js` ➡️ **`src/utils/api.ts`**
- `src/utils/prompts.js` ➡️ **`src/utils/prompts.ts`**
- `tsconfig.json`
- `src/background.ts`
- `src/types.ts`

---

# Issue 2: Silent Audio Chunk Filtering via Client-Side Voice Activity Detection (VAD)

### 🔴 Difficulty: Advanced

### Description

Our media pipeline records continuous meeting tab audio using a `MediaRecorder` loop inside `offscreen.ts`, slicing the stream into base64 chunks which are sent to `background.ts` every few seconds to be transcribed.

However, during natural pauses in meetings, quiet solo work sessions, or periods of silence, the extension still issues API requests with silence/background noise to ElevenLabs Scribe or OpenAI Whisper, which consumes precious monthly token quotas and runs up API bills.

### Proposed Solution

Integrate a client-side **Web Audio API Analyzer** within the offscreen context. Before sending an audio chunk to the service worker, measure the Root Mean Square (RMS) energy or decibel levels of the captured stream. If the sound pressure level is below a customizable silence threshold (e.g., `-50dB` or `0.01` amplitude) for human voice spectrum frequencies (roughly `85Hz` to `255Hz`), drop the chunk locally, avoiding any network or API overhead.

### Affected Files

- `src/offscreen.ts`
- `src/background.ts`
- `src/options.html` / `src/options.ts`

---

# Issue 3: Zero-Overhead Speaker Diarization using Google Meet's DOM Indicators

### 🟡 Difficulty: Intermediate

### Description

The current implementation transcribes captured meeting audio but labels all transcript blocks with a generic `"Audio"` speaker name in `background.ts`:

```typescript
state.transcript.push({ speaker: "Audio", text: refinedText, timestamp: Date.now() });
```

This degrades the summary and makes reading the transcript logs confusing because it is impossible to see who agreed to which decision.

Running a machine learning speaker identification model in-browser is computationally heavy. Fortunately, Google Meet's web interface already displays visual cues (like visual equalizer rings, outer borders, or background highlights on speaking tiles) indicating exactly who is talking. We can leverage these DOM changes to attribute transcripts in real-time with **zero ML overhead**!

### Proposed Solution

1. Setup a real-time DOM speaking detector inside `content.ts`.
2. When Google Meet visual active-speaking classes are toggled on a participant's tile, capture the participant name.
3. Emit a message `ACTIVE_SPEAKER_CHANGED` containing the participant's name to the background script.
4. Map the active speaker during each 3-5s recording chunk window in `background.ts` to replace the generic `"Audio"` label with the correct user's name.

### Affected Files

- `src/content.ts`
- `src/background.ts`

---

# Issue 4: Offline-Resilient API Request Queue with Jittered Exponential Backoff

### 🟡 Difficulty: Intermediate

### Description

All transcriptions and summaries inside `background.ts` currently make sequential `fetch` requests directly to ElevenLabs and OpenAI.

If a meeting participant experiences a transient network drop (e.g. switching Wi-Fi, tunnels, or temporary drops), or hits rate limits (HTTP 429 status code) during rapid transcription updates:

1. The extension immediately throws errors.
2. The current audio chunk is abandoned, leading to irreversible gaps in meeting summaries and timeline action items.

### Proposed Solution

Build an **API Transaction Manager** class within `background.ts`. Enqueue requests inside a memory buffer. The queue processes tasks in order and incorporates:

- **Exponential Backoff**: Resubmits failed calls after `1s * 2^attempt` delay intervals.
- **Randomized Jitter**: Prevents simultaneous retry storming.
- **Offline Pause & Resume**: Uses `navigator.onLine` events. When offline, pause the execution queue and preserve audio chunks. Flush and process the queue automatically when the browser returns online.

### Affected Files

- `src/background.ts`

---

# Issue 5: Dual-Channel Exporter (Markdown & JSON Files) with Side-Panel Toast Alerts

### 🟢 Difficulty: Beginner (Good First Issue)

### Description

Currently, the meeting export button in `src/dashboard.ts` copies markdown summaries to the clipboard using `navigator.clipboard.writeText(markdown)` and fires a browser-native modal `alert('Session exported to clipboard as Markdown!')`.

This is highly disruptive to the user workflow and blocks the browser. Additionally, users are unable to:

1. Download a physical `.md` file directly to their machine.
2. Download a structured `.json` backup of the raw session data (transcripts, timelines, and statistics) for archiving or developer parsing.

### Proposed Solution

1. Replace browser-native `alert()` popups with a modern, smooth DOM toast alert in the side panel.
2. Upgrade the "Export" button inside the dashboard to trigger a small dropdown panel offering two direct action items:
   - **Download `.md` File**
   - **Download `.json` Backup**
   - **Copy to Clipboard**

### Affected Files

- `src/dashboard.ts`
- `src/dashboard.html`
- `src/dashboard.css`

---

# Issue 6: Dynamic Conversational Slicing via Vocal Pause Slicing

### 🔴 Difficulty: Advanced

### Description

Our audio recorder in `src/offscreen.ts` slices audio segments at a rigid `10000ms` (`10 seconds`) interval using `mediaRecorder.start(CHUNK_MS)`.

This causes transcript fragmentation:

- A speaker might be mid-sentence or mid-word exactly at the 10-second mark.
- Slicing a word in half across separate chunks confuses ElevenLabs Scribe or OpenAI Whisper, leading to poor word transitions or missing final characters.

### Proposed Solution

Replace arbitrary timer slicing with **Dynamic Conversational Slicing**:

- Stream audio continuously into `MediaRecorder` without hard cuts.
- Monitor active speaking states in real-time inside `offscreen.ts` using the RMS analyzer.
- Slice the chunk dynamically _only_ when the speaker takes a natural breath or brief pause (e.g. RMS remains below a quiet threshold for `1.5` seconds), OR if the buffer reaches a maximum safe limit (e.g., `25` seconds) to prevent buffer overflows.

### Affected Files

- `src/offscreen.ts`

---

# Issue 7: Context Menu Capturer for Generalized Tab Audio Integration

### 🟡 Difficulty: Intermediate

### Description

Late-Meet is currently locked exclusively to Google Meet matches (`https://meet.google.com/*`). Our inject scripts and "Start Copilot" buttons are heavily integrated with Meet URLs and panels.

However, users routinely attend meetings on alternative platforms (like Zoom web, WebEx, Microsoft Teams web) or listen to audio recordings, YouTube webinars, or podcasts where they need the same high-fidelity local summary and decision tracking.

### Proposed Solution

Introduce a **Rules-Free Tab Capturer** using the Chrome Context Menus API:

1. Register a right-click Context Menu option `"🎙️ Transcribe current tab with Late-Meet"` inside the extension manifest and background service worker.
2. When activated, launch the offscreen capture pipeline on the current tab, regardless of the URL domain.
3. Automatically launch the Side Panel dashboard to show summaries, and disable Meet-specific overlay features (like late-joiner briefing welcomes) that rely on DOM scraping.

### Affected Files

- `src/manifest.json`
- `src/background.ts`
- `src/dashboard.ts`

---

# Issue 8: Asynchronous Onboarding Key Validation with UX Shaking Feedback

### 🟢 Difficulty: Beginner (Good First Issue)

### Description

Currently, when a user launches the popup window and inputs their OpenAI API key or navigates to the options page to input an ElevenLabs Key, the inputs are immediately saved to storage without checking if the key is structurally valid, active, or funded. If a user commits a typo or saves an expired key, the extension will appear as "Recording..." but will fail silently in the background, dropping transcriptions with raw API 401 exceptions in the developer log.

### Proposed Solution

Add an dynamic validation query step prior to saving. When a user clicks "Save Key":

1. Fire a lightweight asynchronous check request to `https://api.openai.com/v1/models` (OpenAI) or `https://api.elevenlabs.io/v1/user` (ElevenLabs).
2. If the request succeeds, save the keys and slide the panel view open.
3. If the request fails (due to a 401/403 credentials error), show a descriptive error label, flag the text box with red borders, and trigger a hardware-accelerated shake animation so the user is immediately aware of the error.

### Affected Files

- `src/popup.ts`
- `src/popup.html`
- `src/options.ts`

---

# Issue 9: Sleek Dark/Light Mode Theme Synchronization & Accent Palette Picker

### 🟡 Difficulty: Intermediate

### Description

Currently, Late-Meet options and popup panels display a hardcoded styling profile. While clean, this lack of theme personalization creates visual friction in low-light environments, especially since Google Meet is frequently used in a custom dark interface mode. Enforcing matching visual palettes ensures maximum user comfort and a visually stellar user experience.

### Proposed Solution

Implement a **Theme & Color Customization Framework**:

1. Leverage standard HSL color tokens inside `src/options.css`, `src/popup.css`, and `src/dashboard.css` using CSS custom properties (`--bg-primary`, `--text-primary`, `--accent-color`).
2. Add a standard toggle inside settings to support:
   - **Light Mode**
   - **Dark Mode**
   - **System Default** (automatically syncing via `@media (prefers-color-scheme: dark)`).
3. Introduce an optional color circle selection grid inside the Options interface, allowing users to pick a custom accent highlight color (e.g., cobalt blue, royal purple, mint green, or orange coral). Save these options in local storage and apply dynamically to elements across all extension sub-panels.

### Affected Files

- `src/options.html` / `src/options.ts` / `src/options.css`
- `src/popup.css`
- `src/dashboard.css`

---

# Issue 10: Real-Time Canvas Audio Waveform Visualizer in Dashboard Panel

### 🔴 Difficulty: Advanced

### Description

When Late-Meet is active, the popup dashboard displays static buttons or labels like "Copilot Active". There is no live indicator demonstrating that the microphone/tab audio signals are actively feeding through the pipeline, which leads to uncertainty for users who worry if their audio is actually being captured.

### Proposed Solution

Add an dynamic, high-fidelity **Audio Waveform Canvas**:

1. In `src/dashboard.html`, allocate a modern `<canvas>` block directly under the recording status card.
2. In the `offscreen.ts` context, leverage the Web Audio API `AnalyserNode` to extract active time-domain byte data (`analyser.getByteTimeDomainData`).
3. Stream a highly lightweight packet containing condensed frequency indicators to the dashboard panel via standard runtime channel messages (`ACTIVE_WAVE_DATA`).
4. In the side panel script (`dashboard.ts`), draw a beautiful, animated sine wave or bar frequency visualizer matching the HSL accent colors, which dynamically morphs and slides to reflect the speaker's vocal amplitude in real time.

### Affected Files

- `src/dashboard.html`
- `src/dashboard.ts`
- `src/offscreen.ts`

---

# Issue 11: Interactive Action-Item Checker with Native Chrome Notification Alerts

### 🟡 Difficulty: Intermediate

### Description

Late-Meet parses rolling meeting transcripts and extracts actionable items (topics, decisions, and action tasks). However, these items are currently statically displayed in the dashboard panel. If a user has the side panel closed, they will completely miss critical action items.

### Proposed Solution

Introduce an **Active Task Manager & Notification Pipeline**:

1. Implement standard Chrome Notifications (`chrome.notifications` API) inside the background service worker.
2. When the OpenAI parser detects a _new_ critical Action Item or Decision, verify if notifications are enabled and push a premium native Chrome toast alert (e.g., _"New Decision by John Doe: Relocate database to AWS"_).
3. In the side panel dashboard, make the action items checklist interactive. Render each action item with a sleek checkbox. When checked, save the task status ('completed' or 'pending') in local state storage and cross it out with a smooth CSS strikethrough transition.

### Affected Files

- `src/manifest.json`
- `src/background.ts`
- `src/dashboard.ts`
- `src/dashboard.html`

---

# Issue 12: Local API Cost & Token Usage Statistics Tracker Dashboard Widget

### 🟢 Difficulty: Beginner (Good First Issue)

### Description

To prevent users from exceeding their OpenAI API limits or ElevenLabs subscription budgets, they need visibility into their token consumption statistics. Currently, there is no usage indicator in the extension, forcing users to manually open their cloud billing dashboards to see how much money they've spent.

### Proposed Solution

Create a local **API Usage Tracker Widget**:

1. Inside the background script, calculate the exact token count sent and received for each OpenAI API call (using basic approximation or character calculation) and track the duration of audio seconds transcribed via ElevenLabs.
2. Multiply these metrics by the standard API models rate card (e.g., OpenAI $0.150 / 1M tokens, ElevenLabs Scribe pricing) to estimate the total cost in USD.
3. Save the running sums inside `chrome.storage.local` indexed by date.
4. Render a sleek **"Cost & Token Usage"** stats widget card in the extension popup and sidepanel dashboard, showing total tokens consumed and estimated session cost, with a "Reset Statistics" option.

### Affected Files

- `src/dashboard.html`
- `src/dashboard.ts`
- `src/background.ts`
