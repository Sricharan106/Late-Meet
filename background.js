// Background Service Worker — AI Meeting Copilot
// Orchestrates audio capture, AI processing, and localStorage session management

import { chatCompletion, whisperTranscribe, getApiKey } from './utils/api.js';
import { SYSTEM_PROMPT, SUMMARY_PROMPT, LATE_JOINER_BRIEF_PROMPT } from './utils/prompts.js';

// ——— State ———
let meetingState = {
  isActive: false,
  meetingId: null,
  startTime: null,
  transcript: [],
  rawBuffer: '',
  summary: '',
  topics: [],
  decisions: [],
  actionItems: [],
  currentTopic: '',
  sentiment: 'neutral',
  keyInsights: [],
  questionsRaised: [],
  participants: [],
  initialParticipants: [],
  lateJoiners: [],
  timeline: [],
  audioActive: false
};

// Rolling AI context — stores last 3 AI responses for continuity
let aiContextWindow = [];

let processingInterval = null;
let offscreenCreated = false;

// ——— Offscreen Document ———
async function ensureOffscreen() {
  if (offscreenCreated) return;
  
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    
    if (existingContexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA'],
        justification: 'Capture meeting audio for transcription'
      });
    }
    offscreenCreated = true;
  } catch (err) {
    console.error('[BG] Failed to create offscreen document:', err);
  }
}

// ——— Audio Capture ———
async function startAudioCapture(tabId) {
  await ensureOffscreen();
  
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    
    chrome.runtime.sendMessage({
      type: 'START_CAPTURE',
      streamId: streamId,
      tabId: tabId
    });
    
    console.log('[BG] Audio capture started for tab:', tabId);
  } catch (err) {
    console.error('[BG] Failed to start audio capture:', err);
  }
}

function stopAudioCapture() {
  chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
  offscreenCreated = false;
  console.log('[BG] Audio capture stopped');
}

// ——— AI Processing ———
async function processTranscript() {
  if (!meetingState.isActive || meetingState.rawBuffer.trim().length < 20) return;
  
  const apiKey = await getApiKey();
  if (!apiKey) {
    console.warn('[BG] No API key — using demo mode');
    broadcastState();
    return;
  }

  // Get user-selected model from settings
  const { settings } = await chrome.storage.local.get('settings');
  const model = settings?.aiModel || 'gpt-4o-mini';
  
  const transcript = meetingState.rawBuffer;
  
  try {
    const prompt = SUMMARY_PROMPT(transcript, meetingState.summary, aiContextWindow);
    const result = await chatCompletion(SYSTEM_PROMPT, prompt, apiKey, model);
    
    if (result) {
      meetingState.summary = result.summary || meetingState.summary;
      meetingState.topics = result.topics || meetingState.topics;
      meetingState.decisions = result.decisions || meetingState.decisions;
      meetingState.actionItems = result.actionItems || meetingState.actionItems;
      meetingState.currentTopic = result.currentTopic || meetingState.currentTopic;
      meetingState.sentiment = result.sentiment || meetingState.sentiment;
      meetingState.keyInsights = result.keyInsights || meetingState.keyInsights;
      meetingState.questionsRaised = result.questionsRaised || meetingState.questionsRaised;
      
      // Update rolling AI context window (keep last 3)
      aiContextWindow.push({
        timestamp: Date.now(),
        summary: result.summary,
        currentTopic: result.currentTopic,
        topicCount: (result.topics || []).length,
        decisionCount: (result.decisions || []).length
      });
      if (aiContextWindow.length > 3) aiContextWindow.shift();
      
      // Save to storage
      await chrome.storage.local.set({ meetingState: getStateSnapshot() });
      
      // Broadcast to popup and dashboard
      broadcastState();
    }
  } catch (err) {
    console.error('[BG] AI processing failed:', err);
  }
}

// ——— Late Joiner Briefing (Local Only) ———
async function generateLateJoinerBrief(joinerName) {
  const apiKey = await getApiKey();
  if (!apiKey) return null;

  const { settings } = await chrome.storage.local.get('settings');
  const model = settings?.aiModel || 'gpt-4o-mini';
  
  try {
    const prompt = LATE_JOINER_BRIEF_PROMPT(
      meetingState.summary,
      meetingState.topics,
      meetingState.decisions,
      meetingState.actionItems,
      meetingState.currentTopic,
      joinerName
    );
    
    const brief = await chatCompletion(SYSTEM_PROMPT, prompt, apiKey, model);
    
    if (brief) {
      // Show brief overlay via content script (local only, no Supabase)
      chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, {
            type: 'SHOW_BRIEF',
            briefContent: brief,
            targetName: joinerName
          }).catch(() => {});
        });
      });
    }
    
    return brief;
  } catch (err) {
    console.error('[BG] Failed to generate late joiner brief:', err);
    return null;
  }
}

// ——— Session Management ———
async function savePendingSession() {
  const { pendingSession, savedSessions = [] } = await chrome.storage.local.get(['pendingSession', 'savedSessions']);
  if (!pendingSession) return;

  savedSessions.unshift({
    ...pendingSession,
    savedAt: Date.now(),
    id: `session_${Date.now()}`
  });

  // Keep max 20 sessions
  if (savedSessions.length > 20) savedSessions.pop();

  await chrome.storage.local.set({ savedSessions });
  await chrome.storage.local.remove('pendingSession');
  console.log('[BG] Session saved');
}

async function discardPendingSession() {
  await chrome.storage.local.remove(['pendingSession', 'meetingState', 'lastMeetingState']);
  console.log('[BG] Session discarded');
}

// ——— State Management ———
function getStateSnapshot() {
  return {
    isActive: meetingState.isActive,
    meetingId: meetingState.meetingId,
    startTime: meetingState.startTime,
    duration: meetingState.startTime ? Math.round((Date.now() - meetingState.startTime) / 1000) : 0,
    summary: meetingState.summary,
    topics: meetingState.topics,
    decisions: meetingState.decisions,
    actionItems: meetingState.actionItems,
    currentTopic: meetingState.currentTopic,
    sentiment: meetingState.sentiment,
    keyInsights: meetingState.keyInsights,
    questionsRaised: meetingState.questionsRaised,
    participants: meetingState.participants,
    lateJoiners: meetingState.lateJoiners,
    timeline: meetingState.timeline,
    transcriptCount: meetingState.transcript.length,
    audioActive: meetingState.audioActive || false
  };
}

function broadcastState() {
  const snapshot = getStateSnapshot();
  chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state: snapshot }).catch(() => {});
}

function resetState() {
  meetingState = {
    isActive: false, meetingId: null, startTime: null,
    transcript: [], rawBuffer: '', summary: '',
    topics: [], decisions: [], actionItems: [],
    currentTopic: '', sentiment: 'neutral', keyInsights: [],
    questionsRaised: [], participants: [], initialParticipants: [],
    lateJoiners: [], timeline: [], audioActive: false
  };
  aiContextWindow = [];
}

// ——— Message Handler ———
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'MEETING_STARTED': {
      resetState();
      meetingState.isActive = true;
      meetingState.meetingId = message.meetingId;
      meetingState.startTime = Date.now();
      meetingState.timeline.push({ event: 'Meeting started', timestamp: Date.now(), elapsed: 0 });
      meetingState.audioActive = false;
      
      broadcastState();
      sendResponse({ success: true });
      break;
    }

    case 'START_AUDIO': {
      if (meetingState.isActive) {
        chrome.tabs.query({ url: "https://meet.google.com/*" }, (tabs) => {
          if (tabs.length > 0) {
            startAudioCapture(tabs[0].id);
            meetingState.audioActive = true;
            if (!processingInterval) {
              processingInterval = setInterval(processTranscript, 30000);
            }
            broadcastState();
          }
        });
      }
      sendResponse({ success: true });
      break;
    }

    case 'START_AUDIO_WITH_STREAM': {
      if (!meetingState.isActive) {
        resetState();
        meetingState.isActive = true;
        meetingState.startTime = Date.now();
        meetingState.timeline.push({ event: 'Meeting started (via audio)', timestamp: Date.now(), elapsed: 0 });
      }

      (async () => {
        await ensureOffscreen();
        chrome.runtime.sendMessage({
          type: 'START_CAPTURE',
          streamId: message.streamId,
          tabId: message.tabId
        });
        meetingState.audioActive = true;
        if (!processingInterval) {
          processingInterval = setInterval(processTranscript, 30000);
        }
        broadcastState();
      })();

      sendResponse({ success: true });
      break;
    }
    
    case 'MEETING_ENDED': {
      meetingState.isActive = false;
      meetingState.timeline.push({ event: 'Meeting ended', timestamp: Date.now(), elapsed: meetingState.startTime ? Math.round((Date.now() - meetingState.startTime) / 1000) : 0 });
      
      stopAudioCapture();
      if (processingInterval) {
        clearInterval(processingInterval);
        processingInterval = null;
      }
      
      // Final AI processing
      processTranscript();
      
      // Store as pending session for save/discard prompt
      const snapshot = getStateSnapshot();
      chrome.storage.local.set({
        pendingSession: snapshot,
        lastMeetingState: snapshot
      });

      // Broadcast session ended for popup/dashboard to show save prompt
      chrome.runtime.sendMessage({ type: 'SESSION_ENDED', state: snapshot }).catch(() => {});
      broadcastState();
      sendResponse({ success: true });
      break;
    }
    
    case 'TRANSCRIPT_CHUNK': {
      const { speaker, text, timestamp } = message;
      meetingState.transcript.push({ speaker, text, timestamp });
      meetingState.rawBuffer += `${speaker || 'Unknown'}: ${text}\n`;
      sendResponse({ success: true });
      break;
    }
    
    case 'AUDIO_TRANSCRIBED': {
      const { text, language } = message;
      if (text && text.trim()) {
        meetingState.transcript.push({ speaker: 'Audio', text, timestamp: Date.now() });
        meetingState.rawBuffer += `${text}\n`;
      }
      sendResponse({ success: true });
      break;
    }
    
    case 'PARTICIPANTS_UPDATED': {
      const currentList = message.participants || [];
      
      if (meetingState.initialParticipants.length === 0) {
        meetingState.initialParticipants = [...currentList];
        meetingState.participants = [...currentList];
      } else {
        const newJoiners = currentList.filter(
          p => !meetingState.participants.includes(p)
        );
        
        meetingState.participants = [...currentList];
        
        for (const joiner of newJoiners) {
          meetingState.lateJoiners.push(joiner);
          meetingState.timeline.push({
            event: `${joiner} joined (late)`,
            timestamp: Date.now(),
            elapsed: Math.round((Date.now() - meetingState.startTime) / 1000)
          });
          
          generateLateJoinerBrief(joiner);
        }
      }
      
      broadcastState();
      sendResponse({ success: true });
      break;
    }
    
    case 'GET_STATE': {
      sendResponse(getStateSnapshot());
      break;
    }

    case 'SAVE_SESSION': {
      savePendingSession().then(() => sendResponse({ success: true }));
      return true; // async
    }

    case 'DISCARD_SESSION': {
      discardPendingSession().then(() => sendResponse({ success: true }));
      return true; // async
    }

    case 'GET_SAVED_SESSIONS': {
      chrome.storage.local.get('savedSessions', (result) => {
        sendResponse(result.savedSessions || []);
      });
      return true; // async
    }

    case 'DELETE_SAVED_SESSION': {
      chrome.storage.local.get('savedSessions', (result) => {
        const sessions = (result.savedSessions || []).filter(s => s.id !== message.sessionId);
        chrome.storage.local.set({ savedSessions: sessions }, () => {
          sendResponse({ success: true });
        });
      });
      return true; // async
    }
    
    case 'OPEN_SIDE_PANEL': {
      if (sender.tab?.id) {
        chrome.sidePanel.open({ tabId: sender.tab.id });
      }
      sendResponse({ success: true });
      break;
    }
  }
  
  return true;
});

// ——— Side Panel Behavior ———
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

// ——— Handle extension installation ———
chrome.runtime.onInstalled.addListener(() => {
  console.log('[MeetingCopilot] Extension installed');
  chrome.storage.local.set({
    settings: {
      summarizationInterval: 30,
      autoSendBrief: true,
      lateJoinerBriefing: true,
      aiModel: 'gpt-4o-mini'
    }
  });
});
