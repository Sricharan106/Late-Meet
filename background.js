// Make sure you import the API utility at the top of background.js if it's a module
// import { chatCompletion, getApiKey } from './utils/api.js';

// Add this function to handle the OpenAI generation
async function generateLateJoinerMessage(joinerName) {
  // Assuming MeetingState is accessible in the background script context
  const context = typeof MeetingState !== 'undefined' ? MeetingState.getLateJoinerContext() : { duration: 0, currentTopic: 'general discussions' };
  
  const prompt = `
    You are an AI meeting assistant. A participant named "${joinerName}" just joined the meeting late. 
    The meeting has been running for ${Math.round(context.duration / 60)} minutes.
    
    Current Topic: ${context.currentTopic || 'General discussion'}
    Recent Topics: ${context.topics && context.topics.length ? JSON.stringify(context.topics) : 'None yet'}
    Decisions made: ${context.decisions && context.decisions.length ? JSON.stringify(context.decisions) : 'None yet'}
    
    Write a short, friendly message to be sent in the meeting chat box to welcome them and tell them what they missed.
    Do NOT use markdown. Keep it under 3 sentences. Address them by name.
    Do NOT output JSON. Output ONLY the raw message string.
    
    Example: "Hi John! Welcome to the call. So far we've discussed the Q3 roadmap and decided to delay the launch to August. We are currently talking about marketing budgets."
  `;

  try {
    const apiKey = await getApiKey(); // Ensure you have this function available
    if (!apiKey) throw new Error("API Key missing");

    // We bypass the strict JSON formatting for this specific prompt since we just need a string for the chat
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        max_tokens: 150
      })
    });

    if (!response.ok) throw new Error("Failed to fetch from OpenAI");
    const data = await response.json();
    return data.choices[0].message.content.trim();
  } catch (error) {
    console.error("Failed to generate late joiner message:", error);
    // Robust fallback if API fails
    return `Hi ${joinerName}, welcome to the meeting! We are currently discussing: ${context.currentTopic || 'project updates'}.`;
  }
}

// Add this listener or merge it into your existing onMessage listener
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PARTICIPANTS_UPDATED') {
    if (typeof MeetingState !== 'undefined') {
      const newJoiners = MeetingState.updateParticipants(message.participants);
      
      // Only welcome if meeting is > 60 seconds to prevent lobby spam
      if (newJoiners.length > 0 && MeetingState.getDuration() > 60) {
        newJoiners.forEach(joinerName => {
          if (joinerName.includes('You')) return; // Don't welcome yourself
          
          console.log(`[MeetingCopilot] Late joiner detected: ${joinerName}. Generating brief...`);
          
          generateLateJoinerMessage(joinerName).then(chatMessage => {
            if (sender.tab && sender.tab.id) {
               chrome.tabs.sendMessage(sender.tab.id, {
                 type: 'SEND_CHAT_MESSAGE',
                 text: chatMessage
               });
            }
          });
        });
      }
    }
  }
  // Keep your other message handlers here...
});
