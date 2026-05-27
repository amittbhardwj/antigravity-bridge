// Fallbacks if CDN scripts haven't loaded yet
function safeParseMd(text) {
  if (typeof marked !== 'undefined' && marked.parse) return marked.parse(text);
  // Basic fallback - no regex literals or angle brackets (they break inside template HTML)
  var result = text;
  result = result.split('&').join('&amp;');
  result = result.split(String.fromCharCode(60)).join('&lt;');
  result = result.split(String.fromCharCode(62)).join('&gt;');
  result = result.split(String.fromCharCode(10)).join(String.fromCharCode(60) + 'br' + String.fromCharCode(62));
  return result;
}
function safeHighlight(el) {
  try { if (typeof Prism !== 'undefined' && Prism.highlightAllUnder) Prism.highlightAllUnder(el); } catch(e) {}
}

let activeCascadeId = '';
let isThinking = false;
let pollInterval = null;
let lastStepsJson = '';
let lastStepsLength = 0;

let availableModels = {};
let selectedModels = {}; // per-conversation model choice
let defaultModelId = '';

let optimisticMessage = null;
let activeCascadeConfigs = {};
let lastConnectionCheckTime = 0;
let lastModelLoadTime = 0;
let attachedImage = null;
let optimisticImageAttachment = null;

function updateInputStates(steps) {
  let isAgentRunning = false;
  if (steps.length > 0) {
    const lastStep = steps[steps.length - 1];
    const status = lastStep.status || '';
    // WAITING status means agent is paused for permission — don't lock the input
    if (status === 'CORTEX_STEP_STATUS_RUNNING' || status === 'running') {
      isAgentRunning = true;
    }
    if (status === 'CORTEX_STEP_STATUS_WAITING' || status === 'waiting') {
      isAgentRunning = false;
    }
  }

  const isDisabled = isThinking || isAgentRunning;
  const inputEl = document.getElementById('prompt-input');
  const btnEl = document.getElementById('send-btn');
  const attachBtn = document.getElementById('attach-btn');
  if (inputEl) {
    inputEl.disabled = isDisabled;
    if (isDisabled) {
      inputEl.placeholder = "Agent is thinking...";
    } else {
      inputEl.placeholder = "Send message to agent...";
      if (window.innerWidth > 768) {
        inputEl.focus();
      }
    }
  }
  if (btnEl) {
    btnEl.disabled = isDisabled;
  }
  if (attachBtn) {
    attachBtn.disabled = isDisabled;
  }
}

function showErrorInChat(message) {
  const chatContainer = document.getElementById('chat-container');
  if (!chatContainer) return;
  const errRow = document.createElement('div');
  errRow.className = 'message-row error';
  
  const avatarCol = document.createElement('div');
  avatarCol.className = 'message-avatar-col';
  const avatar = document.createElement('div');
  avatar.className = 'avatar system';
  avatar.innerHTML = '<span class="material-symbols-outlined" style="font-size: 1rem;">error</span>';
  avatarCol.appendChild(avatar);
  errRow.appendChild(avatarCol);

  const contentCol = document.createElement('div');
  contentCol.className = 'message-content-col';
  const senderName = document.createElement('div');
  senderName.className = 'message-sender-name';
  senderName.textContent = 'Error';
  contentCol.appendChild(senderName);

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = message;
  contentCol.appendChild(bubble);
  errRow.appendChild(contentCol);

  chatContainer.appendChild(errRow);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

let currentPollIntervalMs = 1500;

function updatePollingInterval(newIntervalMs) {
  if (currentPollIntervalMs === newIntervalMs) return;
  currentPollIntervalMs = newIntervalMs;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = setInterval(fetchActiveTrajectory, newIntervalMs);
    console.log(`[Poll] Adjusted interval to ${newIntervalMs}ms`);
  }
}

async function loadModels() {
  const selectEl = document.getElementById('model-select');
  if (!selectEl) return;
  const prevValue = selectEl.value;
  try {
    const response = await fetch('/exa.language_server_pb.LanguageServerService/GetAvailableModels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!response.ok) throw new Error('Failed to fetch available models');
    const data = await response.json();
    const models = data?.response?.models || {};
    defaultModelId = data?.response?.defaultAgentModelId || 'gemini-pro-agent';
    
    availableModels = {};
    selectEl.innerHTML = '';
    
    // Sort keys alphabetically by displayName so the dropdown list is clean
    const sortedKeys = Object.keys(models).sort((a, b) => {
      const nameA = (models[a].displayName || '').toLowerCase();
      const nameB = (models[b].displayName || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });
    
    sortedKeys.forEach(id => {
      const info = models[id];
      if (info && info.displayName) {
        availableModels[id] = info;
        const option = document.createElement('option');
        option.value = id;
        option.textContent = info.displayName;
        selectEl.appendChild(option);
      }
    });

    // Restore selection: prioritize active conversation's manual selection,
    // then the previous UI select value, then the default model.
    let modelToSet = '';
    if (activeCascadeId && selectedModels[activeCascadeId] && availableModels[selectedModels[activeCascadeId]]) {
      modelToSet = selectedModels[activeCascadeId];
    } else if (prevValue && availableModels[prevValue]) {
      modelToSet = prevValue;
    } else if (availableModels[defaultModelId]) {
      modelToSet = defaultModelId;
    } else {
      const keys = Object.keys(availableModels);
      if (keys.length > 0) {
        modelToSet = keys[0];
      }
    }
    if (modelToSet) {
      selectEl.value = modelToSet;
    }
    updateQuotaDisplay();
  } catch (err) {
    console.error("Failed to load models:", err);
    selectEl.innerHTML = '<option value="">Error loading models</option>';
  }
}

function updateQuotaDisplay() {
  const selectEl = document.getElementById('model-select');
  const badgeEl = document.getElementById('quota-badge');
  const dotEl = document.getElementById('quota-dot');
  const textEl = document.getElementById('quota-text');
  
  if (!selectEl || !badgeEl || !dotEl || !textEl) return;
  
  const selectedModelId = selectEl.value;
  const modelInfo = availableModels[selectedModelId];
  
  if (modelInfo && modelInfo.quotaInfo) {
    const fraction = modelInfo.quotaInfo.remainingFraction !== undefined ? modelInfo.quotaInfo.remainingFraction : 1.0;
    const percentLeft = Math.round(fraction * 100);
    
    textEl.textContent = `${percentLeft}% left`;
    
    dotEl.className = 'quota-dot';
    if (fraction <= 0.2) {
      dotEl.classList.add('danger');
    } else if (fraction <= 0.5) {
      dotEl.classList.add('warning');
    }
    
    if (modelInfo.quotaInfo.resetTime) {
      try {
        const resetDate = new Date(modelInfo.quotaInfo.resetTime);
        const timeStr = resetDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        badgeEl.title = `Resets at ${timeStr}`;
      } catch (e) {
        badgeEl.title = `Resets: ${modelInfo.quotaInfo.resetTime}`;
      }
    } else {
      badgeEl.title = '';
    }
    
    badgeEl.style.display = 'inline-flex';
  } else {
    badgeEl.style.display = 'none';
  }
}

function onModelChanged() {
  const selectEl = document.getElementById('model-select');
  if (selectEl && activeCascadeId) {
    selectedModels[activeCascadeId] = selectEl.value;
    console.log(`[Model] Manually switched active conversation ${activeCascadeId} to ${selectEl.value}`);
  }
  updateQuotaDisplay();
}

// ===== Image Attachment System =====
function triggerAttachImage() {
  const fileInput = document.getElementById('image-attachment-input');
  if (fileInput) fileInput.click();
}

function handleImageFileSelected(event) {
  const file = event.target.files[0];
  if (file) {
    processImageFile(file);
  }
  event.target.value = '';
}

function processImageFile(file) {
  if (!file.type.startsWith('image/')) {
    alert('Please select an image file.');
    return;
  }
  
  const attachBtn = document.getElementById('attach-btn');
  let originalHtml = '';
  if (attachBtn) {
    originalHtml = attachBtn.innerHTML;
    attachBtn.disabled = true;
    attachBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 1.15rem; animation: spin 1s linear infinite; display: inline-block;">sync</span>';
  }
  
  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      // Bounding box size: max 1200px on the longest side
      const MAX_DIM = 1200;
      let width = img.width;
      let height = img.height;
      
      if (width > MAX_DIM || height > MAX_DIM) {
        if (width > height) {
          height = Math.round((height * MAX_DIM) / width);
          width = MAX_DIM;
        } else {
          width = Math.round((width * MAX_DIM) / height);
          height = MAX_DIM;
        }
      }
      
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      
      // Compress to high-quality JPEG (85% quality)
      const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.85);
      const base64Marker = ';base64,';
      const markerIndex = compressedDataUrl.indexOf(base64Marker);
      if (markerIndex !== -1) {
        const base64Data = compressedDataUrl.substring(markerIndex + base64Marker.length);
        attachedImage = {
          base64Data: base64Data,
          mimeType: 'image/jpeg'
        };
        showImagePreview(compressedDataUrl);
      }
      
      if (attachBtn) {
        attachBtn.disabled = false;
        attachBtn.innerHTML = originalHtml;
      }
    };
    img.onerror = function() {
      alert('Failed to load image for processing.');
      if (attachBtn) {
        attachBtn.disabled = false;
        attachBtn.innerHTML = originalHtml;
      }
    };
    img.src = e.target.result;
  };
  reader.onerror = function() {
    alert('Failed to read file.');
    if (attachBtn) {
      attachBtn.disabled = false;
      attachBtn.innerHTML = originalHtml;
    }
  };
  reader.readAsDataURL(file);
}

function showImagePreview(dataUrl) {
  const container = document.getElementById('image-preview-container');
  if (!container) return;
  
  container.innerHTML = '';
  
  const card = document.createElement('div');
  card.className = 'image-preview-card';
  card.style.backgroundImage = `url(${dataUrl})`;
  
  const removeBtn = document.createElement('button');
  removeBtn.className = 'remove-btn';
  removeBtn.innerHTML = '×';
  removeBtn.title = 'Remove image';
  removeBtn.onclick = removeAttachedImage;
  
  card.appendChild(removeBtn);
  container.appendChild(card);
  container.style.display = 'flex';
}

function removeAttachedImage() {
  attachedImage = null;
  const container = document.getElementById('image-preview-container');
  if (container) {
    container.innerHTML = '';
    container.style.display = 'none';
  }
}

function handlePromptPaste(event) {
  const items = (event.clipboardData || event.originalEvent.clipboardData).items;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      processImageFile(file);
      event.preventDefault();
      break;
    }
  }
}

function handleDragOver(event) {
  event.preventDefault();
}

function handleDrop(event) {
  event.preventDefault();
  const files = event.dataTransfer.files;
  if (files.length > 0) {
    processImageFile(files[0]);
  }
}

function toggleSidebar(open) {
  const sidebar = document.getElementById('sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (open) {
    sidebar.classList.add('open');
    overlay.classList.add('visible');
  } else {
    sidebar.classList.remove('open');
    overlay.classList.remove('visible');
  }
}

// ---- New Chat / Project Picker ----
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

async function openProjectPicker() {
  const modal = document.getElementById('project-modal');
  modal.classList.add('visible');
  toggleSidebar(false);
  
  // Load projects
  const listContainer = document.getElementById('project-list');
  listContainer.innerHTML = '<div class="spinner"></div>';

  try {
    const res = await fetch('/api/projects');
    if (!res.ok) throw new Error('Failed to load projects');
    const data = await res.json();
    const projects = data.projects || {};
    const paths = Object.keys(projects);

    listContainer.innerHTML = '';

    if (paths.length === 0) {
      listContainer.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 1rem; font-size: 0.85rem;">No registered projects found.</div>';
      return;
    }

    paths.forEach(projectPath => {
      const projectName = projects[projectPath];
      const item = document.createElement('div');
      item.className = 'project-item';
      item.onclick = () => startNewChat(projectPath);
      item.innerHTML = 
        '<span class="material-symbols-outlined">folder_open</span>' +
        '<div class="project-item-details">' +
          '<div class="project-item-name">' + escapeHtml(projectName) + '</div>' +
          '<div class="project-item-path">' + escapeHtml(projectPath) + '</div>' +
        '</div>';
      listContainer.appendChild(item);
    });
  } catch (err) {
    console.error('Failed to load projects:', err);
    listContainer.innerHTML = '<div style="text-align: center; color: var(--color-red); padding: 1rem; font-size: 0.85rem;">Error loading projects: ' + err.message + '</div>';
  }
}

function closeProjectPicker() {
  document.getElementById('project-modal').classList.remove('visible');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function startNewChat(workspacePath) {
  closeProjectPicker();
  
  const chatContainer = document.getElementById('chat-container');
  chatContainer.innerHTML = '<div class="chat-placeholder"><div class="spinner"></div><p style="margin-top: 0.5rem;">Creating new conversation...</p></div>';

  const newId = generateUUID();
  const payload = { 
    cascadeId: newId,
    source: 1,
    trajectoryType: 22
  };
  
  if (workspacePath) {
    const uri = workspacePath.startsWith('file://') ? workspacePath : 'file://' + workspacePath;
    payload.workspaceUris = [uri];
  }

  try {
    const response = await fetch('/exa.language_server_pb.LanguageServerService/StartCascade', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error('StartCascade failed (' + response.status + '): ' + errText);
    }

    console.log('[NewChat] Created cascade:', newId);

    // Refresh sidebar and select the new conversation
    await loadConversations();
    const label = workspacePath ? workspacePath.split('/').pop() : 'New Chat';
    selectConversation(newId, label);

  } catch (err) {
    console.error('[NewChat] Error:', err);
    chatContainer.innerHTML = '<div class="chat-placeholder">' +
      '<span class="material-symbols-outlined chat-placeholder-icon" style="color: var(--color-red);">error</span>' +
      '<h3>Failed to create chat</h3>' +
      '<p>' + escapeHtml(err.message) + '</p>' +
      '</div>';
  }
}

// Load active runs on startup
async function loadConversations() {
  const listContainer = document.getElementById('convo-list');
  try {
    const response = await fetch('/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!response.ok) throw new Error('Failed to load trajectories');
    const data = await response.json();
    
    listContainer.innerHTML = '';
    const summaries = data.trajectorySummaries || {};
    const keys = Object.keys(summaries);
    
    if (keys.length === 0) {
      listContainer.innerHTML = '<div style="font-size: 0.8rem; color: var(--text-muted); padding: 1rem; text-align: center;">No active runs found</div>';
      return;
    }

    // Render each run item
    keys.forEach(id => {
      const s = summaries[id];
      
      const convoDiv = document.createElement('div');
      convoDiv.className = 'convo-item' + (id === activeCascadeId ? ' selected' : '');
      convoDiv.onclick = function() { selectConversation(id, s.summary || 'Untitled'); };
      
      convoDiv.innerHTML = '<span class="material-symbols-outlined convo-icon">chat</span>' +
        '<div class="convo-details">' +
          '<div class="convo-name">' + (s.summary || 'Untitled') + '</div>' +
          '<div class="convo-meta">' +
            '<span>' + (s.stepCount || 0) + ' steps</span>' +
            '<span>[' + id.substring(0, 8) + ']</span>' +
          '</div>' +
        '</div>';
      listContainer.appendChild(convoDiv);
    });

    // Auto select current trajectory if none is selected
    const defaultId = '63bb7f9f-cae1-41aa-b525-433774e577e1';
    if (!activeCascadeId) {
      if (summaries[defaultId]) {
        selectConversation(defaultId, summaries[defaultId].summary);
      } else if (keys.length > 0) {
        selectConversation(keys[0], summaries[keys[0]].summary);
      }
    }
  } catch (err) {
    console.error(err);
    listContainer.innerHTML = '<div style="font-size: 0.8rem; color: var(--color-red); padding: 1rem; text-align: center;">Error loading runs</div>';
  }
}

let isCheckingStatus = false;
async function checkConnectionStatus() {
  if (isCheckingStatus) return;
  isCheckingStatus = true;
  try {
    const res = await fetch('/status');
    if (res.ok) {
      const data = await res.json();
      const running = data?.antigravity?.running;
      
      // Update sidebar status badge
      const statusDot = document.querySelector('.badge-status .status-dot');
      const statusText = document.querySelector('.badge-status span:last-child');
      if (statusText) {
        if (running) {
          if (statusDot) statusDot.classList.add('active');
          statusText.textContent = 'Connected to Mac';
        } else {
          if (statusDot) statusDot.classList.remove('active');
          statusText.textContent = 'Disconnected';
        }
      }

      // Update main connection banner
      const banner = document.getElementById('connection-banner');
      if (banner) {
        if (running) {
          banner.style.display = 'none';
        } else {
          banner.style.display = 'flex';
        }
      }
    } else {
      const statusDot = document.querySelector('.badge-status .status-dot');
      const statusText = document.querySelector('.badge-status span:last-child');
      if (statusText) {
        if (statusDot) statusDot.classList.remove('active');
        statusText.textContent = 'Disconnected';
      }
      const banner = document.getElementById('connection-banner');
      if (banner) {
        banner.style.display = 'flex';
      }
    }
  } catch (err) {
    console.warn('Failed to fetch status:', err);
    const statusDot = document.querySelector('.badge-status .status-dot');
    const statusText = document.querySelector('.badge-status span:last-child');
    if (statusText) {
      if (statusDot) statusDot.classList.remove('active');
      statusText.textContent = 'Disconnected';
    }
    const banner = document.getElementById('connection-banner');
    if (banner) {
      banner.style.display = 'flex';
    }
  } finally {
    isCheckingStatus = false;
  }
}

let isWaking = false;
async function wakeAntigravity() {
  if (isWaking) return;
  isWaking = true;

  const btn = document.querySelector('.connection-banner-btn');
  const originalHtml = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:12px; height:12px; border-width:2px; margin:0; display:inline-block; vertical-align:middle;"></span> <span>Waking...</span>';
  }

  try {
    const res = await fetch('/api/wakeup', { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        console.log('[Wakeup] Antigravity successfully woken up!');
        await loadModels();
        await checkConnectionStatus();
        await loadConversations();
      } else {
        alert('Failed to wake Antigravity. Please make sure the app is installed and running on your Mac.');
      }
    }
  } catch (err) {
    console.error('Wakeup error:', err);
    alert('Error sending wakeup request: ' + err.message);
  } finally {
    isWaking = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }
}

// Load trajectories once ready
window.addEventListener('DOMContentLoaded', async () => {
  lastConnectionCheckTime = Date.now();
  lastModelLoadTime = Date.now();
  await checkConnectionStatus();
  await loadModels();
  await loadConversations();
  
  const promptInput = document.getElementById('prompt-input');
  if (promptInput) {
    promptInput.addEventListener('paste', handlePromptPaste);
    promptInput.addEventListener('dragover', handleDragOver);
    promptInput.addEventListener('drop', handleDrop);
  }
});

function selectConversation(id, summary) {
  activeCascadeId = id;
  document.getElementById('active-title').innerHTML = '<span class="material-symbols-outlined" style="color: var(--color-indigo-light);">chat</span><span>' + (summary || 'Untitled') + '</span>';
  
  // Update selected state in sidebar
  const items = document.querySelectorAll('.convo-item');
  items.forEach(el => {
    el.classList.remove('selected');
    if (el.innerHTML.includes(id.substring(0, 8))) {
      el.classList.add('selected');
    }
  });

  // Update model select dropdown to match the selected conversation's model
  const selectEl = document.getElementById('model-select');
  if (selectEl) {
    if (selectedModels[id]) {
      selectEl.value = selectedModels[id];
    } else if (defaultModelId) {
      selectEl.value = defaultModelId;
    }
    updateQuotaDisplay();
  }

  // Enable text inputs
  document.getElementById('prompt-input').disabled = false;
  document.getElementById('prompt-input').placeholder = "Send message to agent...";
  document.getElementById('send-btn').disabled = false;
  const attachBtn = document.getElementById('attach-btn');
  if (attachBtn) attachBtn.disabled = false;
  removeAttachedImage();

  // Start dynamic real-time polling
  if (pollInterval) clearInterval(pollInterval);
  lastStepsJson = '';
  lastStepsLength = 0;
  currentPollIntervalMs = 1500;

  fetchActiveTrajectory();
  pollInterval = setInterval(fetchActiveTrajectory, currentPollIntervalMs);

  toggleSidebar(false); // Close sidebar on mobile drawer
}

async function fetchActiveTrajectory() {
  if (!activeCascadeId) return;
  try {
    // Periodically refresh the connection status and models list (updates remaining quota)
    const now = Date.now();
    if (now - lastConnectionCheckTime >= 15000) {
      lastConnectionCheckTime = now;
      checkConnectionStatus();
    }
    if (now - lastModelLoadTime >= 60000) {
      lastModelLoadTime = now;
      loadModels();
    }

    const response = await fetch('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cascadeId: activeCascadeId })
    });
    if (!response.ok) throw new Error('Failed to fetch trajectory');
    const data = await response.json();
    const steps = data?.trajectory?.steps || [];
    
    // Check if any step is currently running or if the agent is still working
    let isAgentRunning = false;
    if (steps.length > 0) {
      const lastStep = steps[steps.length - 1];
      const status = lastStep.status || '';
      if (status === 'CORTEX_STEP_STATUS_RUNNING' || status === 'running') {
        isAgentRunning = true;
      }
    }

    // Adapt polling rate: fast when thinking/running, slow when idle to save battery & network bandwidth
    if (isThinking || isAgentRunning) {
      updatePollingInterval(400); // 400ms fast-poll
    } else {
      updatePollingInterval(2500); // 2.5s slow-poll
    }

    // Extract currently active model and config from trajectory config
    const metadatas = data?.trajectory?.executorMetadatas || [];
    let activeModelName = '';
    let activeConfig = null;
    for (let i = metadatas.length - 1; i >= 0; i--) {
      if (metadatas[i]?.cascadeConfig) {
        activeConfig = metadatas[i].cascadeConfig;
        if (metadatas[i].cascadeConfig.plannerConfig?.modelName) {
          activeModelName = metadatas[i].cascadeConfig.plannerConfig.modelName;
        }
        break;
      }
    }
    
    if (activeConfig) {
      activeCascadeConfigs[activeCascadeId] = activeConfig;
    }
    
    // Update model dropdown only if the user hasn't explicitly selected another model
    if (activeModelName && availableModels[activeModelName]) {
      const selectEl = document.getElementById('model-select');
      if (selectEl && !selectedModels[activeCascadeId]) {
        selectedModels[activeCascadeId] = activeModelName;
        selectEl.value = activeModelName;
      }
    }

    renderTrajectorySteps(steps, data);
  } catch (err) {
    console.error("Polling error:", err);
    // Reset thinking state on polling failure to unlock UI
    isThinking = false;
    updateInputStates([]);
    checkConnectionStatus();
  }
}

// Step rendering parsing logic
function renderTrajectorySteps(steps, data) {
  const truncationKey = data?.truncated ? `truncated-${data.totalStepsCount}` : 'full';
  const currentJson = JSON.stringify(steps) + '-' + truncationKey;
  if (currentJson === lastStepsJson) return; // Skip DOM updates if identical
  
  lastStepsJson = currentJson;
  lastStepsLength = steps.length;

  const chatContainer = document.getElementById('chat-container');
  const isAtBottom = chatContainer.scrollHeight - chatContainer.clientHeight - chatContainer.scrollTop < 80;

  const fragment = document.createDocumentFragment();

  // Prepend truncation banner if applicable
  if (data && data.truncated) {
    const banner = document.createElement('div');
    banner.className = 'truncation-banner';
    banner.innerHTML = '<span class="material-symbols-outlined" style="font-size: 1.1rem; vertical-align: middle;">info</span>' +
      '<span>Showing last 60 of ' + (data.totalStepsCount || steps.length) + ' steps (older history truncated for mobile performance)</span>';
    fragment.appendChild(banner);
  }

  steps.forEach((step, index) => {
    const type = step.type;
    const status = step.status || '';
    const isWaiting = (status === 'CORTEX_STEP_STATUS_WAITING' || status === 'waiting');

    // 1. User Inputs
    if (type === 'CORTEX_STEP_TYPE_USER_INPUT' && step.userInput) {
      const items = step.userInput.items || [];
      const images = step.userInput.images || [];
      items.forEach(item => {
        if (item.text || images.length > 0) {
          appendMessageRow(fragment, 'user', 'You', item.text, null, images);
        }
      });
    }

    // 2. Agent responses / Thinking / Tool calls
    else if (type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE' && step.plannerResponse) {
      const pr = step.plannerResponse;
      const text = pr.response || pr.modifiedResponse;
      
      if (text) {
        appendMessageRow(fragment, 'agent', 'Antigravity', text, pr.thinking);
      } else if (pr.thinking) {
        appendMessageRow(fragment, 'agent', 'Antigravity', '', pr.thinking);
      }

      // If tool calls are queued but not completed yet
      if (pr.toolCalls && pr.toolCalls.length > 0 && status !== 'CORTEX_STEP_STATUS_DONE') {
        pr.toolCalls.forEach(tc => {
          let summary = '';
          try {
            const args = JSON.parse(tc.argumentsJson);
            summary = args.toolSummary || args.toolAction || '';
          } catch(e) {}
          appendToolAccordion(fragment, tc.name, summary, isWaiting ? 'CORTEX_STEP_STATUS_WAITING' : 'CORTEX_STEP_STATUS_RUNNING', tc.argumentsJson, 'settings');
        });
      }

      // Render approval card if this step is WAITING for user interaction
      if (isWaiting) {
        appendApprovalCard(fragment, index, step);
      }
    }

    // 3. Tool Execution Details
    else if (type === 'CORTEX_STEP_TYPE_RUN_COMMAND' && step.runCommand) {
      const cmd = step.runCommand;
      const cmdLine = cmd.commandLine || '';
      const output = cmd.output || cmd.errorMessage || '';
      const detail = 'Command:\n' + cmdLine + '\n\nCwd:\n' + (cmd.cwd || '') + '\n\nExit Code:\n' + (cmd.exitCode !== undefined ? cmd.exitCode : 'Pending') + '\n\nOutput:\n' + output;
      appendToolAccordion(fragment, 'run_command', cmdLine, status, detail, 'terminal');
      if (isWaiting) appendApprovalCard(fragment, index, step);
    }

    else if (type === 'CORTEX_STEP_TYPE_LIST_DIRECTORY' && step.listDirectory) {
      const ld = step.listDirectory;
      const path = ld.directoryPathUri || '';
      const detail = 'Directory:\n' + path + '\n\n' + (step.error ? 'Error:\n' + JSON.stringify(step.error, null, 2) : 'Listing completed.');
      appendToolAccordion(fragment, 'list_dir', path, status, detail, 'folder');
      if (isWaiting) appendApprovalCard(fragment, index, step);
    }

    else if (type === 'CORTEX_STEP_TYPE_VIEW_FILE' && step.viewFile) {
      const vf = step.viewFile;
      const path = vf.absolutePathUri || '';
      const detail = 'File:\n' + path + '\n\nContent:\n' + (vf.content || '');
      appendToolAccordion(fragment, 'view_file', path, status, detail, 'visibility');
      if (isWaiting) appendApprovalCard(fragment, index, step);
    }

    else if (type === 'CORTEX_STEP_TYPE_GREP_SEARCH' && step.grepSearch) {
      const gs = step.grepSearch;
      const path = gs.searchPathUri || '';
      const query = gs.query || '';
      let detail = 'Search Path:\n' + path + '\n\nQuery:\n' + query + '\n\nResults:\n';
      if (gs.results && gs.results.length > 0) {
        gs.results.forEach(r => {
          detail += 'File: ' + r.relativePath + ' (Line ' + r.lineNumber + '):\n' + r.content + '\n\n';
        });
      } else {
        detail += gs.rawOutput || 'No matches found.';
      }
      appendToolAccordion(fragment, 'grep_search', query, status, detail, 'search');
      if (isWaiting) appendApprovalCard(fragment, index, step);
    }

    else if (type === 'CORTEX_STEP_TYPE_CODE_ACTION' && step.codeAction) {
      const ca = step.codeAction;
      const spec = ca.actionSpec || {};
      const desc = ca.description || '';
      let toolName = 'code_action';
      let subtitle = desc;
      let detail = '';

      if (spec.createFile) {
        toolName = 'write_to_file';
        subtitle = spec.createFile.file ? (spec.createFile.file.absoluteUri || desc) : desc;
        detail = 'Instruction:\n' + (spec.createFile.instruction || '') + '\n\nContent:\n' + (spec.createFile.content || '');
      } else if (spec.command) {
        const cmd = spec.command;
        toolName = 'replace_file_content';
        subtitle = cmd.file ? (cmd.file.absoluteUri || desc) : desc;
        detail = 'Instruction:\n' + (cmd.instruction || '') + '\n\nChanges:\n';
        if (cmd.replacementChunks) {
          cmd.replacementChunks.forEach((chunk, i) => {
            detail += 'Chunk #' + (i+1) + ':\n';
            if (chunk.startLine) detail += 'Lines ' + chunk.startLine + '-' + chunk.endLine + '\n';
            detail += 'Target Content:\n' + chunk.targetContent + '\n\nReplacement Content:\n' + chunk.replacementContent + '\n\n';
          });
        }
      }
      
      if (ca.actionResult) {
        detail += '\nResult:\n' + JSON.stringify(ca.actionResult, null, 2);
      }
      appendToolAccordion(fragment, toolName, subtitle, status, detail, 'edit');
      if (isWaiting) appendApprovalCard(fragment, index, step);
    }

    else if (type === 'CORTEX_STEP_TYPE_SEARCH_WEB' && step.searchWeb) {
      const sw = step.searchWeb;
      const detail = 'Query:\n' + sw.query + '\n\nSummary:\n' + (sw.summary || '');
      appendToolAccordion(fragment, 'search_web', sw.query, status, detail, 'language');
      if (isWaiting) appendApprovalCard(fragment, index, step);
    }

    else if (type === 'CORTEX_STEP_TYPE_ASK_QUESTION' && step.askQuestion) {
      const aq = step.askQuestion;
      let detail = '';
      if (aq.questions) {
        aq.questions.forEach(q => {
          detail += 'Question: ' + q.question + '\n\nOptions:\n';
          if (q.options) {
            q.options.forEach(o => {
              detail += '- [ ] ' + o.text + '\n';
            });
          }
        });
      }
      appendToolAccordion(fragment, 'ask_question', 'Question for User', status, detail, 'help_outline');
      if (isWaiting) appendApprovalCard(fragment, index, step);
    }

    else if (type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE' && step.errorMessage) {
      appendMessageRow(fragment, 'error', 'Error', step.errorMessage.message || 'An error occurred.');
    }

    else if (type === 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE' && step.systemMessage) {
      appendMessageRow(fragment, 'system', 'System', step.systemMessage.message || '');
    }

    // Catch-all: if ANY step type is WAITING and we didn't already render an approval card
    else if (isWaiting) {
      appendApprovalCard(fragment, index, step);
    }
  });

  // Check if server has registered our optimistic message
  if (optimisticMessage) {
    const hasOptimistic = steps.some(step => {
      if (step.type !== 'CORTEX_STEP_TYPE_USER_INPUT' || !step.userInput) return false;
      const targetText = optimisticMessage === '[Attached Image]' ? '' : optimisticMessage;
      const hasText = step.userInput.items?.some(item => (item.text || '') === targetText);
      const hasImg = optimisticImageAttachment ? (step.userInput.images && step.userInput.images.length > 0) : true;
      return hasText && hasImg;
    });
    if (hasOptimistic) {
      optimisticMessage = null; // Server has it, clear optimistic state
      optimisticImageAttachment = null;
    }
  }

  // If the server hasn't returned the optimistic message yet, append it at the end
  if (optimisticMessage) {
    appendMessageRow(fragment, 'user', 'You', optimisticMessage === '[Attached Image]' ? '' : optimisticMessage, null, optimisticImageAttachment ? [optimisticImageAttachment] : null);
  }

  // Render items
  chatContainer.innerHTML = '';
  chatContainer.appendChild(fragment);

  // Auto scroll
  if (isAtBottom || steps.length <= 2 || optimisticMessage) {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  // Update input disabled states based on steps
  updateInputStates(steps);
}

// Helper to append standard message rows
function appendMessageRow(fragment, type, sender, content, thinking, images) {
  const row = document.createElement('div');
  row.className = 'message-row ' + type;
  
  const avatarCol = document.createElement('div');
  avatarCol.className = 'message-avatar-col';
  const avatar = document.createElement('div');
  avatar.className = 'avatar ' + type;
  if (type === 'user') {
    avatar.textContent = 'U';
  } else if (type === 'agent') {
    avatar.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="width: 16px; height: 16px;">
        <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M2 17L12 22L22 17" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M2 12L12 17L22 12" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  } else if (type === 'system') {
    avatar.innerHTML = '<span class="material-symbols-outlined" style="font-size: 1rem;">settings</span>';
  } else {
    avatar.innerHTML = '<span class="material-symbols-outlined" style="font-size: 1rem;">error</span>';
  }
  avatarCol.appendChild(avatar);
  row.appendChild(avatarCol);

  const contentCol = document.createElement('div');
  contentCol.className = 'message-content-col';

  const senderName = document.createElement('div');
  senderName.className = 'message-sender-name';
  senderName.textContent = sender;
  contentCol.appendChild(senderName);

  // Render thought process
  if (thinking) {
    const thinkingDetails = document.createElement('details');
    thinkingDetails.className = 'thinking-details';
    thinkingDetails.open = true;
    const thinkingSummary = document.createElement('summary');
    thinkingSummary.innerHTML = '<span class="material-symbols-outlined" style="font-size: 0.95rem;">psychology</span><span>Thought Process</span>';
    thinkingDetails.appendChild(thinkingSummary);
    
    const thinkingContent = document.createElement('div');
    thinkingContent.className = 'thinking-content';
    thinkingContent.textContent = thinking;
    thinkingDetails.appendChild(thinkingContent);
    contentCol.appendChild(thinkingDetails);
  }

  // Render body text and images
  if (content || (images && images.length > 0)) {
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    if (content) {
      if (type === 'agent') {
        bubble.innerHTML = safeParseMd(content);
        safeHighlight(bubble);
      } else {
        bubble.textContent = content;
      }
    }
    
    if (images && images.length > 0) {
      const imagesContainer = document.createElement('div');
      imagesContainer.className = 'message-images-container';
      images.forEach(img => {
        let src = '';
        if (img.base64Data) {
          const mime = img.mimeType || 'image/png';
          src = img.base64Data.startsWith('data:') ? img.base64Data : `data:${mime};base64,${img.base64Data}`;
        } else if (img.uri) {
          src = img.uri;
        }
        
        if (src) {
          const imgEl = document.createElement('img');
          imgEl.src = src;
          imgEl.alt = img.caption || 'Attached Image';
          imgEl.className = 'message-image';
          imgEl.onclick = () => {
            const win = window.open();
            win.document.write(`<img src="${src}" style="max-width:100%; max-height:100vh; display:block; margin:auto;" />`);
          };
          imagesContainer.appendChild(imgEl);
        }
      });
      bubble.appendChild(imagesContainer);
    }
    
    contentCol.appendChild(bubble);
  }

  row.appendChild(contentCol);
  fragment.appendChild(row);
}

// Helper to append Tool Accordions matching Antigravity details
function appendToolAccordion(fragment, name, subtitle, status, detail, iconName) {
  const row = document.createElement('div');
  row.className = 'message-row system-tool';
  
  const avatarCol = document.createElement('div');
  avatarCol.className = 'message-avatar-col';
  const avatar = document.createElement('div');
  avatar.className = 'avatar tool';
  avatar.innerHTML = '<span class="material-symbols-outlined" style="font-size: 0.95rem;">construction</span>';
  avatarCol.appendChild(avatar);
  row.appendChild(avatarCol);

  const contentCol = document.createElement('div');
  contentCol.className = 'message-content-col';

  const details = document.createElement('details');
  details.className = 'tool-accordion';
  
  let statusClass = 'running';
  if (status === 'CORTEX_STEP_STATUS_DONE' || status === 'done') statusClass = 'success';
  if (status === 'CORTEX_STEP_STATUS_ERROR' || status === 'error') statusClass = 'error';

  const summary = document.createElement('summary');
  const icon = iconName || 'settings';
  
  let shortSubtitle = subtitle || '';
  if (shortSubtitle.length > 50) {
    shortSubtitle = shortSubtitle.substring(0, 47) + '...';
  }

  summary.innerHTML = '<span class="material-symbols-outlined tool-accordion-icon">' + icon + '</span>' +
    '<span class="tool-accordion-title">' + name + '</span>' +
    '<span class="tool-accordion-subtitle">' + shortSubtitle + '</span>' +
    '<div class="tool-accordion-status">' +
      '<span class="tool-status-dot ' + statusClass + '"></span>' +
    '</div>';
  details.appendChild(summary);

  const body = document.createElement('div');
  body.className = 'tool-accordion-body';
  
  const pre = document.createElement('pre');
  pre.textContent = detail;
  body.appendChild(pre);
  
  details.appendChild(body);
  contentCol.appendChild(details);
  
  row.appendChild(contentCol);
  fragment.appendChild(row);
}

// Send messages proxy
async function sendPrompt() {
  const input = document.getElementById('prompt-input');
  const prompt = input.value.trim();
  if ((!prompt && !attachedImage) || !activeCascadeId || isThinking) return;

  input.value = '';
  isThinking = true;
  
  const imageToSend = attachedImage;
  if (imageToSend) {
    optimisticImageAttachment = imageToSend;
    removeAttachedImage();
  } else {
    optimisticImageAttachment = null;
  }
  
  optimisticMessage = prompt || (imageToSend ? '[Attached Image]' : '');

  // Immediately lock UI inputs
  updateInputStates([]);

  const chatContainer = document.getElementById('chat-container');
  const placeholder = document.getElementById('chat-placeholder');
  if (placeholder) placeholder.remove();

  // Optimistically append the user prompt immediately
  const fragment = document.createDocumentFragment();
  appendMessageRow(fragment, 'user', 'You', prompt, null, imageToSend ? [imageToSend] : null);
  chatContainer.appendChild(fragment);
  chatContainer.scrollTop = chatContainer.scrollHeight;

  try {
    const payload = {
      cascadeId: activeCascadeId,
      items: [
        {
          text: prompt || ""
        }
      ]
    };

    if (imageToSend) {
      payload.images = [
        {
          base64Data: imageToSend.base64Data,
          mimeType: imageToSend.mimeType
        }
      ];
    }

    const selectEl = document.getElementById('model-select');
    if (selectEl && selectEl.value) {
      payload.selectedModel = selectEl.value;
    }

    // Attach cached cascadeConfig to bypass server-side trajectory fetch latency
    if (activeCascadeConfigs[activeCascadeId]) {
      payload.cascadeConfig = JSON.parse(JSON.stringify(activeCascadeConfigs[activeCascadeId]));
    }

    // Force fast polling immediately when a message is sent
    updatePollingInterval(400);

    // Call fetch in the background without blocking the UI thread
    fetch('/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(async (response) => {
      if (!response.ok) {
        const text = await response.text();
        showErrorInChat('API Error (' + response.status + '): ' + text);
      }
    }).catch((err) => {
      showErrorInChat('[Command failed] ' + err.message);
    }).finally(() => {
      isThinking = false;
      // Triggers polling to re-evaluate and possibly enable inputs
      fetchActiveTrajectory();
    });

  } catch (err) {
    showErrorInChat('[Setup failed] ' + err.message);
    isThinking = false;
    fetchActiveTrajectory();
  }
}

// ===== Permission Approval System =====

// Track which steps we've already submitted approvals for (to prevent double-click)
let pendingApprovals = new Set();
let resolvedApprovals = {}; // stepIndex -> 'approved' | 'rejected'

/**
 * Determines the interaction configuration based on the step's type and content.
 * Maps step fields to the correct protobuf interaction payload.
 */
function getInteractionConfig(step) {
  const type = step.type || '';
  
  // Permission requests (file read/write, command execution, MCP)
  if (step.plannerResponse && step.plannerResponse.toolCalls && step.plannerResponse.toolCalls.length > 0) {
    const tc = step.plannerResponse.toolCalls[0];
    const toolName = tc.name || '';
    let description = '';
    let icon = 'shield';
    let title = 'Permission Request';
    
    try {
      const args = JSON.parse(tc.argumentsJson || '{}');
      
      if (toolName === 'ask_permission') {
        title = 'Permission Request';
        icon = 'shield';
        const action = args.Action || 'unknown';
        const target = args.Target || '';
        const reason = args.Reason || '';
        description = 'Action: ' + action + '\nTarget: ' + target;
        if (reason) description += '\nReason: ' + reason;
        
        return {
          title: title,
          icon: icon,
          description: description,
          interactionCase: 'permission',
          approveValue: { allow: true, scope: 1 },
          rejectValue: { allow: false }
        };
      }
      
      if (toolName === 'run_command') {
        title = 'Run Command';
        icon = 'terminal';
        const cmd = args.CommandLine || '';
        const cwd = args.Cwd || '';
        description = cmd;
        if (cwd) description += '\nWorkdir: ' + cwd;
        
        return {
          title: title,
          icon: icon,
          description: description,
          interactionCase: 'runCommand',
          approveValue: { confirm: true, commandLines: [cmd] },
          rejectValue: { confirm: false, commandLines: [cmd] }
        };
      }
      
      if (toolName.startsWith('call_mcp_tool') || toolName.startsWith('mcp_')) {
        title = 'MCP Tool Call';
        icon = 'extension';
        description = 'Tool: ' + toolName;
        if (args.ServerName) description += '\nServer: ' + args.ServerName;
        if (args.ToolName) description += '\nAction: ' + args.ToolName;
        
        return {
          title: title,
          icon: icon,
          description: description,
          interactionCase: 'mcp',
          approveValue: { allow: true, scope: 1 },
          rejectValue: { allow: false }
        };
      }
      
      // Generic tool approval (write_to_file, replace_file_content, etc.)
      title = 'Approve Action';
      icon = 'verified';
      const summary = args.toolSummary || args.toolAction || toolName;
      description = summary;
      if (args.TargetFile) description += '\nFile: ' + args.TargetFile;
      if (args.Description) description += '\n' + args.Description;
      
      return {
        title: title,
        icon: icon,
        description: description,
        interactionCase: 'approvalInteraction',
        approveValue: { confirm: true },
        rejectValue: { confirm: false }
      };
      
    } catch (e) {
      console.warn('[Approval] Failed to parse tool call args:', e);
    }
  }
  
  // Run command step waiting for approval
  if (type === 'CORTEX_STEP_TYPE_RUN_COMMAND' && step.runCommand) {
    const cmdLine = step.runCommand.commandLine || '';
    return {
      title: 'Run Command',
      icon: 'terminal',
      description: cmdLine + (step.runCommand.cwd ? '\nWorkdir: ' + step.runCommand.cwd : ''),
      interactionCase: 'runCommand',
      approveValue: { confirm: true, commandLines: [cmdLine] },
      rejectValue: { confirm: false, commandLines: [cmdLine] }
    };
  }
  
  // Ask question step waiting for user response
  if (type === 'CORTEX_STEP_TYPE_ASK_QUESTION' && step.askQuestion) {
    const aq = step.askQuestion;
    let desc = '';
    if (aq.questions && aq.questions.length > 0) {
      desc = aq.questions[0].question || 'Agent has a question';
    }
    return {
      title: 'Question for You',
      icon: 'help_outline',
      description: desc,
      interactionCase: 'approvalInteraction',
      approveValue: { confirm: true },
      rejectValue: { confirm: false }
    };
  }
  
  // Code action waiting
  if (type === 'CORTEX_STEP_TYPE_CODE_ACTION' && step.codeAction) {
    const ca = step.codeAction;
    const desc = ca.description || 'Code modification';
    return {
      title: 'Approve Code Change',
      icon: 'edit',
      description: desc,
      interactionCase: 'approvalInteraction',
      approveValue: { confirm: true },
      rejectValue: { confirm: false }
    };
  }
  
  // Fallback for unknown waiting steps
  return {
    title: 'Action Pending Approval',
    icon: 'shield',
    description: 'The agent is waiting for your permission to proceed.',
    interactionCase: 'approvalInteraction',
    approveValue: { confirm: true },
    rejectValue: { confirm: false }
  };
}

/**
 * Submits an approval or rejection interaction to the Antigravity backend.
 */
async function submitUserInteraction(stepIndex, approved, step) {
  const approvalKey = activeCascadeId + '-' + stepIndex;
  if (pendingApprovals.has(approvalKey)) return; // prevent double-click
  pendingApprovals.add(approvalKey);
  
  const config = getInteractionConfig(step);
  const interactionValue = approved ? config.approveValue : config.rejectValue;
  
  const payload = {
    cascadeId: activeCascadeId,
    interaction: {
      trajectoryId: activeCascadeId,
      stepIndex: stepIndex,
      interaction: {
        case: config.interactionCase,
        value: interactionValue
      }
    }
  };
  
  console.log('[Approval] Submitting:', JSON.stringify(payload));
  
  // Update UI immediately
  resolvedApprovals[stepIndex] = approved ? 'approved' : 'rejected';
  
  // Update the card in-place without waiting for poll
  const card = document.querySelector('[data-approval-step="' + stepIndex + '"]');
  if (card) {
    card.classList.add(approved ? 'approval-resolved' : 'approval-rejected');
    const label = card.querySelector('.approval-label');
    if (label) label.textContent = approved ? 'APPROVED' : 'REJECTED';
    const btns = card.querySelector('.approval-buttons');
    if (btns) {
      btns.innerHTML = '<span style="font-size: 0.8rem; color: ' + (approved ? 'var(--color-green)' : 'var(--color-red)') + '; display: flex; align-items: center; gap: 0.4rem;">' +
        '<span class="material-symbols-outlined" style="font-size: 1rem;">' + (approved ? 'check_circle' : 'cancel') + '</span>' +
        '<span>' + (approved ? 'Permission granted' : 'Permission denied') + '</span></span>';
    }
  }
  
  try {
    const response = await fetch('/exa.language_server_pb.LanguageServerService/HandleCascadeUserInteraction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errText = await response.text();
      console.error('[Approval] Backend error:', response.status, errText);
      showErrorInChat('Approval failed (' + response.status + '): ' + errText);
    } else {
      console.log('[Approval] Successfully submitted', approved ? 'APPROVE' : 'REJECT', 'for step', stepIndex);
    }
    
    // Force fast polling to pick up the agent's reaction
    updatePollingInterval(400);
    setTimeout(() => fetchActiveTrajectory(), 500);
    
  } catch (err) {
    console.error('[Approval] Network error:', err);
    showErrorInChat('Approval request failed: ' + err.message);
  } finally {
    pendingApprovals.delete(approvalKey);
  }
}

/**
 * Renders an interactive approval card inline in the chat feed.
 */
function appendApprovalCard(fragment, stepIndex, step) {
  const config = getInteractionConfig(step);
  const resolved = resolvedApprovals[stepIndex];
  
  const row = document.createElement('div');
  row.className = 'message-row system-tool';
  
  // Avatar column
  const avatarCol = document.createElement('div');
  avatarCol.className = 'message-avatar-col';
  const avatar = document.createElement('div');
  avatar.className = 'avatar tool';
  avatar.style.borderColor = 'rgba(245, 158, 11, 0.3)';
  avatar.style.background = 'rgba(245, 158, 11, 0.08)';
  avatar.innerHTML = '<span class="material-symbols-outlined" style="font-size: 1rem; color: var(--color-amber);">' + config.icon + '</span>';
  avatarCol.appendChild(avatar);
  row.appendChild(avatarCol);
  
  // Content column
  const contentCol = document.createElement('div');
  contentCol.className = 'message-content-col';
  
  const card = document.createElement('div');
  card.className = 'approval-card' + (resolved === 'approved' ? ' approval-resolved' : '') + (resolved === 'rejected' ? ' approval-rejected' : '');
  card.setAttribute('data-approval-step', stepIndex);
  
  // Header with pulse
  const header = document.createElement('div');
  header.className = 'approval-header';
  header.innerHTML = '<span class="approval-pulse"></span>' +
    '<span class="approval-label">' + (resolved === 'approved' ? 'APPROVED' : resolved === 'rejected' ? 'REJECTED' : 'AWAITING APPROVAL') + '</span>';
  card.appendChild(header);
  
  // Title
  const title = document.createElement('div');
  title.className = 'approval-title';
  title.innerHTML = '<span class="material-symbols-outlined">' + config.icon + '</span>' +
    '<span>' + config.title + '</span>';
  card.appendChild(title);
  
  // Description
  if (config.description) {
    const desc = document.createElement('div');
    desc.className = 'approval-desc';
    desc.textContent = config.description;
    card.appendChild(desc);
  }
  
  // Buttons or resolved status
  const btnsDiv = document.createElement('div');
  btnsDiv.className = 'approval-buttons';
  
  if (resolved) {
    const isApproved = resolved === 'approved';
    btnsDiv.innerHTML = '<span style="font-size: 0.8rem; color: ' + (isApproved ? 'var(--color-green)' : 'var(--color-red)') + '; display: flex; align-items: center; gap: 0.4rem;">' +
      '<span class="material-symbols-outlined" style="font-size: 1rem;">' + (isApproved ? 'check_circle' : 'cancel') + '</span>' +
      '<span>' + (isApproved ? 'Permission granted' : 'Permission denied') + '</span></span>';
  } else {
    const approveBtn = document.createElement('button');
    approveBtn.className = 'approval-btn approval-btn-approve';
    approveBtn.innerHTML = '<span class="material-symbols-outlined">check_circle</span><span>Approve</span>';
    approveBtn.onclick = function() { submitUserInteraction(stepIndex, true, step); };
    
    const rejectBtn = document.createElement('button');
    rejectBtn.className = 'approval-btn approval-btn-reject';
    rejectBtn.innerHTML = '<span class="material-symbols-outlined">cancel</span><span>Reject</span>';
    rejectBtn.onclick = function() { submitUserInteraction(stepIndex, false, step); };
    
    btnsDiv.appendChild(approveBtn);
    btnsDiv.appendChild(rejectBtn);
  }
  
  card.appendChild(btnsDiv);
  contentCol.appendChild(card);
  row.appendChild(contentCol);
  fragment.appendChild(row);
}
