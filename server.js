const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = path.join(__dirname, 'monitors.json');
const DEFAULT_INTERVAL_MS = 5000; // 5s

// Firebase configuration
const FIREBASE_URL = "https://test-6977e-default-rtdb.firebaseio.com";
const MONITORS_PATH = "/monitors";

/** In-memory state; interval handles kept here (won't be written to Firebase) */
const state = {
  monitors: new Map(), // id -> { id, name, url, intervalMs, history[], lastStatus, lastLatency, lastChecked, enabled }
  timers: new Map()    // id -> setInterval handle
};

/** Firebase API helpers */
async function firebaseGet(path) {
  try {
    const response = await axios.get(`${FIREBASE_URL}${path}.json`);
    return response.data;
  } catch (error) {
    console.error('Firebase GET error:', error.message);
    return null;
  }
}

async function firebasePut(path, data) {
  try {
    const response = await axios.put(`${FIREBASE_URL}${path}.json`, data);
    return response.data;
  } catch (error) {
    console.error('Firebase PUT error:', error.message);
    return null;
  }
}

async function firebaseDelete(path) {
  try {
    await axios.delete(`${FIREBASE_URL}${path}.json`);
    return true;
  } catch (error) {
    console.error('Firebase DELETE error:', error.message);
    return false;
  }
}

/** Load monitors from Firebase, then start them */
async function loadMonitors() {
  try {
    const data = await firebaseGet(MONITORS_PATH);
    
    if (data && typeof data === 'object') {
      Object.values(data).forEach(m => {
        if (m && m.url) {
          // ensure minimal shape with name support
          const monitor = {
            id: m.id || nanoid(8),
            name: m.name || null,
            url: m.url,
            intervalMs: Number(m.intervalMs) > 1000 ? Number(m.intervalMs) : DEFAULT_INTERVAL_MS,
            history: Array.isArray(m.history) ? m.history.slice(-200) : [],
            lastStatus: m.lastStatus ?? null,
            lastLatency: m.lastLatency ?? null,
            lastChecked: m.lastChecked ?? null,
            enabled: m.enabled !== false
          };
          state.monitors.set(monitor.id, monitor);
        }
      });
      console.log(`Loaded ${state.monitors.size} monitors from Firebase`);
    }
  } catch (e) {
    console.error('Failed to load monitors from Firebase:', e.message);
    // Fallback to local file if Firebase fails
    loadMonitorsFromFile();
  }
  
  // start timers
  for (const m of state.monitors.values()) {
    if (m.enabled) startTimer(m.id);
  }
}

/** Fallback: Load monitors from disk */
function loadMonitorsFromFile() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (Array.isArray(raw)) {
        raw.forEach(m => {
          const monitor = {
            id: m.id || nanoid(8),
            name: m.name || null,
            url: m.url,
            intervalMs: Number(m.intervalMs) > 1000 ? Number(m.intervalMs) : DEFAULT_INTERVAL_MS,
            history: Array.isArray(m.history) ? m.history.slice(-200) : [],
            lastStatus: m.lastStatus ?? null,
            lastLatency: m.lastLatency ?? null,
            lastChecked: m.lastChecked ?? null,
            enabled: m.enabled !== false
          };
          state.monitors.set(monitor.id, monitor);
        });
        console.log(`Loaded ${state.monitors.size} monitors from local file`);
      }
    } catch (e) {
      console.error('Failed to read monitors.json:', e.message);
    }
  }
}

/** Persist monitors to Firebase */
async function saveMonitors() {
  const monitorsObj = {};
  for (const [id, monitor] of state.monitors) {
    monitorsObj[id] = {
      id: monitor.id,
      name: monitor.name,
      url: monitor.url,
      intervalMs: monitor.intervalMs,
      history: monitor.history.slice(-200),
      lastStatus: monitor.lastStatus,
      lastLatency: monitor.lastLatency,
      lastChecked: monitor.lastChecked,
      enabled: monitor.enabled
    };
  }
  
  const success = await firebasePut(MONITORS_PATH, monitorsObj);
  if (!success) {
    // Fallback to local file if Firebase fails
    saveMonitorsToFile(monitorsObj);
  }
}

/** Fallback: Save monitors to local file */
function saveMonitorsToFile(monitorsObj) {
  try {
    const arr = Object.values(monitorsObj);
    fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2));
    console.log('Saved monitors to local file (Firebase backup)');
  } catch (error) {
    console.error('Failed to save monitors to local file:', error.message);
  }
}

/** Ping a URL and record result */
async function checkOnce(monitor) {
  const started = Date.now();
  try {
    const res = await axios.get(monitor.url, {
      timeout: Math.max(2000, Math.floor(monitor.intervalMs * 0.8)), // keep timeout under interval
      validateStatus: () => true // accept all to record non-2xx too
    });
    const latency = Date.now() - started;
    const isUp = res.status >= 200 && res.status < 400;
    const point = {
      t: Date.now(),
      up: isUp,
      status: res.status,
      ms: latency
    };
    monitor.lastStatus = res.status;
    monitor.lastLatency = latency;
    monitor.lastChecked = point.t;
    monitor.history.push(point);
    if (monitor.history.length > 200) monitor.history.shift();
  } catch (err) {
    const latency = Date.now() - started;
    const point = {
      t: Date.now(),
      up: false,
      status: 0,
      ms: latency
    };
    monitor.lastStatus = 0;
    monitor.lastLatency = latency;
    monitor.lastChecked = point.t;
    monitor.history.push(point);
    if (monitor.history.length > 200) monitor.history.shift();
  }
}

/** Start or restart the interval timer for a monitor */
function startTimer(id) {
  stopTimer(id);
  const m = state.monitors.get(id);
  if (!m || !m.enabled) return;
  // immediate check, then interval
  checkOnce(m);
  const h = setInterval(() => checkOnce(m), m.intervalMs);
  state.timers.set(id, h);
}

/** Stop a monitor's interval */
function stopTimer(id) {
  const h = state.timers.get(id);
  if (h) {
    clearInterval(h);
    state.timers.delete(id);
  }
}

/** Uptime percentage from history */
function uptimeFromHistory(history) {
  if (!history || history.length === 0) return 0;
  const up = history.filter(p => p.up).length;
  return Math.round((up / history.length) * 1000) / 10; // one decimal
}

/** --------- API --------- */

/** List monitors (summary) */
app.get('/api/monitors', (req, res) => {
  const list = Array.from(state.monitors.values()).map(m => ({
    id: m.id,
    name: m.name,
    url: m.url,
    intervalMs: m.intervalMs,
    enabled: m.enabled,
    lastStatus: m.lastStatus,
    lastLatency: m.lastLatency,
    lastChecked: m.lastChecked,
    uptimePct: uptimeFromHistory(m.history)
  }));
  res.json(list);
});

/** Get one monitor (with limited history) */
app.get('/api/monitors/:id', (req, res) => {
  const m = state.monitors.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const limit = Math.min(200, Number(req.query.limit) || 100);
  res.json({
    ...m,
    history: m.history.slice(-limit)
  });
});

/** Create one monitor */
app.post('/api/monitors', async (req, res) => {
  let { name, url, intervalMs } = req.body || {};
  
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }
  
  // normalize
  name = name ? name.trim() : null;
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = 'http://' + url;
  }
  intervalMs = Number(intervalMs) || DEFAULT_INTERVAL_MS;
  if (intervalMs < 2000) intervalMs = 2000;

  const id = nanoid(8);
  const monitor = {
    id,
    name,
    url,
    intervalMs,
    history: [],
    lastStatus: null,
    lastLatency: null,
    lastChecked: null,
    enabled: true
  };
  state.monitors.set(id, monitor);
  await saveMonitors();
  startTimer(id);
  res.status(201).json(monitor);
});

/** Create many monitors at once: { urls: string[], names: string[], intervalMs? } */
app.post('/api/monitors/bulk', async (req, res) => {
  const { urls, names, intervalMs } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls[] is required' });
  }
  
  const made = [];
  for (let i = 0; i < urls.length; i++) {
    let raw = urls[i];
    if (typeof raw !== 'string') continue;
    
    let url = raw.trim();
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    
    const id = nanoid(8);
    const name = (Array.isArray(names) && names[i]) ? names[i].trim() : null;
    
    const m = {
      id,
      name,
      url,
      intervalMs: Number(intervalMs) || DEFAULT_INTERVAL_MS,
      history: [],
      lastStatus: null,
      lastLatency: null,
      lastChecked: null,
      enabled: true
    };
    state.monitors.set(id, m);
    startTimer(id);
    made.push(m);
  }
  await saveMonitors();
  res.status(201).json(made);
});

/** Update monitor (name, interval, url, enable/disable) */
app.patch('/api/monitors/:id', async (req, res) => {
  const m = state.monitors.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  
  const { name, url, intervalMs, enabled } = req.body || {};
  
  // Update name if provided (empty string or null removes the name)
  if (name !== undefined) {
    m.name = name ? name.trim() : null;
  }
  
  if (typeof url === 'string' && url.trim()) {
    m.url = /^https?:\/\//i.test(url.trim()) ? url.trim() : 'http://' + url.trim();
  }
  
  if (intervalMs !== undefined) {
    let iv = Number(intervalMs);
    if (Number.isFinite(iv) && iv >= 2000) m.intervalMs = iv;
  }
  
  if (enabled !== undefined) {
    m.enabled = !!enabled;
  }
  
  await saveMonitors();
  if (m.enabled) startTimer(m.id); else stopTimer(m.id);
  res.json(m);
});

/** Delete monitor */
app.delete('/api/monitors/:id', async (req, res) => {
  const existed = state.monitors.has(req.params.id);
  if (!existed) return res.status(404).json({ error: 'Not found' });
  stopTimer(req.params.id);
  state.monitors.delete(req.params.id);
  await saveMonitors();
  res.json({ ok: true });
});

/** Get monitor statistics */
app.get('/api/stats', (req, res) => {
  const monitors = Array.from(state.monitors.values());
  const total = monitors.length;
  const up = monitors.filter(m => m.lastStatus >= 200 && m.lastStatus < 400).length;
  const down = total - up;
  const enabled = monitors.filter(m => m.enabled).length;
  
  res.json({
    total,
    up,
    down,
    enabled,
    disabled: total - enabled
  });
});

/** Sync all monitors to Firebase (manual trigger) */
app.post('/api/sync', async (req, res) => {
  await saveMonitors();
  res.json({ ok: true, message: 'Synced to Firebase' });
});

/** Health of the server itself */
app.get('/health', (_req, res) => res.json({ ok: true }));

/** Serve the main HTML file */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/** Boot */
const PORT = process.env.PORT || 3000;

// Load monitors and start server
loadMonitors().then(() => {
  app.listen(PORT, () => {
    console.log(`Uptime monitor running on http://localhost:${PORT}`);
    console.log(`Open http://localhost:${PORT} to view the dashboard`);
    console.log(`Firebase URL: ${FIREBASE_URL}`);
  });
});

// Graceful shutdown
process.on('SIGINT', async () => { 
  await saveMonitors(); 
  process.exit(0); 
});
process.on('SIGTERM', async () => { 
  await saveMonitors(); 
  process.exit(0); 
});

make more advanced and if any url go down than instant force for up 
