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

async function loadModels() {
  const selectEl = document.getElementById('model-select');
  if (!selectEl) return;
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

    // Set default model on select element initially
    if (availableModels[defaultModelId]) {
      selectEl.value = defaultModelId;
    } else {
      const keys = Object.keys(availableModels);
      if (keys.length > 0) {
        selectEl.value = keys[0];
      }
    }
  } catch (err) {
    console.error("Failed to load models:", err);
    selectEl.innerHTML = '<option value="">Error loading models</option>';
  }
}

function onModelChanged() {
  const selectEl = document.getElementById('model-select');
  if (selectEl && activeCascadeId) {
    selectedModels[activeCascadeId] = selectEl.value;
    console.log(`[Model] Manually switched active conversation ${activeCascadeId} to ${selectEl.value}`);
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

// Load trajectories once ready
window.addEventListener('DOMContentLoaded', async () => {
  await loadModels();
  await loadConversations();
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
  }

  // Enable text inputs
  document.getElementById('prompt-input').disabled = false;
  document.getElementById('prompt-input').placeholder = "Send message to agent...";
  document.getElementById('send-btn').disabled = false;

  // Start dynamic real-time polling
  if (pollInterval) clearInterval(pollInterval);
  lastStepsJson = '';
  lastStepsLength = 0;

  fetchActiveTrajectory();
  pollInterval = setInterval(fetchActiveTrajectory, 1500);

  toggleSidebar(false); // Close sidebar on mobile drawer
}

async function fetchActiveTrajectory() {
  if (!activeCascadeId) return;
  try {
    const response = await fetch('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cascadeId: activeCascadeId })
    });
    if (!response.ok) throw new Error('Failed to fetch trajectory');
    const data = await response.json();
    const steps = data?.trajectory?.steps || [];
    
    // Extract currently active model from trajectory config
    const metadatas = data?.trajectory?.executorMetadatas || [];
    let activeModelName = '';
    for (let i = metadatas.length - 1; i >= 0; i--) {
      if (metadatas[i]?.cascadeConfig?.plannerConfig?.modelName) {
        activeModelName = metadatas[i].cascadeConfig.plannerConfig.modelName;
        break;
      }
    }
    
    // Update model dropdown only if the user hasn't explicitly selected another model
    if (activeModelName && availableModels[activeModelName]) {
      const selectEl = document.getElementById('model-select');
      if (selectEl && !selectedModels[activeCascadeId]) {
        selectedModels[activeCascadeId] = activeModelName;
        selectEl.value = activeModelName;
      }
    }

    renderTrajectorySteps(steps);
  } catch (err) {
    console.error("Polling error:", err);
  }
}

// Step rendering parsing logic
function renderTrajectorySteps(steps) {
  const currentJson = JSON.stringify(steps);
  if (currentJson === lastStepsJson) return; // Skip DOM updates if identical
  
  lastStepsJson = currentJson;
  lastStepsLength = steps.length;

  const chatContainer = document.getElementById('chat-container');
  const isAtBottom = chatContainer.scrollHeight - chatContainer.clientHeight - chatContainer.scrollTop < 80;

  const fragment = document.createDocumentFragment();

  steps.forEach((step, index) => {
    const type = step.type;
    const status = step.status || '';

    // 1. User Inputs
    if (type === 'CORTEX_STEP_TYPE_USER_INPUT' && step.userInput) {
      const items = step.userInput.items || [];
      items.forEach(item => {
        if (item.text) {
          appendMessageRow(fragment, 'user', 'You', item.text);
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
          appendToolAccordion(fragment, tc.name, summary, 'CORTEX_STEP_STATUS_RUNNING', tc.argumentsJson, 'settings');
        });
      }
    }

    // 3. Tool Execution Details
    else if (type === 'CORTEX_STEP_TYPE_RUN_COMMAND' && step.runCommand) {
      const cmd = step.runCommand;
      const cmdLine = cmd.commandLine || '';
      const output = cmd.output || cmd.errorMessage || '';
      const detail = 'Command:\n' + cmdLine + '\n\nCwd:\n' + (cmd.cwd || '') + '\n\nExit Code:\n' + (cmd.exitCode !== undefined ? cmd.exitCode : 'Pending') + '\n\nOutput:\n' + output;
      appendToolAccordion(fragment, 'run_command', cmdLine, status, detail, 'terminal');
    }

    else if (type === 'CORTEX_STEP_TYPE_LIST_DIRECTORY' && step.listDirectory) {
      const ld = step.listDirectory;
      const path = ld.directoryPathUri || '';
      const detail = 'Directory:\n' + path + '\n\n' + (step.error ? 'Error:\n' + JSON.stringify(step.error, null, 2) : 'Listing completed.');
      appendToolAccordion(fragment, 'list_dir', path, status, detail, 'folder');
    }

    else if (type === 'CORTEX_STEP_TYPE_VIEW_FILE' && step.viewFile) {
      const vf = step.viewFile;
      const path = vf.absolutePathUri || '';
      const detail = 'File:\n' + path + '\n\nContent:\n' + (vf.content || '');
      appendToolAccordion(fragment, 'view_file', path, status, detail, 'visibility');
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
    }

    else if (type === 'CORTEX_STEP_TYPE_SEARCH_WEB' && step.searchWeb) {
      const sw = step.searchWeb;
      const detail = 'Query:\n' + sw.query + '\n\nSummary:\n' + (sw.summary || '');
      appendToolAccordion(fragment, 'search_web', sw.query, status, detail, 'language');
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
    }

    else if (type === 'CORTEX_STEP_TYPE_ERROR_MESSAGE' && step.errorMessage) {
      appendMessageRow(fragment, 'error', 'Error', step.errorMessage.message || 'An error occurred.');
    }

    else if (type === 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE' && step.systemMessage) {
      appendMessageRow(fragment, 'system', 'System', step.systemMessage.message || '');
    }
  });

  // Render items
  chatContainer.innerHTML = '';
  chatContainer.appendChild(fragment);

  // Auto scroll
  if (isAtBottom || steps.length <= 2) {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }
}

// Helper to append standard message rows
function appendMessageRow(fragment, type, sender, content, thinking) {
  const row = document.createElement('div');
  row.className = 'message-row ' + type;
  
  const avatarCol = document.createElement('div');
  avatarCol.className = 'message-avatar-col';
  const avatar = document.createElement('div');
  avatar.className = 'avatar ' + type;
  if (type === 'user') {
    avatar.textContent = 'U';
  } else if (type === 'agent') {
    avatar.textContent = '🎁';
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

  // Render body text
  if (content) {
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    if (type === 'agent') {
      bubble.innerHTML = safeParseMd(content);
      safeHighlight(bubble);
    } else {
      bubble.textContent = content;
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
  if (!prompt || !activeCascadeId || isThinking) return;

  input.value = '';
  isThinking = true;
  document.getElementById('send-btn').disabled = true;
  document.getElementById('prompt-input').disabled = true;

  const chatContainer = document.getElementById('chat-container');
  const placeholder = document.getElementById('chat-placeholder');
  if (placeholder) placeholder.remove();

  try {
    const payload = {
      cascadeId: activeCascadeId,
      items: [
        {
          text: prompt
        }
      ]
    };

    const selectEl = document.getElementById('model-select');
    if (selectEl && selectEl.value) {
      payload.selectedModel = selectEl.value;
    }

    const response = await fetch('/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error('API Error (' + response.status + '): ' + text);
    }

    // Force poll to render user prompt immediately
    await fetchActiveTrajectory();

  } catch (err) {
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
    bubble.textContent = '[Command failed] ' + err.message;
    contentCol.appendChild(bubble);
    errRow.appendChild(contentCol);

    chatContainer.appendChild(errRow);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  } finally {
    isThinking = false;
    document.getElementById('send-btn').disabled = false;
    document.getElementById('prompt-input').disabled = false;
    document.getElementById('prompt-input').focus();
  }
}
