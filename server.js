const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const CONFIG_PATH = path.join(__dirname, 'config.json');
const TODOS_PATH  = path.join(__dirname, 'todos.json');

// Memory dir matches where Claude Code reads from — keyed to home dir since that's the CWD we spawn Claude with
const MEMORY_DIR = path.join(
  os.homedir(), '.claude', 'projects',
  os.homedir().replace(/\//g, '-'),
  'memory'
);

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const def = { projects: [], port: 3000 };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(def, null, 2));
    return def;
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Config
app.get('/api/config', (req, res) => res.json(loadConfig()));
app.post('/api/config', (req, res) => {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

// Git status
app.get('/api/git', (req, res) => {
  const { project } = req.query;
  if (!project) return res.status(400).json({ error: 'No project specified' });
  if (!fs.existsSync(project)) return res.status(400).json({ error: 'Path not found' });
  try {
    const run = (cmd) => execSync(cmd, { cwd: project, timeout: 5000 }).toString().trim();
    res.json({
      branch: run('git rev-parse --abbrev-ref HEAD'),
      log:    run('git log --oneline -5'),
      status: run('git status --short'),
    });
  } catch (e) {
    res.status(500).json({ error: e.stderr?.toString() || e.message });
  }
});

// CLAUDE.md — reads project CLAUDE.md or ~/CLAUDE.md if no project
app.get('/api/claude-md', (req, res) => {
  const { project } = req.query;
  const p = project ? path.join(project, 'CLAUDE.md') : path.join(os.homedir(), 'CLAUDE.md');
  res.json({ content: fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '', path: p });
});

app.post('/api/claude-md', (req, res) => {
  const { project, content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'No content' });
  const p = project ? path.join(project, 'CLAUDE.md') : path.join(os.homedir(), 'CLAUDE.md');
  fs.writeFileSync(p, content);
  res.json({ ok: true });
});

// Memory — reads/writes ~/.claude/projects/[this-project]/memory/
app.get('/api/memory', (req, res) => {
  if (!fs.existsSync(MEMORY_DIR)) return res.json({ entries: [] });
  const indexPath = path.join(MEMORY_DIR, 'MEMORY.md');
  if (!fs.existsSync(indexPath)) return res.json({ entries: [] });
  const entries = [];
  for (const line of fs.readFileSync(indexPath, 'utf8').split('\n')) {
    const m = line.match(/^- \[(.+?)\]\((.+?)\) — (.+)/);
    if (!m) continue;
    const [, title, file, description] = m;
    let content = '';
    try { content = fs.readFileSync(path.join(MEMORY_DIR, file), 'utf8'); } catch {}
    entries.push({ title, file, description, content });
  }
  res.json({ entries });
});

app.post('/api/memory', (req, res) => {
  const { description, type = 'project', content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });

  const desc = (description || content.slice(0, 60)).replace(/\n/g, ' ').trim();
  const slug = desc.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const filename = `${type}_${slug}_${Date.now()}.md`;

  fs.writeFileSync(
    path.join(MEMORY_DIR, filename),
    `---\nname: ${slug}\ndescription: ${desc}\nmetadata:\n  type: ${type}\n---\n\n${content}\n`
  );

  const indexPath = path.join(MEMORY_DIR, 'MEMORY.md');
  const line = `- [${desc.slice(0, 60)}](${filename}) — ${desc}`;
  if (fs.existsSync(indexPath)) {
    fs.appendFileSync(indexPath, '\n' + line);
  } else {
    fs.writeFileSync(indexPath, `# Memory Index\n\n${line}\n`);
  }

  res.json({ ok: true, file: filename });
});

app.delete('/api/memory/:file', (req, res) => {
  const file = path.basename(req.params.file); // prevent path traversal
  const fp = path.join(MEMORY_DIR, file);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  const indexPath = path.join(MEMORY_DIR, 'MEMORY.md');
  if (fs.existsSync(indexPath)) {
    const updated = fs.readFileSync(indexPath, 'utf8').split('\n')
      .filter(l => !l.includes(`(${file})`)).join('\n');
    fs.writeFileSync(indexPath, updated);
  }
  res.json({ ok: true });
});

// Recent sessions — scans ~/.claude/projects/*/  JSONL files
app.get('/api/recent', (req, res) => {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const sessions = [];
  if (!fs.existsSync(projectsDir)) return res.json({ sessions: [] });
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir); } catch {}

  for (const dirName of dirs) {
    const dirPath = path.join(projectsDir, dirName);
    try { if (!fs.statSync(dirPath).isDirectory()) continue; } catch { continue; }
    let files = [];
    try { files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl')); } catch { continue; }

    for (const file of files) {
      try {
        const lines = fs.readFileSync(path.join(dirPath, file), 'utf8')
          .trim().split('\n').filter(Boolean);
        let firstUser = null, lastTs = null;
        for (const line of lines) {
          let e; try { e = JSON.parse(line); } catch { continue; }
          if (e.timestamp) lastTs = e.timestamp;
          if (!firstUser && e.type === 'user') {
            const c = e.message?.content;
            firstUser = (typeof c === 'string' ? c : c?.[0]?.text || '').slice(0, 120);
          }
        }
        if (lastTs) {
          // Best-effort: last dash-segment of encoded path is the project folder name
          const parts = dirName.split('-').filter(Boolean);
          sessions.push({
            projectName: parts[parts.length - 1] || dirName,
            dirName,
            lastTs,
            firstMessage: firstUser || '',
          });
        }
      } catch {}
    }
  }

  sessions.sort((a, b) => new Date(b.lastTs) - new Date(a.lastTs));
  res.json({ sessions: sessions.slice(0, 30) });
});

// ── Skills ────────────────────────────────────────────────────────────────────

const SKILLS_DIR = path.join(os.homedir(), 'skills');
if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });

app.get('/api/skills', (req, res) => {
  const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md')).sort();
  res.json(files.map(f => ({ name: f.replace(/\.md$/, '') })));
});

app.get('/api/skills/:name', (req, res) => {
  const p = path.join(SKILLS_DIR, req.params.name + '.md');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Not found' });
  res.json({ content: fs.readFileSync(p, 'utf8') });
});

app.post('/api/skills/:name', (req, res) => {
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'No content' });
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!name) return res.status(400).json({ error: 'Invalid name' });
  fs.writeFileSync(path.join(SKILLS_DIR, name + '.md'), content);
  res.json({ ok: true });
});

app.delete('/api/skills/:name', (req, res) => {
  const p = path.join(SKILLS_DIR, req.params.name + '.md');
  if (fs.existsSync(p)) fs.unlinkSync(p);
  res.json({ ok: true });
});

// ── Todos ─────────────────────────────────────────────────────────────────────

function loadTodos() {
  try { return fs.existsSync(TODOS_PATH) ? JSON.parse(fs.readFileSync(TODOS_PATH, 'utf8')) : []; }
  catch { return []; }
}
function saveTodos(todos) { fs.writeFileSync(TODOS_PATH, JSON.stringify(todos, null, 2)); }

app.get('/api/todos', (req, res) => res.json(loadTodos()));

app.post('/api/todos', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const todos = loadTodos();
  const todo = { id: Date.now(), text, done: false, createdAt: new Date().toISOString() };
  todos.push(todo);
  saveTodos(todos);
  res.json(todo);
});

app.patch('/api/todos/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const todos = loadTodos();
  const todo = todos.find(t => t.id === id);
  if (!todo) return res.status(404).json({ error: 'not found' });
  Object.assign(todo, req.body);
  saveTodos(todos);
  res.json(todo);
});

app.delete('/api/todos/:id', (req, res) => {
  saveTodos(loadTodos().filter(t => t.id !== parseInt(req.params.id)));
  res.json({ ok: true });
});

// ── Terminal input injection ───────────────────────────────────────────────────

app.post('/api/terminal/send', (req, res) => {
  const { termNum = 1, text } = req.body;
  const sess = SESSIONS[termNum];
  if (!sess?.term) return res.status(400).json({ error: 'terminal not running' });
  sess.term.write(text);
  res.json({ ok: true });
});

// Mark current buffer position so we can capture everything written after
const recapMarks = {};

app.post('/api/terminal/mark', (req, res) => {
  const { termNum = 1 } = req.body;
  recapMarks[termNum] = SESSIONS[termNum]?.buf?.length || 0;
  res.json({ ok: true });
});

app.get('/api/terminal/capture', (req, res) => {
  const termNum = parseInt(req.query.termNum || 1);
  const mark = recapMarks[termNum] || 0;
  const buf = SESSIONS[termNum]?.buf || '';
  res.json({ content: buf.slice(mark) });
});

// ── Persistent terminal sessions ──────────────────────────────────────────────

const MAX_BUF = 150 * 1024;

const SESSIONS = {
  1: { term: null, buf: '', ws: null, cols: 80, rows: 24 },
  2: { term: null, buf: '', ws: null, cols: 80, rows: 24 },
};

function spawnSession(termNum) {
  const sess = SESSIONS[termNum];
  const cfg = loadConfig();
  const cwd = os.homedir();
  const shell = process.env.SHELL || '/bin/bash';

  const trySpawn = (cmd) => pty.spawn(cmd, [], {
    name: 'xterm-256color',
    cols: sess.cols,
    rows: sess.rows,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', PATH: `${process.env.PATH}:${os.homedir()}/.local/bin` },
  });

  try {
    if (termNum === 1) {
      sess.term = pty.spawn('claude', ['--dangerously-skip-permissions'], {
        name: 'xterm-256color', cols: sess.cols, rows: sess.rows, cwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', PATH: `${process.env.PATH}:${os.homedir()}/.local/bin` },
      });
    } else {
      sess.term = trySpawn(shell);
    }
  } catch (err) {
    if (termNum === 1) {
      try {
        sess.term = trySpawn(shell);
        const warn = `\r\n\x1b[33m'claude' not found — using ${shell}\x1b[0m\r\n`;
        sess.buf += warn;
        if (sess.ws?.readyState === 1) sess.ws.send(warn);
      } catch { return false; }
    } else { return false; }
  }

  sess.term.onData(data => {
    sess.buf += data;
    if (sess.buf.length > MAX_BUF) sess.buf = sess.buf.slice(sess.buf.length - MAX_BUF);
    if (sess.ws?.readyState === 1) sess.ws.send(data);
  });

  sess.term.onExit(({ exitCode }) => {
    if (termNum === 1 && !heartbeatFired) saveRawBuffer('unexpected-exit');
    sess.term = null;
    const msg = `\r\n\x1b[33m[exited with code ${exitCode}]\x1b[0m\r\n`;
    sess.buf += msg;
    if (sess.ws?.readyState === 1) sess.ws.send(msg);
  });

  return true;
}

wss.on('connection', (ws, req) => {
  const termNum = req.url === '/terminal/2' ? 2 : 1;
  const sess = SESSIONS[termNum];

  sess.ws = ws;

  if (!sess.term) {
    if (!spawnSession(termNum)) {
      ws.send('\r\n\x1b[31mFailed to spawn terminal\x1b[0m\r\n');
      ws.close();
      return;
    }
  } else {
    if (sess.buf) ws.send(sess.buf);
  }

  ws.on('message', (msg) => {
    if (!sess.term) return;
    const str = msg.toString();
    try {
      const obj = JSON.parse(str);
      if (obj.type === 'resize') {
        sess.cols = Math.max(2, obj.cols);
        sess.rows = Math.max(2, obj.rows);
        sess.term.resize(sess.cols, sess.rows);
        return;
      }
    } catch {}
    if (termNum === 1) lastInteraction = Date.now();
    sess.term.write(str);
  });

  ws.on('close', () => { if (sess.ws === ws) sess.ws = null; });
  ws.on('error', () => { if (sess.ws === ws) sess.ws = null; });
});

// ── Heartbeat — auto-wrap + restart after 30 min idle ─────────────────────────

let lastInteraction = Date.now();
let heartbeatFired = false;
let lastSnapshotLen = 0;

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[mGKHFABCDJsu]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')
            .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '');
}

const PROJECT_NAMES = ['pb', 'FootyBanter', 'wheredhego_v1', 'genie', '3ptventures', 'aini', 'Clockify_alt', 'base'];

function projectMemoryDir(projectName) {
  const p = `/Users/noah/Desktop/Projects/${projectName}`;
  return path.join(os.homedir(), '.claude', 'projects', p.replace(/\//g, '-'), 'memory');
}

function appendToIndex(dir, filename, label) {
  const indexPath = path.join(dir, 'MEMORY.md');
  const line = `- [${label}](${filename}) — ${label}`;
  if (fs.existsSync(indexPath)) {
    fs.appendFileSync(indexPath, '\n' + line);
  } else {
    fs.writeFileSync(indexPath, `# Memory Index\n\n${line}\n`);
  }
}

function saveRawBuffer(reason) {
  const sess = SESSIONS[1];
  const content = stripAnsi(sess.buf).trim();
  if (!content) return;
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const ts = new Date().toISOString().slice(0, 10);
  const filename = `raw_${reason}_${Date.now()}.md`;
  fs.writeFileSync(
    path.join(MEMORY_DIR, filename),
    `---\nname: raw-${reason}-${ts}\ndescription: Raw session log (${reason}) ${ts}\nmetadata:\n  type: project\n---\n\n${content}\n`
  );
  appendToIndex(MEMORY_DIR, filename, `Raw log (${reason}) ${ts}`);
  console.log(`[heartbeat] raw buffer saved: ${filename}`);
}

// Snapshot buffer every 5 min if new content exists
setInterval(() => {
  const sess = SESSIONS[1];
  if (!sess.term || sess.buf.length === lastSnapshotLen) return;
  lastSnapshotLen = sess.buf.length;
  saveRawBuffer('snapshot');
}, 5 * 60 * 1000);

function saveHeartbeatMemory(raw) {
  const content = raw.trim();
  if (!content) return;

  const ts = new Date().toISOString().slice(0, 10);

  // Parse PROJECT line from Claude's response
  const projectMatch = content.match(/^PROJECT:\s*(\S+)/m);
  const detectedProject = projectMatch ? PROJECT_NAMES.find(p => p.toLowerCase() === projectMatch[1].toLowerCase()) : null;
  const cleanContent = content.replace(/^PROJECT:.*\n?/m, '').trim();

  // 1. Daily memory — append to today's file in Base memory dir
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const dailyFile = `daily_${ts}.md`;
  const dailyPath = path.join(MEMORY_DIR, dailyFile);
  const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  const dailyEntry = `\n## ${timestamp}${detectedProject ? ` — ${detectedProject}` : ''}\n\n${cleanContent}\n`;
  if (fs.existsSync(dailyPath)) {
    fs.appendFileSync(dailyPath, dailyEntry);
  } else {
    fs.writeFileSync(dailyPath, `---\nname: daily-${ts}\ndescription: Daily memory log ${ts}\nmetadata:\n  type: project\n---\n${dailyEntry}`);
    appendToIndex(MEMORY_DIR, dailyFile, `Daily log ${ts}`);
  }
  console.log(`[heartbeat] appended to daily: ${dailyFile}`);

  // 2. Project-specific memory
  if (detectedProject) {
    const projDir = projectMemoryDir(detectedProject);
    if (!fs.existsSync(projDir)) fs.mkdirSync(projDir, { recursive: true });
    const projFile = `session_${ts}_${Date.now()}.md`;
    fs.writeFileSync(
      path.join(projDir, projFile),
      `---\nname: session-${ts}\ndescription: Session summary ${ts}\nmetadata:\n  type: project\n---\n\n${cleanContent}\n`
    );
    appendToIndex(projDir, projFile, `Session ${ts} (auto)`);
    console.log(`[heartbeat] saved to project ${detectedProject}: ${projFile}`);
  }
}

function restartClaude() {
  const sess = SESSIONS[1];
  if (sess.term) { try { sess.term.kill(); } catch {} sess.term = null; }
  sess.buf = '';
  const notice = '\r\n\x1b[33m[session auto-saved — restarting Claude]\x1b[0m\r\n';
  sess.buf += notice;
  if (sess.ws?.readyState === 1) sess.ws.send(notice);
  setTimeout(() => {
    spawnSession(1);
    if (sess.ws?.readyState === 1 && sess.buf) sess.ws.send(sess.buf);
  }, 1000);
}

setInterval(() => {
  const idleMs = Date.now() - lastInteraction;
  const THIRTY_MIN = 30 * 60 * 1000;
  if (idleMs < THIRTY_MIN) { heartbeatFired = false; return; }
  if (heartbeatFired) return;
  heartbeatFired = true;

  const sess = SESSIONS[1];
  if (!sess.term) return;

  console.log('[heartbeat] 30 min idle — saving session summary');
  const mark = sess.buf.length;
  const prompt = 'Summarize this session for my memory system. Format exactly as shown, no extra text:\n\nPROJECT: [one of: pb, FootyBanter, wheredhego_v1, genie, 3ptventures, aini, Clockify_alt, base, or general]\n\n## What we did\n[2-4 bullet points]\n\n## Key decisions\n[choices made that future-me should know]\n\n## Next\n[open items, what to pick up next session]';
  sess.term.write(prompt + '\r');

  setTimeout(() => {
    const captured = stripAnsi(sess.buf.slice(mark)).trim();
    saveHeartbeatMemory(captured);
    restartClaude();
  }, 45000);
}, 60000);

const cfg = loadConfig();
const PORT = cfg.port || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Base running at http://localhost:${PORT}\n`);
});
