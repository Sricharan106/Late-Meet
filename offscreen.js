// Offscreen Document — Audio capture and Whisper transcription
// Enhanced with VAD (Voice Activity Detection), shorter chunks,
// Whisper prompt continuity, and language caching

let mediaRecorder = null;
let audioStream = null;
let recordingInterval = null;
let audioContext = null;
let analyserNode = null;

// ——— Context continuity state ———
let lastTranscript = '';        // Last transcribed text for Whisper prompt
let detectedLanguage = null;    // Cached language after first detection
let consecutiveSilent = 0;      // Track consecutive silent chunks

// ——— Receive messages from background ———
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'START_CAPTURE':
      startCapture(message.streamId);
      sendResponse({ success: true });
      break;
      
    case 'STOP_CAPTURE':
      stopCapture();
      sendResponse({ success: true });
      break;
  }
  return true;
});

/**
 * Start capturing audio from the tab with enhanced audio processing
 */
async function startCapture(streamId) {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });
    
    // Set up Audio Context for VAD (Voice Activity Detection)
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(audioStream);
    analyserNode = audioContext.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserNode.smoothingTimeConstant = 0.8;
    source.connect(analyserNode);
    
    console.log('[Offscreen] Audio stream obtained with VAD enabled');
    startRecordingLoop();
  } catch (err) {
    console.error('[Offscreen] Failed to get audio stream:', err);
  }
}

/**
 * Check if there's meaningful audio activity (Voice Activity Detection)
 * Uses RMS (Root Mean Square) of the audio signal
 */
function hasVoiceActivity() {
  if (!analyserNode) return true; // fallback: assume voice if no analyser
  
  const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
  analyserNode.getByteTimeDomainData(dataArray);
  
  // Calculate RMS
  let sumSquares = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const normalized = (dataArray[i] - 128) / 128;
    sumSquares += normalized * normalized;
  }
  const rms = Math.sqrt(sumSquares / dataArray.length);
  
  // Threshold: 0.01 is very quiet, 0.05 is moderate speech
  // Using 0.015 as threshold to catch soft speakers too
  const VOICE_THRESHOLD = 0.015;
  return rms > VOICE_THRESHOLD;
}

/**
 * Start the recording loop — record 8-second chunks with 1s gap
 * Skip chunks that are pure silence (VAD)
 */
function startRecordingLoop() {
  if (!audioStream) return;
  
  function recordChunk() {
    if (!audioStream || !audioStream.active) {
      console.log('[Offscreen] Stream no longer active');
      return;
    }

    // VAD pre-check: sample audio activity before starting recording
    const voiceDetected = hasVoiceActivity();

    if (!voiceDetected) {
      consecutiveSilent++;
      // If silent for 3+ consecutive checks (24+ seconds), still record
      // to catch the start of conversations
      if (consecutiveSilent < 3) {
        console.log('[Offscreen] Silence detected — skipping chunk');
        return;
      }
      console.log('[Offscreen] Extended silence — recording anyway to check');
    } else {
      consecutiveSilent = 0;
    }
    
    const chunks = [];
    mediaRecorder = new MediaRecorder(audioStream, {
      mimeType: 'audio/webm;codecs=opus'
    });
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    
    mediaRecorder.onstop = async () => {
      if (chunks.length > 0) {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        
        // Only process if blob has meaningful audio (> 1KB)
        if (blob.size > 1024) {
          await transcribeChunk(blob);
        }
      }
    };
    
    mediaRecorder.start();
    
    // Record for 8 seconds (down from 10s for tighter coverage)
    setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
    }, 8000);
  }
  
  // Start first chunk immediately
  recordChunk();
  
  // 9-second cycle: 8s recording + 1s processing gap (down from 12s)
  recordingInterval = setInterval(recordChunk, 9000);
}

/**
 * Send audio chunk to Whisper for transcription
 * Enhanced with prompt continuity and language caching
 */
async function transcribeChunk(audioBlob) {
  try {
    const result = await chrome.storage.local.get('openai_api_key');
    const apiKey = result.openai_api_key;
    
    if (!apiKey) {
      console.warn('[Offscreen] No API key — skipping transcription');
      return;
    }
    
    const formData = new FormData();
    formData.append('file', audioBlob, 'audio.webm');
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    
    // Language caching: after first detection, hint the language for faster/better results
    if (detectedLanguage) {
      formData.append('language', detectedLanguage);
    }
    
    // Prompt continuity: provide last transcript as context hint
    // This dramatically improves accuracy for continuing conversations
    if (lastTranscript) {
      // Whisper prompt should be <= 224 tokens, so truncate to ~500 chars
      const promptHint = lastTranscript.slice(-500);
      formData.append('prompt', promptHint);
    }
    
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData
    });
    
    if (!response.ok) {
      console.error('[Offscreen] Whisper error:', response.status);
      return;
    }
    
    const data = await response.json();
    
    if (data.text && data.text.trim()) {
      // Cache the detected language for subsequent chunks
      if (data.language && !detectedLanguage) {
        detectedLanguage = data.language;
        console.log(`[Offscreen] Language detected and cached: ${detectedLanguage}`);
      }
      
      // Store last transcript for prompt continuity
      lastTranscript = data.text;
      
      // Send transcribed text back to background
      chrome.runtime.sendMessage({
        type: 'AUDIO_TRANSCRIBED',
        text: data.text,
        language: data.language,
        duration: data.duration
      });
      
      console.log(`[Offscreen] Transcribed (${data.language}): ${data.text.substring(0, 80)}...`);
    }
  } catch (err) {
    console.error('[Offscreen] Transcription failed:', err);
  }
}

/**
 * Stop capturing audio and clean up
 */
function stopCapture() {
  if (recordingInterval) {
    clearInterval(recordingInterval);
    recordingInterval = null;
  }
  
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
  mediaRecorder = null;
  
  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop());
    audioStream = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
    analyserNode = null;
  }
  
  // Reset state
  lastTranscript = '';
  detectedLanguage = null;
  consecutiveSilent = 0;
  
  console.log('[Offscreen] Capture stopped and cleaned up');
}
