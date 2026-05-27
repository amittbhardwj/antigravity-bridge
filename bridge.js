import express from 'express';
import { execSync, exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';

// Core initialization
const app = express();
const DEFAULT_PORT = 8080;

/**
 * Robustly detects and extracts the current active Antigravity session credentials.
 */
function getAntigravityCredentials() {
  let pid = null;
  let csrfToken = null;
  let httpPort = null;
  let httpsPort = null;

  // 1. Scan the process list for the CSRF token and PID
  try {
    const psOutput = execSync('ps aux | grep -i "[A]ntigravity"', { encoding: 'utf8' });
    const lines = psOutput.split('\n');
    for (const line of lines) {
      if (line.includes('language_server') && line.includes('--csrf_token')) {
        const csrfMatch = line.match(/--csrf_token\s+([a-f0-9\-]+)/);
        if (csrfMatch) {
          csrfToken = csrfMatch[1];
        }
        const parts = line.trim().split(/\s+/);
        if (parts.length > 1) {
          pid = parseInt(parts[1], 10);
        }
        break;
      }
    }
  } catch (err) {
    console.debug('Failed to get credentials from process list:', err.message);
  }

  // 2. Read logs to extract dynamic ports
  try {
    const logPath = path.join(os.homedir(), 'Library/Logs/Antigravity/language_server.log');
    if (fs.existsSync(logPath)) {
      const logContent = fs.readFileSync(logPath, 'utf8');
      const lines = logContent.split('\n').reverse(); // Scan bottom-up
      
      let foundHttp = false;
      let foundHttps = false;
      
      for (const line of lines) {
        if (!foundHttps) {
          const httpsMatch = line.match(/listening on random port at (\d+) for HTTPS \(gRPC\)/i);
          if (httpsMatch) {
            httpsPort = parseInt(httpsMatch[1], 10);
            foundHttps = true;
          }
        }
        if (!foundHttp) {
          const httpMatch = line.match(/listening on random port at (\d+) for HTTP/i);
          if (httpMatch) {
            httpPort = parseInt(httpMatch[1], 10);
            foundHttp = true;
          }
        }
        if (foundHttp && foundHttps) {
          break;
        }
      }
    }
  } catch (err) {
    console.debug('Failed to read logs for ports:', err.message);
  }

  // 3. Fallback: query lsof using PID if ports weren't in the logs
  if (pid && (!httpPort || !httpsPort)) {
    try {
      const lsofOutput = execSync(`lsof -a -p ${pid} -i -P`, { encoding: 'utf8' });
      const lines = lsofOutput.split('\n');
      const ports = [];
      for (const line of lines) {
        if (line.includes('localhost') && line.includes('(LISTEN)')) {
          const portMatch = line.match(/:(\d+)\s+/);
          if (portMatch) {
            ports.push(parseInt(portMatch[1], 10));
          }
        }
      }
      if (ports.length > 0) {
        ports.sort((a, b) => a - b);
        if (ports.length >= 2) {
          httpsPort = ports[0];
          httpPort = ports[1];
        } else if (ports.length === 1) {
          httpPort = ports[0];
        }
      }
    } catch (err) {
      console.debug('Failed to query lsof for ports:', err.message);
    }
  }

  return { 
    pid, 
    csrfToken, 
    httpPort, 
    httpsPort,
    running: !!(pid && csrfToken && httpPort)
  };
}

/**
 * Detects the local machine's Tailscale IPv4 address.
 */
function getTailscaleIp() {
  try {
    const ip = execSync('tailscale ip -4', { encoding: 'utf8' }).trim();
    if (ip && !ip.includes('Error')) return ip;
  } catch (err) {
    console.warn('Tailscale is not active or tailscale CLI is not in PATH.');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

// Status API
app.get('/status', (req, res) => {
  const creds = getAntigravityCredentials();
  const tailscaleIp = getTailscaleIp();
  res.json({
    bridge: {
      status: 'online',
      tailscaleIp: tailscaleIp || '127.0.0.1 (Tailscale offline)',
      port: DEFAULT_PORT
    },
    antigravity: creds
  });
});

// Projects API — serves the user's registered projects
app.get('/api/projects', (req, res) => {
  try {
    const projectsPath = path.join(os.homedir(), '.gemini/projects.json');
    if (fs.existsSync(projectsPath)) {
      const data = JSON.parse(fs.readFileSync(projectsPath, 'utf8'));
      res.json(data);
    } else {
      res.json({ projects: {} });
    }
  } catch (err) {
    console.error('Failed to load projects.json:', err.message);
    res.status(500).json({ error: 'Failed to load projects' });
  }
});

// Default project directory API
app.get('/api/default-project-dir', (req, res) => {
  const creds = getAntigravityCredentials();
  if (!creds.running) {
    return res.json({ defaultDir: path.join(os.homedir(), '.gemini/antigravity/scratch') });
  }
  // Try to get it from the backend
  fetch(`http://localhost:${creds.httpPort}/exa.language_server_pb.LanguageServerService/GetDefaultProjectDir`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Codeium-Csrf-Token': creds.csrfToken
    },
    body: JSON.stringify({})
  }).then(r => r.json()).then(data => {
    res.json({ defaultDir: data.defaultProjectDir || path.join(os.homedir(), '.gemini/antigravity/scratch') });
  }).catch(err => {
    res.json({ defaultDir: path.join(os.homedir(), '.gemini/antigravity/scratch') });
  });
});

// Wakeup API — launches the Antigravity Desktop App in the background
app.post('/api/wakeup', (req, res) => {
  console.log('[Wakeup] Received wakeup request from client...');
  // 1. Try to open the Antigravity app
  try {
    exec('open -g -a Antigravity', (err) => {
      if (err) {
        console.warn('[Wakeup Warning] Failed to run open -g -a Antigravity:', err.message);
      }
    });
  } catch (e) {
    console.warn('[Wakeup Warning] Exception trying to launch Antigravity:', e.message);
  }

  // 2. Wait 2.5 seconds, then re-check status and return it
  setTimeout(() => {
    const creds = getAntigravityCredentials();
    res.json({
      success: creds.running,
      antigravity: creds
    });
  }, 2500);
});

// Catch-All Connect RPC JSON Proxy
// Helper to buffer and parse the request body JSON
async function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        resolve(null);
      }
    });
    req.on('error', err => reject(err));
  });
}

// Loads a fallback model configuration cloned from the active setup
let defaultConfig = null;
function getDefaultConfig() {
  if (!defaultConfig) {
    try {
      const data = fs.readFileSync('config_extracted.json', 'utf8');
      defaultConfig = JSON.parse(data);
    } catch (err) {
      console.warn('Failed to load config_extracted.json fallback:', err.message);
      // Basic backup fallback
      defaultConfig = {
        plannerConfig: {
          planModel: 'MODEL_PLACEHOLDER_M132',
          requestedModel: { model: 'MODEL_PLACEHOLDER_M132' },
          modelName: 'gemini-3-flash-agent'
        }
      };
    }
  }
  return defaultConfig;
}

let cachedModels = null;
async function fetchModelsIfNeeded(creds) {
  if (cachedModels) return cachedModels;
  try {
    const url = `http://localhost:${creds.httpPort}/exa.language_server_pb.LanguageServerService/GetAvailableModels`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Codeium-Csrf-Token': creds.csrfToken
      },
      body: '{}'
    });
    if (res.ok) {
      const data = await res.json();
      cachedModels = data?.response?.models || {};
      return cachedModels;
    }
  } catch (err) {
    console.error('Failed to pre-fetch available models:', err.message);
  }
  return {};
}


// Catch-All Connect RPC Proxy
app.post('/exa.language_server_pb.LanguageServerService/:method', async (req, res) => {
  const creds = getAntigravityCredentials();
  if (!creds.running) {
    return res.status(503).json({ 
      code: 'unavailable',
      message: 'Antigravity language server is not running on the Mac.' 
    });
  }

  const url = `http://localhost:${creds.httpPort}/exa.language_server_pb.LanguageServerService/${req.params.method}`;
  console.log(`[Proxy] Routing ${req.params.method} to Go backend...`);

  try {
    let requestBody;
    let requestHeaders = {
      'Content-Type': req.headers['content-type'] || 'application/json',
      'X-Codeium-Csrf-Token': creds.csrfToken,
    };

    // If sending a message, dynamically enrich it with the active cascadeConfig
    if (req.params.method === 'SendUserCascadeMessage') {
      const parsedBody = await readBody(req);
      if (parsedBody && parsedBody.cascadeId) {
        const chosenModelName = parsedBody.selectedModel;
        delete parsedBody.selectedModel; // remove custom field before sending to Go backend
        
        if (!parsedBody.cascadeConfig) {
          try {
            const trajUrl = `http://localhost:${creds.httpPort}/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory`;
            const trajRes = await fetch(trajUrl, {
              method: 'POST',
              headers: requestHeaders,
              body: JSON.stringify({ cascadeId: parsedBody.cascadeId })
            });
            if (trajRes.ok) {
              const trajData = await trajRes.json();
              const metadatas = trajData?.trajectory?.executorMetadatas || [];
              let activeConfig = null;
              for (let i = metadatas.length - 1; i >= 0; i--) {
                if (metadatas[i]?.cascadeConfig) {
                  activeConfig = JSON.parse(JSON.stringify(metadatas[i].cascadeConfig)); // deep clone
                  break;
                }
              }
              if (activeConfig) {
                console.log(`[Enricher] Loaded cascadeConfig from existing trajectory.`);
                parsedBody.cascadeConfig = activeConfig;
              } else {
                console.log(`[Enricher] No config found in trajectory. Loading default.`);
                parsedBody.cascadeConfig = JSON.parse(JSON.stringify(getDefaultConfig())); // deep clone
              }
            } else {
              parsedBody.cascadeConfig = JSON.parse(JSON.stringify(getDefaultConfig())); // deep clone
            }
          } catch (e) {
            console.warn('[Enricher] Failed to query target trajectory:', e.message);
            parsedBody.cascadeConfig = JSON.parse(JSON.stringify(getDefaultConfig())); // deep clone
          }
        }
        
        if (chosenModelName) {
          const modelsList = await fetchModelsIfNeeded(creds);
          const modelInfo = modelsList[chosenModelName];
          if (modelInfo) {
            const modelId = modelInfo.model; // e.g. "MODEL_PLACEHOLDER_M16"
            if (parsedBody.cascadeConfig && parsedBody.cascadeConfig.plannerConfig) {
              parsedBody.cascadeConfig.plannerConfig.modelName = chosenModelName;
              parsedBody.cascadeConfig.plannerConfig.planModel = modelId;
              parsedBody.cascadeConfig.plannerConfig.requestedModel = { model: modelId };
              console.log(`[Enricher] Overrode model to ${chosenModelName} (${modelId})`);
            }
          }
        }
      }
      requestBody = JSON.stringify(parsedBody);
    } else {
      // For all other requests, pass the raw stream directly
      requestBody = req;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      duplex: 'half',
      body: requestBody
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn(`[Proxy Warning] ${req.params.method} returned status ${response.status}: ${errText}`);
      res.status(response.status);
      res.setHeader('Content-Type', 'application/json');
      res.send(errText);
      return;
    }

    // Copy backend response status and headers to client
    res.status(response.status);
    for (const [key, value] of response.headers.entries()) {
      const lowerKey = key.toLowerCase();
      if (lowerKey !== 'content-encoding' && 
          lowerKey !== 'content-length' && 
          lowerKey !== 'transfer-encoding') {
        res.setHeader(key, value);
      }
    }

    if (req.params.method === 'GetCascadeTrajectory') {
      let responseText = '';
      try {
        responseText = await response.text();
        const parsed = JSON.parse(responseText);
        if (parsed?.trajectory?.steps && parsed.trajectory.steps.length > 60) {
          const totalSteps = parsed.trajectory.steps.length;
          parsed.trajectory.steps = parsed.trajectory.steps.slice(-60);
          parsed.truncated = true;
          parsed.totalStepsCount = totalSteps;
          console.log(`[Proxy] Truncated GetCascadeTrajectory steps from ${totalSteps} to 60 for performance`);
        }
        res.send(JSON.stringify(parsed));
      } catch (e) {
        console.warn('[Proxy Warning] Failed to process GetCascadeTrajectory response:', e.message);
        res.send(responseText);
      }
    } else {
      Readable.fromWeb(response.body).pipe(res);
    }
  } catch (err) {
    console.error(`[Proxy Error] ${req.params.method}:`, err);
    res.status(500).json({ 
      code: 'internal',
      message: `Bridge proxy error: ${err.message}` 
    });
  }
});

// Serve external application JS file
app.get('/app.js', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'app.js'));
});

// Interactive Dashboard UI (Pixel-Perfect Antigravity App Replica)
app.get('/', (req, res) => {
  const creds = getAntigravityCredentials();
  const tailscaleIp = getTailscaleIp() || '127.0.0.1';

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Antigravity</title>
  
  <!-- Premium Fonts and Icons -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;750&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" />
  
  <!-- Markdown Parsing & Syntax Highlighting (async - don't block UI) -->
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js" async></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" />
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-core.min.js" async></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/plugins/autoloader/prism-autoloader.min.js" async></script>

  <style>
    :root {
      --bg-primary: #0b0d10;
      --bg-chat-canvas: #0e1318;
      --bg-sidebar: #131920;
      --bg-card: #181d24;
      --border-color: #1d242c;
      --text-primary: #f3f4f6;
      --text-muted: #64748b;
      --color-indigo: #4f46e5;
      --color-indigo-light: #6366f1;
      --color-green: #10b981;
      --color-amber: #f59e0b;
      --color-red: #ef4444;
      --font-ui: 'Outfit', sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--font-ui);
      background-color: var(--bg-primary);
      color: var(--text-primary);
      height: 100vh;
      height: 100dvh;
      width: 100vw;
      max-width: 100vw;
      display: flex;
      overflow: hidden;
    }

    /* Scrollbars custom styling */
    ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    ::-webkit-scrollbar-thumb {
      background: #232d38;
      border-radius: 3px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: #2d3b4a;
    }

    /* Layout Components */
    .sidebar {
      width: 280px;
      background-color: var(--bg-sidebar);
      border-right: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      height: 100%;
      flex-shrink: 0;
      transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      z-index: 100;
    }

    .main-container {
      flex: 1;
      display: flex;
      flex-direction: column;
      height: 100%;
      position: relative;
      background-color: var(--bg-chat-canvas);
      min-width: 0;
      width: 100%;
    }

    /* Sidebar Components */
    .sidebar-header {
      padding: 1.25rem;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
    }

    .sidebar-title {
      font-size: 1.25rem;
      font-weight: 800;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 0.6rem;
    }

    .brand-logo {
      width: 24px;
      height: 24px;
    }

    /* New Chat Button */
    .btn-new-chat {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      width: 100%;
      padding: 0.65rem 1rem;
      border-radius: 10px;
      border: 1px solid rgba(79, 70, 229, 0.25);
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.12) 0%, rgba(168, 85, 247, 0.06) 100%);
      color: #c7d2fe;
      font-family: var(--font-ui);
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
    }

    .btn-new-chat:hover {
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.2) 0%, rgba(168, 85, 247, 0.12) 100%);
      border-color: rgba(79, 70, 229, 0.45);
      color: #fff;
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(79, 70, 229, 0.15);
    }

    .btn-new-chat:active {
      transform: translateY(0);
    }

    .btn-new-chat .material-symbols-outlined {
      font-size: 1.15rem;
      color: var(--color-indigo-light);
    }

    /* Project Picker Modal */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(6px);
      z-index: 1000;
      display: none;
      align-items: center;
      justify-content: center;
      animation: fadeIn 0.2s ease;
    }

    .modal-overlay.visible {
      display: flex;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes slideUp {
      from { opacity: 0; transform: translateY(20px) scale(0.97); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .modal-card {
      background: var(--bg-sidebar);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      width: 90%;
      max-width: 480px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 25px 50px rgba(0, 0, 0, 0.5);
      animation: slideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .modal-header {
      padding: 1.25rem 1.5rem;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .modal-header h2 {
      font-size: 1.1rem;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .modal-header h2 .material-symbols-outlined {
      color: var(--color-indigo-light);
      font-size: 1.3rem;
    }

    .modal-close {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      padding: 0.25rem;
      border-radius: 6px;
      transition: all 0.15s ease;
    }

    .modal-close:hover {
      background: rgba(255, 255, 255, 0.05);
      color: #fff;
    }

    .modal-body {
      padding: 1rem 1.5rem;
      overflow-y: auto;
      flex: 1;
    }

    .modal-section-label {
      font-size: 0.7rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1.5px;
      font-weight: 700;
      margin-bottom: 0.75rem;
    }

    .project-list {
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }

    .project-item {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.15s ease;
      color: #94a3b8;
      border: 1px solid transparent;
    }

    .project-item:hover {
      background: rgba(79, 70, 229, 0.06);
      color: #fff;
      border-color: rgba(79, 70, 229, 0.15);
    }

    .project-item .material-symbols-outlined {
      font-size: 1.25rem;
      color: var(--color-indigo-light);
      flex-shrink: 0;
    }

    .project-item-details {
      flex: 1;
      min-width: 0;
    }

    .project-item-name {
      font-size: 0.9rem;
      font-weight: 600;
      color: #e2e8f0;
    }

    .project-item-path {
      font-size: 0.7rem;
      color: var(--text-muted);
      font-family: var(--font-mono);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-top: 0.15rem;
    }

    .project-divider {
      border: none;
      border-top: 1px solid var(--border-color);
      margin: 0.75rem 0;
    }

    .btn-blank-chat {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      width: 100%;
      padding: 0.75rem 1rem;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.15s ease;
      color: #94a3b8;
      border: 1px dashed rgba(255, 255, 255, 0.1);
      background: none;
      font-family: var(--font-ui);
      font-size: 0.9rem;
    }

    .btn-blank-chat:hover {
      background: rgba(255, 255, 255, 0.03);
      color: #fff;
      border-color: rgba(255, 255, 255, 0.2);
    }

    .btn-blank-chat .material-symbols-outlined {
      font-size: 1.25rem;
      color: var(--color-green);
    }

    .modal-footer {
      padding: 1rem 1.5rem;
      border-top: 1px solid var(--border-color);
      display: flex;
      justify-content: flex-end;
      gap: 0.75rem;
    }

    .modal-btn {
      padding: 0.5rem 1.25rem;
      border-radius: 8px;
      font-family: var(--font-ui);
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .modal-btn-secondary {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border-color);
      color: var(--text-muted);
    }

    .modal-btn-secondary:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
    }

    /* Loading spinner */
    .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid rgba(255, 255, 255, 0.1);
      border-top: 2px solid var(--color-indigo-light);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 1.5rem auto;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .badge-status {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.25rem 0.6rem;
      border-radius: 9999px;
      font-size: 0.7rem;
      font-weight: 600;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border-color);
      width: fit-content;
      color: #94a3b8;
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background-color: var(--color-red);
    }
    .status-dot.active {
      background-color: var(--color-green);
      box-shadow: 0 0 6px var(--color-green);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0% { opacity: 0.6; }
      50% { opacity: 1; }
      100% { opacity: 0.6; }
    }

    .connection-banner {
      background-color: rgba(239, 68, 68, 0.08);
      border-bottom: 1px solid rgba(239, 68, 68, 0.15);
      color: #fca5a5;
      padding: 0.6rem 1.25rem;
      font-size: 0.8rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
      font-weight: 500;
      animation: fadeIn 0.2s ease;
      box-sizing: border-box;
      width: 100%;
    }
    .connection-banner-btn {
      background: var(--color-red);
      color: #fff;
      border: none;
      padding: 0.3rem 0.75rem;
      border-radius: 6px;
      font-family: var(--font-ui);
      font-size: 0.75rem;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      transition: all 0.15s ease;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    .connection-banner-btn:hover {
      background: #dc2626;
      transform: scale(1.02);
    }
    .connection-banner-btn:disabled {
      background: rgba(255, 255, 255, 0.05);
      color: var(--text-muted);
      cursor: not-allowed;
    }

    .sidebar-scroll {
      flex: 1;
      overflow-y: auto;
      padding: 0.75rem;
    }

    .section-label {
      font-size: 0.7rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1.5px;
      margin: 0.5rem 0.5rem 0.75rem 0.5rem;
      font-weight: 700;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .convo-list {
      display: flex;
      flex-direction: column;
    }

    .convo-item {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 0.85rem;
      border-radius: 8px;
      margin-bottom: 0.25rem;
      cursor: pointer;
      transition: all 0.15s ease;
      color: #94a3b8;
      border-left: 3px solid transparent;
    }

    .convo-item:hover {
      background: rgba(255, 255, 255, 0.02);
      color: var(--text-primary);
    }

    .convo-item.selected {
      background: rgba(79, 70, 229, 0.09);
      color: #fff;
      font-weight: 500;
      border-left-color: var(--color-indigo);
      border-radius: 0 8px 8px 0;
    }

    .convo-icon {
      font-size: 1.25rem !important;
      color: var(--text-muted);
    }
    
    .convo-item.selected .convo-icon {
      color: var(--color-indigo-light);
    }

    .convo-details {
      flex: 1;
      min-width: 0;
    }

    .convo-name {
      font-size: 0.85rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .convo-meta {
      font-size: 0.7rem;
      color: var(--text-muted);
      margin-top: 0.15rem;
      display: flex;
      justify-content: space-between;
    }

    .btn-refresh {
      background: none;
      border: none;
      color: var(--color-indigo-light);
      cursor: pointer;
      display: flex;
      align-items: center;
    }

    /* Top Bar Components */
    .topbar {
      height: 60px;
      border-bottom: 1px solid var(--border-color);
      display: flex;
      align-items: center;
      padding: 0 1.5rem;
      justify-content: space-between;
      background: var(--bg-primary);
    }

    .topbar-left {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      min-width: 0;
      flex: 1;
    }

    .menu-btn {
      background: none;
      border: none;
      color: #fff;
      cursor: pointer;
      display: none;
      align-items: center;
      justify-content: center;
    }

    .topbar-title {
      font-size: 1rem;
      font-weight: 600;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      min-width: 0;
    }
    
    .topbar-title span {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .topbar-right {
      display: flex;
      align-items: center;
      gap: 1rem;
      flex-shrink: 0;
    }

    .mac-badge {
      font-family: var(--font-mono);
      font-size: 0.7rem;
      background: rgba(255, 255, 255, 0.02);
      padding: 0.3rem 0.6rem;
      border-radius: 4px;
      border: 1px solid var(--border-color);
      color: var(--text-muted);
    }

    .quota-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      padding: 0.35rem 0.65rem;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-primary);
      transition: all 0.2s ease;
      cursor: help;
    }
    
    .quota-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background-color: var(--color-green);
      box-shadow: 0 0 6px var(--color-green);
      display: inline-block;
    }

    .quota-dot.warning {
      background-color: var(--color-amber);
      box-shadow: 0 0 6px var(--color-amber);
    }

    .quota-dot.danger {
      background-color: var(--color-red);
      box-shadow: 0 0 6px var(--color-red);
    }

    .model-select {
      background-color: var(--bg-card);
      border: 1px solid var(--border-color);
      color: var(--text-primary);
      font-family: var(--font-ui);
      font-size: 0.8rem;
      font-weight: 500;
      padding: 0.35rem 1.8rem 0.35rem 0.75rem;
      border-radius: 6px;
      cursor: pointer;
      outline: none;
      transition: all 0.2s ease;
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%2364748b'%3E%3Cpath d='M7 10l5 5 5-5z'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 0.5rem center;
      background-size: 1.2rem;
    }

    .model-select:hover {
      border-color: rgba(99, 102, 241, 0.4);
      background-color: rgba(255, 255, 255, 0.02);
    }

    .model-select:focus {
      border-color: var(--color-indigo-light);
      box-shadow: 0 0 0 2px rgba(99, 102, 241, 0.15);
    }

    .truncation-banner {
      background-color: rgba(99, 102, 241, 0.05);
      border-bottom: 1px solid var(--border-color);
      color: var(--color-indigo-light);
      padding: 0.75rem 2rem;
      font-size: 0.8rem;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      justify-content: center;
    }

    /* Chat History Canvas */
    .chat-container {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      background-color: var(--bg-primary);
    }

    .chat-placeholder {
      margin: auto;
      text-align: center;
      max-width: 400px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1rem;
      padding: 2rem;
      color: var(--text-muted);
    }

    .chat-placeholder-icon {
      font-size: 3rem !important;
      color: var(--color-indigo);
      background: rgba(79, 70, 229, 0.08);
      padding: 1rem;
      border-radius: 50%;
    }

    .chat-placeholder h3 {
      color: #fff;
      font-size: 1.15rem;
      font-weight: 700;
    }

    .chat-placeholder p {
      font-size: 0.85rem;
      line-height: 1.5;
    }

    /* Rows and Avatars representing Antigravity Desktop style */
    .message-row {
      display: flex;
      padding: 1.25rem 2rem;
      border-bottom: 1px solid var(--border-color);
    }

    .message-row.user {
      background: rgba(79, 70, 229, 0.015);
    }

    .message-row.agent {
      background: transparent;
    }

    .message-row.system-tool {
      background: transparent;
      padding-top: 0.5rem;
      padding-bottom: 0.5rem;
      border-bottom: none;
    }
    
    .message-row.system-tool + .message-row.system-tool {
      padding-top: 0;
    }

    .message-avatar-col {
      width: 40px;
      margin-right: 12px;
      flex-shrink: 0;
    }

    .avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      font-size: 0.85rem;
      user-select: none;
    }

    .avatar.user {
      background: #232a35;
      color: var(--text-primary);
      border: 1px solid var(--border-color);
    }

    .avatar.agent {
      background: linear-gradient(135deg, var(--color-indigo) 0%, #7c3aed 100%);
      color: #fff;
      font-size: 1.1rem;
    }

    .avatar.tool {
      background: #12161f;
      color: var(--text-muted);
      border: 1px solid var(--border-color);
    }

    .avatar.system {
      background: rgba(239, 68, 68, 0.1);
      color: var(--color-red);
      border: 1px solid rgba(239, 68, 68, 0.2);
    }

    .message-content-col {
      flex: 1;
      min-width: 0; /* Important for code scroll overflow */
    }

    .message-sender-name {
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 0.4rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .message-bubble {
      font-size: 0.95rem;
      line-height: 1.6;
      color: #cbd5e1;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    /* Accordions styled exactly like Antigravity tool runs */
    .tool-accordion {
      background: var(--bg-card);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      overflow: hidden;
      margin-top: 0.25rem;
      margin-bottom: 0.25rem;
      max-width: 100%;
    }

    .tool-accordion summary {
      display: flex;
      align-items: center;
      padding: 0.6rem 0.85rem;
      cursor: pointer;
      user-select: none;
      gap: 0.6rem;
      outline: none;
      min-width: 0;
      width: 100%;
      box-sizing: border-box;
    }

    .tool-accordion summary::-webkit-details-marker {
      display: none;
    }

    .tool-accordion summary:hover {
      background: rgba(255, 255, 255, 0.02);
    }

    .tool-accordion-icon {
      color: var(--color-indigo-light);
      font-size: 1.15rem !important;
      display: flex;
      align-items: center;
      flex-shrink: 0;
    }

    .tool-accordion-title {
      font-family: var(--font-mono);
      font-size: 0.8rem;
      font-weight: 650;
      color: #e2e8f0;
      flex-shrink: 0;
    }

    .tool-accordion-subtitle {
      font-size: 0.75rem;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      min-width: 0;
    }

    .tool-accordion-status {
      margin-left: auto;
      display: flex;
      align-items: center;
    }

    .tool-status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background-color: var(--text-muted);
    }

    .tool-status-dot.success {
      background-color: var(--color-green);
      box-shadow: 0 0 6px var(--color-green);
    }

    .tool-status-dot.running {
      background-color: var(--color-amber);
      box-shadow: 0 0 6px var(--color-amber);
      animation: toolPulse 1.5s infinite;
    }

    .tool-status-dot.error {
      background-color: var(--color-red);
      box-shadow: 0 0 6px var(--color-red);
    }

    @keyframes toolPulse {
      0% { opacity: 0.4; }
      50% { opacity: 1; }
      100% { opacity: 0.4; }
    }

    .tool-accordion-body {
      padding: 0.75rem 1rem;
      background: #090b0e;
      border-top: 1px solid var(--border-color);
    }

    .tool-accordion-body pre {
      font-family: var(--font-mono);
      font-size: 0.8rem;
      color: #a7b5c6;
      white-space: pre-wrap;
      word-break: break-all;
      margin: 0;
    }

    /* Thinking Collapsible Box */
    .thinking-details {
      background: rgba(255, 255, 255, 0.015);
      border: 1px solid rgba(255, 255, 255, 0.04);
      border-radius: 6px;
      margin-bottom: 0.75rem;
      overflow: hidden;
    }

    .thinking-details summary {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.4rem 0.6rem;
      font-size: 0.75rem;
      color: var(--text-muted);
      cursor: pointer;
      user-select: none;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .thinking-details summary:hover {
      background: rgba(255, 255, 255, 0.02);
      color: var(--text-primary);
    }

    .thinking-content {
      padding: 0.6rem;
      font-size: 0.8rem;
      color: #94a3b8;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: anywhere;
      border-top: 1px solid rgba(255, 255, 255, 0.03);
      background: #090b0e;
      font-family: var(--font-mono);
    }

    /* Markdown content tags */
    .message-bubble h1, .message-bubble h2, .message-bubble h3 {
      font-weight: 700;
      margin: 0.85rem 0 0.5rem 0;
      color: #fff;
    }
    .message-bubble h1 { font-size: 1.2rem; }
    .message-bubble h2 { font-size: 1.1rem; }
    .message-bubble h3 { font-size: 1rem; }
    .message-bubble p {
      margin-bottom: 0.75rem;
    }
    .message-bubble p:last-child {
      margin-bottom: 0;
    }
    .message-bubble ul, .message-bubble ol {
      margin-left: 1.25rem;
      margin-bottom: 0.75rem;
    }
    .message-bubble li {
      margin-bottom: 0.25rem;
    }
    .message-bubble code {
      font-family: var(--font-mono);
      background: rgba(255, 255, 255, 0.06);
      padding: 0.15rem 0.35rem;
      border-radius: 4px;
      font-size: 0.85em;
      color: #e2e8f0;
    }
    .message-bubble pre {
      margin: 0.85rem 0;
      border-radius: 6px !important;
      font-size: 0.8rem !important;
      border: 1px solid var(--border-color);
      background: #090b0e !important;
      overflow-x: auto;
      max-width: 100%;
    }
    .message-bubble pre code {
      padding: 0;
      background: transparent;
      color: inherit;
      white-space: pre;
    }

    /* Table styling to prevent overflows */
    .message-bubble table {
      width: 100%;
      border-collapse: collapse;
      margin: 0.85rem 0;
      display: block;
      overflow-x: auto;
      max-width: 100%;
    }
    .message-bubble th, .message-bubble td {
      border: 1px solid var(--border-color);
      padding: 0.5rem 0.75rem;
      text-align: left;
    }
    .message-bubble th {
      background-color: rgba(255, 255, 255, 0.04);
      font-weight: 600;
      color: #fff;
    }

    /* Error Message rows style */
    .message-row.error {
      background: rgba(239, 68, 68, 0.03);
      border-bottom: 1px solid rgba(239, 68, 68, 0.1);
    }

    .message-row.error .message-bubble {
      color: #fca5a5;
      font-family: var(--font-mono);
      font-size: 0.85rem;
    }

    /* System Message rows style */
    .message-row.system {
      background: transparent;
      padding-top: 0.35rem;
      padding-bottom: 0.35rem;
      border-bottom: none;
    }
    
    .message-row.system .message-bubble {
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 0.75rem;
    }

    /* Input Footer */
    .footer {
      padding: 1rem 1.5rem;
      background: var(--bg-primary);
      border-top: 1px solid var(--border-color);
    }

    .input-wrapper {
      max-width: 800px;
      margin: 0 auto;
      display: flex;
      gap: 0.75rem;
      background: #11151d;
      border: 1px solid var(--border-color);
      padding: 0.25rem 0.5rem;
      border-radius: 20px;
      align-items: center;
    }

    .chat-input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: #fff;
      font-family: var(--font-ui);
      font-size: 0.95rem;
      padding: 0.4rem 0.85rem;
    }

    .chat-input::placeholder {
      color: var(--text-muted);
    }

    .send-btn {
      background: var(--color-indigo);
      border: none;
      color: #fff;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
      flex-shrink: 0;
    }

    .send-btn:hover:not(:disabled) {
      background: var(--color-indigo-light);
      transform: scale(1.05);
    }
    
    .send-btn:disabled {
      background: rgba(255, 255, 255, 0.04);
      color: var(--text-muted);
      cursor: not-allowed;
    }

    .image-preview-container {
      max-width: 800px;
      margin: 0 auto 0.75rem auto;
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .image-preview-card {
      position: relative;
      width: 80px;
      height: 80px;
      border-radius: 8px;
      border: 1px solid var(--border-color);
      background-size: cover;
      background-position: center;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
    }

    .image-preview-card .remove-btn {
      position: absolute;
      top: -6px;
      right: -6px;
      background: #ef4444;
      color: white;
      border: none;
      border-radius: 50%;
      width: 18px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      font-size: 11px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
      transition: background-color 0.2s;
      line-height: 1;
    }

    .image-preview-card .remove-btn:hover {
      background: #dc2626;
    }

    .attach-btn {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 0 4px 0 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.2s, transform 0.1s;
      flex-shrink: 0;
    }

    .attach-btn:hover:not(:disabled) {
      color: var(--color-indigo-light);
      transform: scale(1.05);
    }

    .attach-btn:active:not(:disabled) {
      transform: scale(0.95);
    }

    .attach-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .message-images-container {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }

    .message-image {
      max-width: 250px;
      max-height: 250px;
      border-radius: 6px;
      border: 1px solid var(--border-color);
      cursor: pointer;
      transition: opacity 0.2s;
    }

    .message-image:hover {
      opacity: 0.9;
    }

    /* Sidebar overlay for Mobile */
    .sidebar-overlay {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(2px);
      z-index: 99;
      display: none;
    }

    /* Mobile Adaptations */
    @media (max-width: 768px) {
      .sidebar {
        position: fixed;
        left: 0;
        top: 0;
        bottom: 0;
        transform: translateX(-100%);
      }
      .sidebar.open {
        transform: translateX(0);
      }
      .sidebar-overlay.visible {
        display: block;
      }
      .menu-btn {
        display: flex;
      }
      .topbar-new-chat {
        display: flex !important;
      }
      .message-row {
        padding: 1rem 1.25rem;
      }
      .footer {
        padding: 0.75rem 1rem;
      }
      .mac-badge {
        display: none;
      }
      .model-select {
        max-width: 140px;
        font-size: 0.75rem;
        padding: 0.35rem 1.4rem 0.35rem 0.5rem;
        background-position: right 0.35rem center;
        background-size: 1rem;
      }
      .topbar {
        padding: 0 1rem;
        gap: 0.5rem;
      }
      .topbar-right {
        gap: 0.5rem;
      }
    }

    /* Topbar New Chat (mobile only) */
    .topbar-new-chat {
      display: none;
      align-items: center;
      justify-content: center;
      background: var(--color-indigo);
      border: none;
      color: #fff;
      width: 32px;
      height: 32px;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }

    .topbar-new-chat:hover, .topbar-new-chat:active {
      background: var(--color-indigo-light);
      transform: scale(1.05);
    }

    /* Touch improvements */
    button, .convo-item, .project-item, .btn-blank-chat, .modal-close, .btn-new-chat {
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }

    /* Placeholder New Chat button */
    .placeholder-new-chat {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      margin-top: 0.5rem;
      padding: 0.65rem 1.5rem;
      border-radius: 12px;
      border: none;
      background: linear-gradient(135deg, var(--color-indigo) 0%, #7c3aed 100%);
      color: #fff;
      font-family: var(--font-ui);
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }

    .placeholder-new-chat:hover, .placeholder-new-chat:active {
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(79, 70, 229, 0.35);
    }

    /* ===== Approval Card Styles ===== */
    .approval-card {
      background: linear-gradient(135deg, rgba(79, 70, 229, 0.08) 0%, rgba(168, 85, 247, 0.04) 100%);
      border: 1px solid rgba(79, 70, 229, 0.25);
      border-radius: 12px;
      padding: 1rem 1.15rem;
      margin-top: 0.5rem;
      position: relative;
      overflow: hidden;
      animation: approvalSlideIn 0.35s cubic-bezier(0.16, 1, 0.3, 1);
    }

    .approval-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, var(--color-indigo), #a855f7, var(--color-indigo));
      background-size: 200% 100%;
      animation: approvalShimmer 2.5s ease-in-out infinite;
    }

    @keyframes approvalSlideIn {
      from { opacity: 0; transform: translateY(8px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    @keyframes approvalShimmer {
      0%, 100% { background-position: 200% 0; }
      50% { background-position: -200% 0; }
    }

    .approval-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.6rem;
    }

    .approval-pulse {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--color-amber);
      box-shadow: 0 0 8px var(--color-amber);
      animation: approvalPulse 1.5s ease-in-out infinite;
      flex-shrink: 0;
    }

    @keyframes approvalPulse {
      0%, 100% { opacity: 0.5; transform: scale(0.9); }
      50% { opacity: 1; transform: scale(1.15); }
    }

    .approval-label {
      font-size: 0.7rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1.2px;
      color: var(--color-amber);
    }

    .approval-title {
      font-size: 0.9rem;
      font-weight: 600;
      color: #e2e8f0;
      margin-bottom: 0.35rem;
      display: flex;
      align-items: center;
      gap: 0.45rem;
    }

    .approval-title .material-symbols-outlined {
      font-size: 1.1rem;
      color: var(--color-indigo-light);
    }

    .approval-desc {
      font-size: 0.8rem;
      color: #94a3b8;
      font-family: var(--font-mono);
      line-height: 1.5;
      margin-bottom: 0.85rem;
      white-space: pre-wrap;
      word-break: break-all;
      background: rgba(0, 0, 0, 0.2);
      padding: 0.5rem 0.65rem;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.03);
      max-height: 200px;
      overflow-y: auto;
    }

    .approval-buttons {
      display: flex;
      gap: 0.6rem;
    }

    .approval-btn {
      flex: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      padding: 0.6rem 1rem;
      border-radius: 8px;
      border: none;
      font-family: var(--font-ui);
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s ease;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }

    .approval-btn .material-symbols-outlined {
      font-size: 1.05rem;
    }

    .approval-btn-approve {
      background: linear-gradient(135deg, rgba(16, 185, 129, 0.2) 0%, rgba(16, 185, 129, 0.1) 100%);
      color: var(--color-green);
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .approval-btn-approve:hover {
      background: linear-gradient(135deg, rgba(16, 185, 129, 0.35) 0%, rgba(16, 185, 129, 0.2) 100%);
      border-color: rgba(16, 185, 129, 0.5);
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(16, 185, 129, 0.15);
    }

    .approval-btn-approve:active {
      transform: translateY(0);
    }

    .approval-btn-reject {
      background: linear-gradient(135deg, rgba(239, 68, 68, 0.12) 0%, rgba(239, 68, 68, 0.06) 100%);
      color: var(--color-red);
      border: 1px solid rgba(239, 68, 68, 0.2);
    }

    .approval-btn-reject:hover {
      background: linear-gradient(135deg, rgba(239, 68, 68, 0.25) 0%, rgba(239, 68, 68, 0.12) 100%);
      border-color: rgba(239, 68, 68, 0.4);
      transform: translateY(-1px);
      box-shadow: 0 4px 12px rgba(239, 68, 68, 0.12);
    }

    .approval-btn-reject:active {
      transform: translateY(0);
    }

    .approval-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      transform: none !important;
      box-shadow: none !important;
    }

    .approval-resolved {
      border-color: rgba(16, 185, 129, 0.2);
      background: rgba(16, 185, 129, 0.03);
    }

    .approval-resolved::before {
      display: none;
    }

    .approval-resolved .approval-pulse {
      background: var(--color-green);
      box-shadow: 0 0 6px var(--color-green);
      animation: none;
    }

    .approval-resolved .approval-label {
      color: var(--color-green);
    }

    .approval-rejected {
      border-color: rgba(239, 68, 68, 0.2);
      background: rgba(239, 68, 68, 0.03);
    }

    .approval-rejected::before {
      display: none;
    }

    .approval-rejected .approval-pulse {
      background: var(--color-red);
      box-shadow: 0 0 6px var(--color-red);
      animation: none;
    }

    .approval-rejected .approval-label {
      color: var(--color-red);
    }

    @media (max-width: 768px) {
      .approval-card {
        padding: 0.85rem 1rem;
      }
      .approval-desc {
        font-size: 0.75rem;
        max-height: 150px;
      }
      .approval-btn {
        padding: 0.55rem 0.75rem;
        font-size: 0.8rem;
      }
    }
  </style>
</head>
<body>

  <!-- Sidebar Panel -->
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <div class="sidebar-title">
        <svg class="brand-logo" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="url(#logoGrad)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M2 17L12 22L22 17" stroke="url(#logoGrad)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M2 12L12 17L22 12" stroke="url(#logoGrad)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <defs>
            <linearGradient id="logoGrad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
              <stop stop-color="#4f46e5"/>
              <stop offset="1" stop-color="#a855f7"/>
            </linearGradient>
          </defs>
        </svg>
        <span>Antigravity</span>
      </div>
      <div class="badge-status">
        <span class="status-dot ${creds.running ? 'active' : ''}"></span>
        <span>${creds.running ? 'Connected to Mac' : 'Disconnected'}</span>
      </div>
    </div>
    
    <div style="padding: 0.75rem;">
      <button class="btn-new-chat" onclick="openProjectPicker()">
        <span class="material-symbols-outlined">add_circle</span>
        <span>New Chat</span>
      </button>
    </div>
    
    <div class="sidebar-scroll">
      <div class="section-label">
        <span>Active Runs</span>
        <button class="btn-refresh" onclick="loadConversations()" title="Refresh conversations">
          <span class="material-symbols-outlined" style="font-size: 1.1rem;">refresh</span>
        </button>
      </div>
      <div class="convo-list" id="convo-list">
        <!-- Dynamic active runs get loaded here -->
      </div>
    </div>
  </div>
  
  <div class="sidebar-overlay" id="sidebar-overlay" onclick="toggleSidebar(false)"></div>

  <!-- Main Canvas -->
  <div class="main-container">
    <div class="topbar">
      <div class="topbar-left">
        <button class="menu-btn" onclick="toggleSidebar(true)">
          <span class="material-symbols-outlined">menu</span>
        </button>
        <div class="topbar-title" id="active-title">
          <span>Console Dashboard</span>
        </div>
      </div>
      
      <div class="topbar-right">
        <div id="quota-badge" class="quota-badge" style="display: none;">
          <span id="quota-dot" class="quota-dot"></span>
          <span id="quota-text"></span>
        </div>
        <select id="model-select" class="model-select" onchange="onModelChanged()">
          <option value="">Loading Models...</option>
        </select>
        <button class="topbar-new-chat" onclick="openProjectPicker()" title="New Chat">
          <span class="material-symbols-outlined" style="font-size: 1.2rem;">add</span>
        </button>
        <div class="mac-badge">Mac: ${tailscaleIp}</div>
      </div>
    </div>

    <div id="connection-banner" class="connection-banner" style="display: none;">
      <span style="display: inline-flex; align-items: center; gap: 0.45rem;">
        <span class="material-symbols-outlined" style="font-size: 1.15rem; color: var(--color-red); vertical-align: middle;">warning</span>
        <span>Disconnected from Antigravity local server.</span>
      </span>
      <button class="connection-banner-btn" onclick="wakeAntigravity()">
        <span class="material-symbols-outlined" style="font-size: 0.95rem;">power_settings_new</span>
        <span>Wake App</span>
      </button>
    </div>

    <!-- Scrollable Chat Panel -->
    <div class="chat-container" id="chat-container">
      <div class="chat-placeholder" id="chat-placeholder">
        <span class="material-symbols-outlined chat-placeholder-icon">chat_bubble_outline</span>
        <h3>No Active Conversation</h3>
        <p>Start a new chat or select an active run from the sidebar.</p>
        <button class="placeholder-new-chat" onclick="openProjectPicker()">
          <span class="material-symbols-outlined" style="font-size: 1.1rem;">add_circle</span>
          <span>New Chat</span>
        </button>
      </div>
    </div>

    <!-- Footer Input Bar -->
    <div class="footer">
      <div class="image-preview-container" id="image-preview-container" style="display: none;"></div>
      <div class="input-wrapper">
        <button class="attach-btn" id="attach-btn" onclick="triggerAttachImage()" disabled title="Attach Image">
          <span class="material-symbols-outlined" style="font-size: 1.25rem;">image</span>
        </button>
        <input type="file" id="image-attachment-input" accept="image/*" style="display: none;" onchange="handleImageFileSelected(event)">
        <input type="text" class="chat-input" id="prompt-input" placeholder="Select a conversation to type..." onkeydown="if(event.key === 'Enter') sendPrompt()" disabled>
        <button class="send-btn" id="send-btn" onclick="sendPrompt()" disabled>
          <span class="material-symbols-outlined" style="font-size: 1.15rem;">send</span>
        </button>
      </div>
    </div>
  </div>

  <!-- Project Picker Modal (must be last for z-index on mobile) -->
  <div class="modal-overlay" id="project-modal" onclick="if(event.target===this)closeProjectPicker()">
    <div class="modal-card">
      <div class="modal-header">
        <h2>
          <span class="material-symbols-outlined">rocket_launch</span>
          <span>Start New Chat</span>
        </h2>
        <button class="modal-close" onclick="closeProjectPicker()">
          <span class="material-symbols-outlined">close</span>
        </button>
      </div>
      <div class="modal-body">
        <button class="btn-blank-chat" onclick="startNewChat(null)">
          <span class="material-symbols-outlined">chat_bubble</span>
          <div>
            <div style="font-weight: 600; color: #e2e8f0;">Blank Chat</div>
            <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 0.1rem;">Start without a workspace</div>
          </div>
        </button>
        <hr class="project-divider">
        <div class="modal-section-label">Open Project</div>
        <div class="project-list" id="project-list">
          <div class="spinner"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="modal-btn modal-btn-secondary" onclick="closeProjectPicker()">Cancel</button>
      </div>
    </div>
  </div>

  <script src="/app.js"></script>
</body>
</html>
  `);
});

// Start the server
const port = DEFAULT_PORT;
const tailscaleIp = getTailscaleIp();
const host = '0.0.0.0';

app.listen(port, host, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 Antigravity Tailscale Bridge is running!`);
  console.log(`📡 Local Access:      http://127.0.0.1:${port}`);
  if (tailscaleIp) {
    console.log(`🔒 Tailscale Access:  http://${tailscaleIp}:${port}`);
  } else {
    console.log(`⚠️  Tailscale not detected. Server listening on localhost only.`);
  }
  console.log(`==================================================\n`);
});
