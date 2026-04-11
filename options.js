// Options Script — AI Meeting Copilot

document.addEventListener('DOMContentLoaded', async () => {
  // ——— Load saved settings ———
  const config = await chrome.storage.local.get([
    'openai_api_key',
    'settings'
  ]);

  const settings = config.settings || {};

  // Populate fields
  if (config.openai_api_key) {
    document.getElementById('openai-key').value = config.openai_api_key;
  }

  // Interval slider
  const intervalSlider = document.getElementById('summary-interval');
  const intervalValue = document.getElementById('interval-value');
  intervalSlider.value = settings.summarizationInterval || 30;
  intervalValue.textContent = `${intervalSlider.value}s`;

  intervalSlider.addEventListener('input', () => {
    intervalValue.textContent = `${intervalSlider.value}s`;
  });

  // AI Model
  if (settings.aiModel) {
    document.getElementById('ai-model').value = settings.aiModel;
  }

  // Feature toggles
  document.getElementById('late-joiner-toggle').checked = settings.lateJoinerBriefing !== false;
  document.getElementById('topic-toggle').checked = settings.topicDetection !== false;
  document.getElementById('decision-toggle').checked = settings.decisionDetection !== false;
  document.getElementById('action-toggle').checked = settings.actionExtraction !== false;
  document.getElementById('sentiment-toggle').checked = settings.sentimentAnalysis !== false;

  // ——— Toggle password visibility ———
  document.querySelectorAll('.toggle-vis').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      target.type = target.type === 'password' ? 'text' : 'password';
    });
  });

  // ——— Save ———
  document.getElementById('save-btn').addEventListener('click', async () => {
    const openaiKey = document.getElementById('openai-key').value.trim();

    const newSettings = {
      summarizationInterval: parseInt(intervalSlider.value),
      aiModel: document.getElementById('ai-model').value,
      lateJoinerBriefing: document.getElementById('late-joiner-toggle').checked,
      topicDetection: document.getElementById('topic-toggle').checked,
      decisionDetection: document.getElementById('decision-toggle').checked,
      actionExtraction: document.getElementById('action-toggle').checked,
      sentimentAnalysis: document.getElementById('sentiment-toggle').checked
    };

    const saveData = { settings: newSettings };
    
    if (openaiKey) saveData.openai_api_key = openaiKey;

    await chrome.storage.local.set(saveData);

    // Show success
    const status = document.getElementById('save-status');
    status.textContent = '✓ Settings saved successfully!';
    status.classList.add('visible');
    
    setTimeout(() => {
      status.classList.remove('visible');
    }, 3000);
  });
});
