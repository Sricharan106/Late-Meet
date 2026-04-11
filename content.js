// Content Script — Google Meet Integration
// Injected into Google Meet pages to detect meetings, monitor participants,
// and display private late-joiner briefs locally

(function() {
  'use strict';

  const COPILOT_PREFIX = '[MeetingCopilot]';
  let meetingDetected = false;
  let participantPollInterval = null;
  let previousParticipants = [];
  let meetingId = null;
  let briefOverlayVisible = false;

  // ——— Meeting Detection ———
  function extractMeetingId() {
    const url = window.location.href;
    const match = url.match(/meet\.google\.com\/([a-z\-]+)/);
    return match ? match[1] : null;
  }

  function detectMeeting() {
    const leaveCallBtn = document.querySelector('button[aria-label="Leave call"]');
    const inCallIndicator = leaveCallBtn ||
                             document.querySelector('[data-meeting-code]') ||
                             document.querySelector('[data-unresolved-meeting-id]');

    const url = window.location.href;
    const isMeetUrl = /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(url);

    if (inCallIndicator && isMeetUrl && !meetingDetected) {
      meetingDetected = true;
      meetingId = extractMeetingId();
      
      console.log(`${COPILOT_PREFIX} Meeting detected: ${meetingId}`);
      
      chrome.runtime.sendMessage({
        type: 'MEETING_STARTED',
        meetingId: meetingId,
        url: window.location.href
      });

      injectFloatingButton();
      startParticipantMonitoring();
    }
  }

  // ——— Participant Monitoring ———
  function getParticipantNames() {
    const names = new Set();
    
    const participantItems = document.querySelectorAll(
      '[data-participant-id] [data-self-name],' +
      '.zWGUib,' +
      '.cS7aqe.NkoGfe'
    );
    
    participantItems.forEach(el => {
      const name = el.textContent?.trim() || el.getAttribute('data-self-name');
      if (name && name.length > 0 && name !== 'You') {
        names.add(name);
      }
    });
    
    const videoTiles = document.querySelectorAll('.KV1GEc, .dwSJ2e');
    videoTiles.forEach(tile => {
      const nameEl = tile.querySelector('.XEazBc, .zs7s8d, .ZjFb7c');
      if (nameEl) {
        const name = nameEl.textContent?.trim();
        if (name && name !== 'You') names.add(name);
      }
    });
    
    const captionNames = document.querySelectorAll('.zs7s8d.jxFHg');
    captionNames.forEach(el => {
      const name = el.textContent?.trim();
      if (name) names.add(name);
    });
    
    return Array.from(names);
  }

  function startParticipantMonitoring() {
    participantPollInterval = setInterval(() => {
      const currentParticipants = getParticipantNames();
      
      if (currentParticipants.length > 0) {
        const hasChanged = currentParticipants.length !== previousParticipants.length ||
          currentParticipants.some(p => !previousParticipants.includes(p));
        
        if (hasChanged) {
          chrome.runtime.sendMessage({
            type: 'PARTICIPANTS_UPDATED',
            participants: currentParticipants
          });
          
          previousParticipants = [...currentParticipants];
        }
      }
    }, 5000);
  }

  // ——— Private Brief Overlay ———
  function showBriefOverlay(briefContent, targetName) {
    if (briefOverlayVisible) return;
    briefOverlayVisible = true;
    
    const overlay = document.createElement('div');
    overlay.id = 'mc-brief-overlay';
    overlay.innerHTML = `
      <div class="mc-brief-card">
        <div class="mc-brief-header">
          <div class="mc-brief-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" x2="12" y1="19" y2="22"></line></svg>
          </div>
          <div class="mc-brief-title">AI Meeting Copilot</div>
          <button class="mc-brief-close" id="mc-close-brief">✕</button>
        </div>
        <div class="mc-brief-greeting">${briefContent.greeting || `Hey ${targetName} 👋`}</div>
        <div class="mc-brief-text">${briefContent.briefing || "Here's what you missed:"}</div>
        <div class="mc-brief-section">
          <div class="mc-brief-label"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon" style="margin-right:6px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg> Topics Discussed</div>
          <ul class="mc-brief-list">
            ${(briefContent.topicsSummary || []).map(t => `<li>${t}</li>`).join('')}
          </ul>
        </div>
        ${(briefContent.keyDecisions || []).length > 0 ? `
          <div class="mc-brief-section">
            <div class="mc-brief-label"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon" style="margin-right:6px"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg> Key Decisions</div>
            <ul class="mc-brief-list">
              ${briefContent.keyDecisions.map(d => `<li>${d}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
        <div class="mc-brief-section">
          <div class="mc-brief-label"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon" style="margin-right:6px"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle></svg> Current Discussion</div>
          <div class="mc-brief-current">${briefContent.currentDiscussion || 'N/A'}</div>
        </div>
        ${(briefContent.actionItemsForThem || []).length > 0 ? `
          <div class="mc-brief-section">
            <div class="mc-brief-label"><svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon" style="margin-right:6px"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"></rect><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><path d="M12 11h4"></path><path d="M12 16h4"></path><path d="M8 11h.01"></path><path d="M8 16h.01"></path></svg> Action Items</div>
            <ul class="mc-brief-list">
              ${briefContent.actionItemsForThem.map(a => `<li>${a}</li>`).join('')}
            </ul>
          </div>
        ` : ''}
        <div class="mc-brief-footer">Only you can see this notification</div>
      </div>
    `;
    
    document.body.appendChild(overlay);
    
    requestAnimationFrame(() => {
      overlay.classList.add('mc-visible');
    });
    
    document.getElementById('mc-close-brief').addEventListener('click', () => {
      overlay.classList.remove('mc-visible');
      setTimeout(() => overlay.remove(), 300);
      briefOverlayVisible = false;
    });
    
    setTimeout(() => {
      if (overlay.parentNode) {
        overlay.classList.remove('mc-visible');
        setTimeout(() => overlay.remove(), 300);
        briefOverlayVisible = false;
      }
    }, 30000);
  }

  // ——— Floating Dashboard Button ———
  function injectFloatingButton() {
    if (document.getElementById('mc-float-btn')) return;
    
    const btn = document.createElement('div');
    btn.id = 'mc-float-btn';
    btn.innerHTML = `
      <div class="mc-float-btn-inner">
        <div class="mc-float-pulse"></div>
        <div class="mc-float-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>
        </div>
      </div>
      <div class="mc-float-label">AI Copilot</div>
    `;
    
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' });
    });
    
    document.body.appendChild(btn);
    
    requestAnimationFrame(() => {
      btn.classList.add('mc-visible');
    });
  }

  // ——— Meeting End Detection ———
  function detectMeetingEnd() {
    if (!meetingDetected) return;

    const leaveCallBtn = document.querySelector('button[aria-label="Leave call"]');
    const youLeftText = document.body.innerText.includes('You left the meeting');
    const rejoinBtn = document.querySelector('[jsname="oI7Fj"]');
    const returnHomeBtn = document.querySelector('.CRFCdf');
    const callEndedIndicator = document.querySelector('[data-call-ended]');

    const meetingEnded = !leaveCallBtn &&
      (youLeftText || rejoinBtn || returnHomeBtn || callEndedIndicator);

    if (meetingEnded) {
      meetingDetected = false;
      console.log(`${COPILOT_PREFIX} Meeting ended`);
      
      chrome.runtime.sendMessage({ type: 'MEETING_ENDED' });
      
      if (participantPollInterval) {
        clearInterval(participantPollInterval);
        participantPollInterval = null;
      }
      
      const btn = document.getElementById('mc-float-btn');
      if (btn) btn.remove();
    }
  }

  // ——— Listen for messages from background ———
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SHOW_BRIEF') {
      showBriefOverlay(message.briefContent, message.targetName);
      sendResponse({ success: true });
    }
    return true;
  });

  // ——— Initialize ———
  function init() {
    console.log(`${COPILOT_PREFIX} Content script loaded on Google Meet`);
    
    detectMeeting();
    
    const meetingCheckInterval = setInterval(() => {
      if (!meetingDetected) {
        detectMeeting();
      } else {
        detectMeetingEnd();
      }
    }, 3000);
    
    const observer = new MutationObserver(() => {
      if (!meetingDetected) {
        detectMeeting();
      }
    });
    
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
