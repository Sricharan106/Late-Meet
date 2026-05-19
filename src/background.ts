// MV3 service worker for Late Meet

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_WHISPER_URL = "https://api.openai.com/v1/audio/transcriptions";
const OFFSCREEN_DOCUMENT_PATH = "src/offscreen.html";
const OFFSCREEN_DOCUMENT_URL = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
const MAX_PROMPT_LENGTH = 2000;
const TRANSCRIPT_WINDOW_SIZE = 25;
const SUMMARIZATION_MAX_TOKENS = 1200;
const JOINER_MESSAGE_MAX_TOKENS = 120;
const ELEVENLABS_STT_MODEL = "scribe_v2";
// Delay late-joiner auto messages until 10s to avoid lobby/join churn spam.
const MIN_MEETING_DURATION_FOR_WELCOME = 10;

import { State } from "./types";
import { audioFileExtensionForMimeType, isChunkViable } from "./audioProcessing";

// ─────────────────────────────────────────────────────────────────────────────
// ApiTransactionManager
//
// Wraps every ElevenLabs / OpenAI fetch call with:
//  • In-memory FIFO queue  — audio chunks are never abandoned mid-request
//  • Exponential backoff   — delay = 1000ms * 2^attempt
//  • Randomised jitter     — ±50 % of delay, prevents retry storms on reconnect
//  • Offline pause/resume  — listens to ServiceWorker online/offline events;
//                            pauses automatically when offline, flushes on reconnect
//  • Dead-letter logging   — tasks exceeding maxRetries are logged and rejected
//  • Concurrency cap       — at most 2 tasks run simultaneously
// ─────────────────────────────────────────────────────────────────────────────

type TaskFn<T> = () => Promise<T>;

interface QueuedTask<T = unknown> {
  id: string;
  label: string;
  fn: TaskFn<T>;
  attempt: number;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

class ApiTransactionManager {
  private readonly queue: QueuedTask[] = [];
  private running = 0;
  private paused = false;

  private readonly maxRetries: number;
  private readonly maxConcurrent: number;
  private readonly baseDelayMs: number;

  constructor(maxRetries = 5, maxConcurrent = 2, baseDelayMs = 1000) {
    this.maxRetries = maxRetries;
    this.maxConcurrent = maxConcurrent;
    this.baseDelayMs = baseDelayMs;
    this.bindConnectivityListeners();
  }

  /**
   * Enqueue an API call. Returns a promise that resolves with the result, or
   * rejects after the retry budget is exhausted / a non-retryable error occurs.
   *
   * @param fn    Zero-argument async function that performs the fetch.
   * @param label Short description used in log messages.
   */
  enqueue<T>(fn: TaskFn<T>, label = "unnamed task"): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<T> = {
        id: `atm_${++ApiTransactionManager.counter}`,
        label,
        fn,
        attempt: 0,
        resolve,
        reject,
      };
      this.queue.push(task as QueuedTask);
      console.debug(`[ATM] ↑ Enqueued "${label}" (${task.id}). Queue depth: ${this.queue.length}`);
      this.tick();
    });
  }

  /** Number of pending + in-flight tasks. */
  get size(): number {
    return this.queue.length + this.running;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    if (!this.paused) {
      this.paused = true;
      console.info("[ATM] ⏸ Queue paused.");
    }
  }

  resume(): void {
    if (this.paused) {
      this.paused = false;
      console.info(`[ATM] ▶ Queue resumed. ${this.queue.length} task(s) waiting.`);
      this.tick();
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private static counter = 0;

  /**
   * Exponential backoff with ±50 % randomised jitter.
   * Sequence (base 1000 ms): ~1 s → ~2 s → ~4 s → ~8 s → ~16 s
   */
  private backoffDelay(attempt: number): number {
    const exp = this.baseDelayMs * Math.pow(2, attempt);
    const jitter = exp * 0.5 * (Math.random() * 2 - 1);
    return Math.max(0, exp + jitter);
  }

  /**
   * Returns true for errors that are safe to retry:
   *  - HTTP 429 (rate limit) or 5xx (server errors)
   *  - TypeError / "Failed to fetch" (network drop)
   */
  private isRetryable(err: unknown): boolean {
    const status = (err as { status?: number }).status;
    if (typeof status === "number") return status === 429 || status >= 500;
    return err instanceof TypeError;
  }

  private tick(): void {
    if (this.paused) return;
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.running++;
      void this.execute(task);
    }
  }

  private async execute(task: QueuedTask): Promise<void> {
    try {
      console.debug(
        `[ATM] ⚙ Running "${task.label}" (${task.id}), attempt ${task.attempt + 1}/${this.maxRetries + 1}`,
      );
      const result = await task.fn();
      task.resolve(result);
      console.debug(`[ATM] ✓ "${task.label}" (${task.id}) succeeded.`);
    } catch (err: unknown) {
      if (this.isRetryable(err) && task.attempt < this.maxRetries) {
        task.attempt++;
        const delay = this.backoffDelay(task.attempt - 1);
        console.warn(
          `[ATM] ↺ "${task.label}" (${task.id}) failed — retrying (${task.attempt}/${this.maxRetries}) in ${Math.round(delay)} ms.`,
          err,
        );
        setTimeout(() => {
          this.queue.unshift(task); // front of queue preserves FIFO per-chunk order
          this.tick();
        }, delay);
        return; // keep slot occupied until setTimeout fires
      }
      console.error(
        `[ATM] ✗ "${task.label}" (${task.id}) dead-lettered after ${task.attempt + 1} attempt(s).`,
        err,
      );
      task.reject(err);
    } finally {
      this.running--;
      this.tick();
    }
  }

  /**
   * MV3 service workers don't propagate window events, so we listen on `self`
   * (ServiceWorkerGlobalScope). Falls back to `window` in test environments.
   */
  private bindConnectivityListeners(): void {
    const target: EventTarget = typeof self !== "undefined" ? self : window;

    target.addEventListener("offline", () => {
      console.warn("[ATM] 📡 Offline — pausing queue to preserve audio chunks.");
      this.pause();
    });

    target.addEventListener("online", () => {
      console.info("[ATM] 📡 Back online — resuming queue.");
      this.resume();
    });

    // Handle starting up while already offline.
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      this.paused = true;
      console.warn("[ATM] ⚠ Started offline — queue paused until reconnect.");
    }
  }
}

// Singleton — used by all fetch call sites below.
const apiManager = new ApiTransactionManager();

// ─────────────────────────────────────────────────────────────────────────────
// Rest of background.ts — unchanged except the 5 fetch call sites below
// ─────────────────────────────────────────────────────────────────────────────

const state: State = {
  isActive: false,
  meetingId: null,
  meetingUrl: null,
  startTime: null,
  summary: "",
  topics: [],
  decisions: [],
  actionItems: [],
  currentTopic: "",
  sentiment: "neutral",
  keyInsights: [],
  questionsRaised: [],
  participants: [],
  initialParticipants: [],
  lateJoiners: [],
  timeline: [],
  transcript: [],
  audioActive: false,
  targetTabId: null,
  lastSummarizedAt: 0,
  pendingJoiners: new Set(),
  participantCount: 0,
};

let selfParticipantName: string | null = null;

function normalizeParticipantName(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function resetState() {
  state.isActive = false;
  state.meetingId = null;
  state.meetingUrl = null;
  state.startTime = null;
  state.summary = "";
  state.topics = [];
  state.decisions = [];
  state.actionItems = [];
  state.currentTopic = "";
  state.sentiment = "neutral";
  state.keyInsights = [];
  state.questionsRaised = [];
  state.participants = [];
  state.initialParticipants = [];
  state.lateJoiners = [];
  state.timeline = [];
  state.transcript = [];
  state.audioActive = false;
  state.targetTabId = null;
  state.lastSummarizedAt = 0;
  state.pendingJoiners.clear();
  state.participantCount = 0;
  selfParticipantName = null;
}

function addTimeline(event: string) {
  state.timeline.push({
    event,
    timestamp: Date.now(),
    elapsed: state.startTime ? Math.round((Date.now() - state.startTime) / 1000) : 0,
  });
}

function getDuration() {
  if (!state.startTime) return 0;
  return Math.round((Date.now() - state.startTime) / 1000);
}

function snapshot() {
  return {
    isActive: state.isActive,
    meetingId: state.meetingId,
    meetingUrl: state.meetingUrl,
    startTime: state.startTime,
    duration: getDuration(),
    summary: state.summary,
    topics: state.topics,
    decisions: state.decisions,
    actionItems: state.actionItems,
    currentTopic: state.currentTopic,
    sentiment: state.sentiment,
    keyInsights: state.keyInsights,
    questionsRaised: state.questionsRaised,
    participants: state.participants,
    lateJoiners: state.lateJoiners,
    timeline: state.timeline,
    transcript: state.transcript,
    audioActive: state.audioActive,
    participantCount: state.participantCount,
  };
}

async function broadcastStateUpdate() {
  const snapshotData = snapshot();
  try {
    await chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: snapshotData });
  } catch {
    /* ignore */
  }

  try {
    const tabs = await chrome.tabs.query({ url: "https://meet.google.com/*" });
    for (const tab of tabs) {
      if (tab.id !== undefined) {
        chrome.tabs
          .sendMessage(tab.id, { type: "STATE_UPDATE", state: snapshotData })
          .catch(() => {});
      }
    }
  } catch {
    /* ignore */
  }
}

async function getApiKey() {
  const result = await chrome.storage.local.get("openai_api_key");
  return result.openai_api_key || null;
}

interface Settings {
  summarizationInterval?: number;
  aiModel?: string;
}

async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get("settings");
  return result.settings || {};
}

function sanitizePromptText(value: string | null) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/```/g, "")
    .replace(/[<>{}]/g, " ")
    .slice(0, MAX_PROMPT_LENGTH);
}

async function ensureOffscreenDocument() {
  const contexts = await (chrome.runtime as any).getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_DOCUMENT_URL],
  });

  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ["USER_MEDIA" as any],
    justification: "Capture Google Meet tab audio for local transcription",
  });
}

async function closeOffscreenDocumentIfPresent() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as any],
    documentUrls: [OFFSCREEN_DOCUMENT_URL],
  });

  if (contexts.length > 0) {
    await chrome.offscreen.closeDocument();
  }
}

function getTranscriptionPrompt() {
  const recentTexts = state.transcript
    .slice(-3)
    .map((e) => e.text)
    .join(" ");
  if (!recentTexts) return "";
  return recentTexts.slice(-200);
}

// ─── CALL SITE 1 & 2: ElevenLabs Scribe + Whisper fallback ───────────────────
async function transcribeChunk(base64Audio: string, mimeType = "audio/webm", prompt = "") {
  const elevenlabsKey = await chrome.storage.local
    .get("elevenlabs_api_key")
    .then((r) => r.elevenlabs_api_key);

  const bytes = Uint8Array.from(atob(base64Audio), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: mimeType });

  if (!isChunkViable(blob)) {
    console.warn("[LateMeet] Audio chunk too small to transcribe, skipping:", blob.size, "bytes");
    return null;
  }

  const normalizedMime = mimeType.split(";")[0].trim();
  const extension = audioFileExtensionForMimeType(normalizedMime);

  if (elevenlabsKey) {
    try {
      const transcript = await apiManager.enqueue(async () => {
        const formData = new FormData();
        formData.append("file", blob, `audio.${extension}`);
        formData.append("model_id", ELEVENLABS_STT_MODEL);

        const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
          method: "POST",
          headers: { "xi-api-key": elevenlabsKey },
          body: formData,
        });

        if (!response.ok) {
          const text = await response.text();
          console.error("[LateMeet] ElevenLabs API rejected chunk", {
            status: response.status,
            statusText: response.statusText,
            response: text,
            mimeType,
            size: blob.size,
          });
          // Attach .status so isRetryable() can identify 429/5xx without
          // inspecting the raw Response object after it has been consumed.
          throw Object.assign(new Error(`ElevenLabs STT error ${response.status}: ${text}`), {
            status: response.status,
          });
        }

        const data = await response.json();
        const result = (data.text || "").trim();
        if (!result) {
          console.warn(
            "[LateMeet] ElevenLabs returned empty transcript → triggering Whisper fallback",
          );
          // status: 0 → non-retryable; falls straight through to Whisper.
          throw Object.assign(new Error("Empty ElevenLabs transcript"), { status: 0 });
        }
        return result;
      }, `ElevenLabs Scribe (${blob.size}B, ${normalizedMime})`);

      return transcript;
    } catch (err) {
      console.warn("[LateMeet] ElevenLabs transcription failed, falling back to Whisper:", err);
    }
  }

  // Fallback: OpenAI Whisper
  const apiKey = await getApiKey();
  if (!apiKey) return null;

  return apiManager.enqueue(async () => {
    const formData = new FormData();
    formData.append("file", blob, `audio.${extension}`);
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json");
    if (prompt) formData.append("prompt", prompt);

    const response = await fetch(OPENAI_WHISPER_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const text = await response.text();
      throw Object.assign(new Error(`Whisper API error ${response.status}: ${text}`), {
        status: response.status,
      });
    }

    const data = await response.json();
    return (data.text || "").trim() || null;
  }, `Whisper fallback (${blob.size}B, ${normalizedMime})`);
}

// ─── CALL SITE 3: OpenAI — transcript refinement ─────────────────────────────
async function refineTranscription(rawText: string) {
  if (!rawText || rawText.length < 5) return rawText;

  const words = rawText.trim().split(/\s+/);
  if (words.length < 3) return rawText;

  const apiKey = await getApiKey();
  if (!apiKey) return rawText;

  const systemPrompt = `You are an expert AI transcription editor. 
Your task is to correct errors, remove filler words (um, uh, like), and improve the clarity of the provided meeting transcript segment while strictly preserving the speaker's original meaning and intent. 
Return ONLY the corrected transcript text. If the input is unclear, inaudible, or empty, return the exact input unchanged. Never add commentary, apologies, or meta-responses.`;

  try {
    const refined = await apiManager.enqueue(async () => {
      const response = await fetch(OPENAI_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: rawText },
          ],
          temperature: 0.1,
          max_tokens: 500,
        }),
      });

      if (!response.ok) {
        throw Object.assign(new Error(`Refinement API error ${response.status}`), {
          status: response.status,
        });
      }
      const data = await response.json();
      return data?.choices?.[0]?.message?.content?.trim() || rawText;
    }, "OpenAI refine transcription");

    const lowerRefined = refined.toLowerCase();
    if (
      lowerRefined.startsWith("i'm sorry") ||
      lowerRefined.startsWith("i apologize") ||
      lowerRefined.startsWith("sorry,") ||
      lowerRefined.includes("no text provided") ||
      lowerRefined.includes("please provide") ||
      lowerRefined.includes("i cannot") ||
      lowerRefined.includes("there is no")
    ) {
      return rawText;
    }

    return refined;
  } catch (err) {
    console.error("[LateMeet] Refinement failed:", err);
    return rawText;
  }
}

// ─── CALL SITE 4: OpenAI — meeting summarisation ─────────────────────────────
async function summarizeTranscriptIfNeeded() {
  if (!state.isActive || state.transcript.length === 0) return;

  const settings = await getSettings();
  const requestedInterval = Number(settings.summarizationInterval);
  const intervalSeconds =
    Number.isFinite(requestedInterval) && requestedInterval > 0 ? requestedInterval : 30;
  const lastSum = state.lastSummarizedAt || 0;
  const elapsed = Math.floor((Date.now() - lastSum) / 1000);
  if (lastSum > 0 && elapsed < intervalSeconds) return;

  const apiKey = await getApiKey();
  if (!apiKey) return;

  const transcriptWindow = state.transcript
    .slice(-TRANSCRIPT_WINDOW_SIZE)
    .map((e) => `${sanitizePromptText(e.speaker)}: ${sanitizePromptText(e.text)}`)
    .join("\n");
  if (!transcriptWindow.trim()) return;

  const systemPrompt = `You are a World-Class Meeting Intelligence Engine. 
Your goal is to extract high-fidelity insights from meeting transcripts.

OUTPUT GUIDELINES:
- Provide a concise yet professional summary (business grade).
- Identify distinct topics and their statuses (active/completed).
- Precisely capture decisions and action items (with assignees if mentioned).
- Detect the prevailing sentiment and emotional dynamics.
- Extract "Key Insights" that go beyond a simple summary (strategic value).
- Track specific questions raised that remain unanswered.

You must return ONLY a JSON object.`;

  const userPrompt = `Analyze the following meeting transcript segment.
Integrate this new data with the previous context.

PREVIOUS CONTEXT (Summary): 
${state.summary || "Initial session"}

RECENT TRANSCRIPT:
${transcriptWindow}

Return a JSON object with these exact keys:
{
  "summary": "Updated meeting summary...",
  "topics": [{"name": "Topic", "status": "active|completed"}],
  "decisions": ["Decision 1", ...],
  "actionItems": ["Action 1", ...],
  "currentTopic": "Identifying the current main topic",
  "sentiment": "positive|neutral|negative|mixed",
  "keyInsights": ["Insight 1", ...],
  "questionsRaised": ["Question 1", ...]
}`;

  const content = await apiManager.enqueue(async () => {
    const response = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: settings.aiModel || "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
        max_tokens: SUMMARIZATION_MAX_TOKENS,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw Object.assign(new Error(`Chat API error ${response.status}: ${text}`), {
        status: response.status,
      });
    }

    const data = await response.json();
    return data?.choices?.[0]?.message?.content as string | undefined;
  }, "OpenAI summarise transcript");

  if (!content) return;

  const parsed = JSON.parse(content);
  state.summary = parsed.summary || state.summary;
  state.topics = Array.isArray(parsed.topics) ? parsed.topics : state.topics;
  state.decisions = Array.isArray(parsed.decisions) ? parsed.decisions : state.decisions;
  state.actionItems = Array.isArray(parsed.actionItems) ? parsed.actionItems : state.actionItems;
  state.currentTopic = parsed.currentTopic || state.currentTopic;
  state.sentiment = parsed.sentiment || state.sentiment;
  state.keyInsights = Array.isArray(parsed.keyInsights) ? parsed.keyInsights : state.keyInsights;
  state.questionsRaised = Array.isArray(parsed.questionsRaised)
    ? parsed.questionsRaised
    : state.questionsRaised;
  state.lastSummarizedAt = Date.now();
}

function detectNewJoiners(currentList: string[]) {
  if (state.participants.length === 0 && state.initialParticipants.length === 0) {
    state.initialParticipants = [...currentList];
    state.participants = [...currentList];
    state.participantCount = currentList.length > 0 ? currentList.length : 1;
    return [];
  }

  const hasPlaceholderOnly =
    (state.initialParticipants.length === 0 ||
      (state.initialParticipants.length === 1 && state.initialParticipants[0] === "You")) &&
    state.participants.length === 1 &&
    state.participants[0] === "You";

  if (hasPlaceholderOnly) {
    const next = Array.isArray(currentList) ? currentList : [];
    if (next.length > 0 && !(next.length === 1 && next[0] === "You")) {
      state.initialParticipants = [...next];
      state.participants = [...next];
      state.participantCount = next.length;
      return [];
    }
  }

  const normalizedSelf = normalizeParticipantName(selfParticipantName);
  const next = Array.isArray(currentList) ? currentList : [];
  const newJoiners = next.filter(
    (p) =>
      !state.participants.includes(p) &&
      !state.initialParticipants.includes(p) &&
      (!normalizedSelf || normalizeParticipantName(p) !== normalizedSelf),
  );

  if (newJoiners.length > 0) {
    state.lateJoiners.push(...newJoiners);
    if (state.participantCount !== undefined) {
      state.participantCount += newJoiners.length;
    }
  }

  state.participants = [...next];
  return newJoiners;
}

// ─── CALL SITE 5: OpenAI — late-joiner welcome message ───────────────────────
async function generateLateJoinerMessage(joinerName: string) {
  const safeJoinerName = sanitizePromptText(joinerName);
  const context = {
    duration: getDuration(),
    currentTopic: state.currentTopic,
    topics: state.topics,
    decisions: state.decisions,
  };

  const fallback = `Hi ${joinerName}, welcome to the meeting! We are currently discussing ${context.currentTopic || "project updates"}.`;

  try {
    const apiKey = await getApiKey();
    if (!apiKey) return fallback;

    const prompt = `A participant named ${safeJoinerName} joined late. Meeting duration: ${Math.round(context.duration / 60)} minutes. Current topic: ${sanitizePromptText(context.currentTopic || "General discussion")}. Recent topics: ${sanitizePromptText(JSON.stringify(context.topics || []))}. Decisions: ${sanitizePromptText(JSON.stringify(context.decisions || []))}. Write a short welcome message under 3 sentences. Output plain text only.`;

    const message = await apiManager.enqueue(async () => {
      const response = await fetch(OPENAI_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.5,
          max_tokens: JOINER_MESSAGE_MAX_TOKENS,
        }),
      });

      if (!response.ok) {
        throw Object.assign(new Error(`Chat API error ${response.status}`), {
          status: response.status,
        });
      }
      const data = await response.json();
      return data?.choices?.[0]?.message?.content?.trim() || fallback;
    }, `OpenAI late-joiner message for "${joinerName}"`);

    return message;
  } catch {
    return fallback;
  }
}

async function sendChatToTab(tabId: number, text: string) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "SEND_CHAT_MESSAGE",
      text,
    });
  } catch (err) {
    console.error("[LateMeet] Failed to send chat message to tab:", err);
  }
}

async function maybeWelcomeJoiners(tabId: number | undefined, joiners: string[]) {
  if (!joiners.length || getDuration() <= MIN_MEETING_DURATION_FOR_WELCOME || !tabId) return;

  const normalizedSelf = normalizeParticipantName(selfParticipantName);

  for (const joiner of joiners) {
    const name = String(joiner || "").trim();
    const normalizedName = normalizeParticipantName(name);
    if (
      !name ||
      normalizedName === normalizeParticipantName("You") ||
      (normalizedSelf && normalizedName === normalizedSelf) ||
      state.pendingJoiners.has(name)
    ) {
      continue;
    }

    state.pendingJoiners.add(name);
    try {
      const text = await generateLateJoinerMessage(name);
      await sendChatToTab(tabId, text);
      addTimeline(`Late joiner brief sent to ${name}`);
    } finally {
      state.pendingJoiners.delete(name);
    }
  }
}

async function savePendingSession() {
  const session = {
    id: crypto.randomUUID(),
    ...snapshot(),
    savedAt: Date.now(),
    isActive: false,
  };
  await chrome.storage.local.set({ pendingSession: session });
}

async function persistSession() {
  const { pendingSession, savedSessions } = await chrome.storage.local.get([
    "pendingSession",
    "savedSessions",
  ]);
  if (!pendingSession) return;

  const sessions = Array.isArray(savedSessions) ? savedSessions : [];
  sessions.unshift(pendingSession);
  await chrome.storage.local.set({ savedSessions: sessions, pendingSession: null });
}

async function discardPendingSession() {
  await chrome.storage.local.set({ pendingSession: null });
}

async function startAudioCapture(
  tabId: number,
  meetingId: string | null,
  meetingUrl: string | null,
  providedStreamId: string | null = null,
  includeMicrophone = true,
) {
  if (!tabId) throw new Error("Missing target tab id");

  await ensureOffscreenDocument();

  if (!state.isActive) {
    resetState();
    state.isActive = true;
    state.startTime = Date.now();
    state.meetingId = meetingId || "unknown";
    state.meetingUrl = meetingUrl || null;
    state.targetTabId = tabId;
    addTimeline(`Meeting started (${state.meetingId})`);
  }

  try {
    let streamId = providedStreamId;

    if (!streamId) {
      streamId = await new Promise<string | null>((resolve) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
          if (chrome.runtime.lastError) {
            console.error(
              "[LateMeet] getMediaStreamId error (background):",
              chrome.runtime.lastError.message || chrome.runtime.lastError,
            );
            resolve(null);
          } else {
            resolve(id);
          }
        });
      });
    }

    if (!streamId) {
      throw new Error(
        "Failed to get media stream ID for tab capture. Ensure you have given permission.",
      );
    }

    const response = await chrome.runtime.sendMessage({
      type: "OFFSCREEN_START_CAPTURE",
      streamId,
      tabId,
      includeMicrophone,
    });

    if (!response?.success) {
      throw new Error(response?.error || "Failed to start offscreen capture");
    }

    state.audioActive = true;
    addTimeline("Audio capture started");
    if (response.microphoneActive === false) {
      addTimeline("Microphone capture unavailable; recording tab audio only");
    }
    await broadcastStateUpdate();
  } catch (err) {
    state.audioActive = false;
    throw err;
  }
}

async function scanForMeetTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: "https://meet.google.com/*" });
    if (tabs.length > 0) {
      for (const tab of tabs) {
        const urlMatch = tab.url?.match(/meet\.google\.com\/([a-z\-]+)/);
        const meetingId = urlMatch ? urlMatch[1] : null;
        if (meetingId && meetingId !== "new") {
          if (!state.isActive) {
            resetState();
            state.isActive = true;
            state.meetingId = meetingId;
            state.meetingUrl = tab.url || null;
            state.targetTabId = tab.id || null;
            state.startTime = Date.now();
            state.participants = ["You"];
            console.log("[LateMeet] Proactively detected meeting:", meetingId);
            await broadcastStateUpdate();
          }
          return;
        }
      }
    }
  } catch (err) {
    console.error("[LateMeet] Scan for meet tabs failed:", err);
  }
}

async function stopAudioCapture(reason = "Stopped") {
  try {
    await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP_CAPTURE" });
  } catch {
    // Ignore if offscreen not running
  }

  if (state.isActive) {
    addTimeline(`Meeting ended (${reason})`);
    await savePendingSession();
  }

  state.audioActive = false;
  state.isActive = false;

  await broadcastStateUpdate();

  try {
    await chrome.runtime.sendMessage({ type: "SESSION_ENDED" });
  } catch {
    // no listeners
  }

  await closeOffscreenDocumentIfPresent();
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url?.includes("meet.google.com/")) {
    const urlMatch = tab.url.match(/meet\.google\.com\/([a-z\-]+)/);
    const meetingId = urlMatch ? urlMatch[1] : null;

    if (meetingId && meetingId !== "new") {
      if (!state.isActive) {
        resetState();
        state.isActive = true;
        state.meetingId = meetingId;
        state.meetingUrl = tab.url || null;
        state.targetTabId = tabId || null;
        state.startTime = Date.now();
        state.participants = ["You"];
        await broadcastStateUpdate();
      }
    }
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url?.includes("meet.google.com/")) {
      const urlMatch = tab.url.match(/meet\.google\.com\/([a-z\-]+)/);
      const meetingId = urlMatch ? urlMatch[1] : null;
      if (meetingId && meetingId !== "new" && !state.isActive) {
        state.meetingId = meetingId;
        state.meetingUrl = tab.url;
        state.targetTabId = activeInfo.tabId;
        await broadcastStateUpdate();
      }
    }
  } catch {
    // Tab might be closed by now
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (state.targetTabId && tabId === state.targetTabId) {
    if (state.isActive) {
      await stopAudioCapture("Meeting tab closed");
    } else {
      state.meetingId = null;
      state.targetTabId = null;
      await broadcastStateUpdate();
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "GET_STATE": {
        if (!state.isActive) {
          await scanForMeetTabs();
        }
        sendResponse(snapshot());
        return;
      }

      case "OPEN_SIDE_PANEL": {
        const callerTabId = sender?.tab?.id;
        if (callerTabId) {
          await chrome.sidePanel.open({ tabId: callerTabId });
        }
        sendResponse({ success: true });
        return;
      }

      case "MANUAL_START_AUDIO": {
        let tabId = message.tabId;
        if (tabId === "current") {
          tabId = sender?.tab?.id;
        }

        if (!tabId) {
          sendResponse({ success: false, error: "Target tab not found" });
          return;
        }

        const meetingId = message.meetingId || state.meetingId;
        const meetingUrl = sender?.tab?.url || state.meetingUrl;
        await startAudioCapture(
          tabId,
          meetingId,
          meetingUrl,
          message.streamId,
          message.includeMicrophone !== false,
        );
        sendResponse({ success: true });
        return;
      }

      case "OFFSCREEN_CAPTURE_STOPPED": {
        state.audioActive = false;
        await broadcastStateUpdate();
        sendResponse({ success: true });
        return;
      }

      case "OFFSCREEN_AUDIO_CHUNK": {
        if (!state.isActive) {
          sendResponse({ success: true, ignored: true });
          return;
        }

        try {
          const prompt = getTranscriptionPrompt();
          const rawText = await transcribeChunk(message.audioBase64, message.mimeType, prompt);
          console.log("[LateMeet] Raw transcription:", rawText);
          if (rawText) {
            const refinedText = await refineTranscription(rawText);
            console.log("[LateMeet] Refined transcription:", refinedText);
            state.transcript.push({ speaker: "Audio", text: refinedText, timestamp: Date.now() });
            await summarizeTranscriptIfNeeded();
            await broadcastStateUpdate();
          }
          sendResponse({ success: true });
        } catch (err) {
          console.error("[LateMeet] Audio chunk processing failed:", err);
          sendResponse({ success: false, error: (err as Error).message });
        }
        return;
      }

      case "PARTICIPANTS_UPDATED": {
        if (!Array.isArray(message.participants)) {
          sendResponse({ success: false, error: "participants must be an array" });
          return;
        }

        const incomingSelfName =
          typeof message.selfName === "string" ? message.selfName.trim() : "";
        if (incomingSelfName) selfParticipantName = incomingSelfName;

        const joiners = detectNewJoiners(message.participants);
        await maybeWelcomeJoiners(sender?.tab?.id || state.targetTabId || undefined, joiners);
        await broadcastStateUpdate();
        sendResponse({ success: true, joiners });
        return;
      }

      case "SAVE_SESSION": {
        await persistSession();
        await broadcastStateUpdate();
        sendResponse({ success: true });
        return;
      }

      case "DISCARD_SESSION": {
        await discardPendingSession();
        await broadcastStateUpdate();
        sendResponse({ success: true });
        return;
      }

      case "GET_SAVED_SESSIONS": {
        const { savedSessions } = await chrome.storage.local.get("savedSessions");
        sendResponse(Array.isArray(savedSessions) ? savedSessions : []);
        return;
      }

      case "DELETE_SAVED_SESSION": {
        const { savedSessions } = await chrome.storage.local.get("savedSessions");
        const sessions = Array.isArray(savedSessions) ? savedSessions : [];
        const next = sessions.filter((s) => s.id !== message.sessionId);
        await chrome.storage.local.set({ savedSessions: next });
        sendResponse({ success: true });
        return;
      }

      default: {
        sendResponse({ success: false, error: "Unknown message type" });
      }
    }
  })().catch((err) => {
    console.error("[LateMeet] Message handler error:", err);
    sendResponse({ success: false, error: err.message || "Unexpected error" });
  });

  return true;
});

// Proactive scan on startup/load
scanForMeetTabs();
