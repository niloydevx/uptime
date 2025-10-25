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

/** In-memory state; interval handles kept here (won't be written to JSON) */
const state = {
  monitors: new Map(), // id -> { id, url, intervalMs, history[], lastStatus, lastLatency, lastChecked, enabled }
  timers: new Map()    // id -> setInterval handle
};

/** Load monitors from disk (without timers), then start them */
function loadMonitors() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (Array.isArray(raw)) {
        raw.forEach(m => {
          // ensure minimal shape
          const monitor = {
            id: m.id || nanoid(8),
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
      }
    } catch (e) {
      console.error('Failed to read monitors.json:', e.message);
    }
  }
  // start timers
  for (const m of state.monitors.values()) {
    if (m.enabled) startTimer(m.id);
  }
}

/** Persist monitors (without timer handles) */
function saveMonitors() {
  const arr = Array.from(state.monitors.values()).map(m => ({
    id: m.id,
    url: m.url,
    intervalMs: m.intervalMs,
    history: m.history.slice(-200),
    lastStatus: m.lastStatus,
    lastLatency: m.lastLatency,
    lastChecked: m.lastChecked,
    enabled: m.enabled
  }));
  fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2));
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
app.post('/api/monitors', (req, res) => {
  let { url, intervalMs } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }
  // normalize
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = 'http://' + url;
  }
  intervalMs = Number(intervalMs) || DEFAULT_INTERVAL_MS;
  if (intervalMs < 2000) intervalMs = 2000;

  const id = nanoid(8);
  const monitor = {
    id,
    url,
    intervalMs,
    history: [],
    lastStatus: null,
    lastLatency: null,
    lastChecked: null,
    enabled: true
  };
  state.monitors.set(id, monitor);
  saveMonitors();
  startTimer(id);
  res.status(201).json(monitor);
});

/** Create many monitors at once: { urls: string[], intervalMs? } */
app.post('/api/monitors/bulk', (req, res) => {
  const { urls, intervalMs } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'urls[] is required' });
  }
  const made = [];
  for (let raw of urls) {
    if (typeof raw !== 'string') continue;
    let url = raw.trim();
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    const id = nanoid(8);
    const m = {
      id,
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
  saveMonitors();
  res.status(201).json(made);
});

/** Update monitor (interval, url, enable/disable) */
app.patch('/api/monitors/:id', (req, res) => {
  const m = state.monitors.get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Not found' });
  const { url, intervalMs, enabled } = req.body || {};
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
  saveMonitors();
  if (m.enabled) startTimer(m.id); else stopTimer(m.id);
  res.json(m);
});

/** Delete monitor */
app.delete('/api/monitors/:id', (req, res) => {
  const existed = state.monitors.has(req.params.id);
  if (!existed) return res.status(404).json({ error: 'Not found' });
  stopTimer(req.params.id);
  state.monitors.delete(req.params.id);
  saveMonitors();
  res.json({ ok: true });
});

/** Health of the server itself */
app.get('/health', (_req, res) => res.json({ ok: true }));

/** Boot */
const PORT = process.env.PORT || 3000;
loadMonitors();
process.on('SIGINT', () => { saveMonitors(); process.exit(0); });
process.on('SIGTERM', () => { saveMonitors(); process.exit(0); });

app.listen(PORT, () => {
  console.log(`Uptime monitor running on http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT} to view the dashboard`);
});
