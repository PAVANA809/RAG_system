const chatMessages = document.getElementById('chat-messages');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const newChatBtn = document.getElementById('new-chat-btn');
const modelInfo = document.getElementById('model-info');
const collectionsInfo = document.getElementById('collections-info');

// Session management
let sessionId = localStorage.getItem('rag-session-id');
if (!sessionId) {
  sessionId = generateSessionId();
  localStorage.setItem('rag-session-id', sessionId);
}

function generateSessionId() {
  return 'sess_' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function addMessage(role, content, sources = []) {
  const div = document.createElement('div');
  div.className = `message ${role}`;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';
  contentDiv.textContent = content;
  div.appendChild(contentDiv);

  if (sources && sources.length > 0) {
    const sourcesDiv = document.createElement('div');
    sourcesDiv.className = 'message-sources';

    const label = document.createElement('span');
    label.textContent = 'Sources: ';
    label.style.opacity = '0.7';
    sourcesDiv.appendChild(label);

    sources.forEach((source) => {
      const tag = document.createElement('span');
      tag.className = 'source-tag';
      const scorePercent = source.score ? `(${(source.score * 100).toFixed(1)}%)` : '';
      tag.textContent = `${source.source} ${scorePercent}`;
      sourcesDiv.appendChild(tag);
    });

    div.appendChild(sourcesDiv);
  }

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addLoadingMessage() {
  const div = document.createElement('div');
  div.className = 'loading-message';
  div.id = 'loading-indicator';
  div.innerHTML = `
    <div class="spinner"></div>
    <span>Searching documents...</span>
  `;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return div;
}

function addErrorMessage(message) {
  const div = document.createElement('div');
  div.className = 'error-message';
  div.style.alignSelf = 'flex-start';
  div.style.maxWidth = '80%';
  div.style.marginTop = '8px';
  div.textContent = message;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function removeWelcomeMessage() {
  const welcome = chatMessages.querySelector('.welcome-message');
  if (welcome) welcome.remove();
}

async function sendMessage() {
  const message = messageInput.value.trim();
  if (!message) return;

  removeWelcomeMessage();
  addMessage('user', message);
  messageInput.value = '';
  sendBtn.disabled = true;

  const loading = addLoadingMessage();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId }),
    });

    const data = await response.json();
    loading.remove();

    if (!response.ok || data.error) {
      addErrorMessage(data.error || 'Failed to get response');
    } else {
      addMessage('assistant', data.response, data.sources);
    }
  } catch (error) {
    loading.remove();
    addErrorMessage('Network error: ' + error.message);
  } finally {
    sendBtn.disabled = false;
    messageInput.focus();
  }
}

async function startNewChat() {
  try {
    await fetch('/api/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
  } catch (error) {
    console.error('Failed to clear server history:', error);
  }

  // Generate new session
  sessionId = generateSessionId();
  localStorage.setItem('rag-session-id', sessionId);

  // Clear UI
  chatMessages.innerHTML = `
    <div class="welcome-message">
      <h3>👋 New Conversation Started!</h3>
      <p>Ask me anything about your uploaded documents. I'll search through them and give you accurate answers.</p>
    </div>
  `;
  messageInput.value = '';
  messageInput.focus();
}

async function loadHealthInfo() {
  try {
    const response = await fetch('/api/health');
    if (response.ok) {
      const data = await response.json();
      modelInfo.textContent = data.model || 'Unknown';
      collectionsInfo.textContent = Array.isArray(data.collections)
        ? data.collections.join(', ') || 'None'
        : 'Unknown';
    }
  } catch (error) {
    modelInfo.textContent = 'Unavailable';
    collectionsInfo.textContent = 'Unavailable';
  }
}

sendBtn.addEventListener('click', sendMessage);
newChatBtn.addEventListener('click', startNewChat);
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

loadHealthInfo();
messageInput.focus();
