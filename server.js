const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync, spawn } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DUMPS_DIR   = path.join(__dirname, 'data', 'dumps');
if (!fs.existsSync(DUMPS_DIR)) fs.mkdirSync(DUMPS_DIR, { recursive: true });

// iCloud-backed shared state (single source of truth across machines)
const ICLOUD     = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'claude');
const TODOS_PATH = path.join(ICLOUD, 'todos.json');
const NOTES_DIR  = path.join(ICLOUD, 'notes');
if (!fs.existsSync(ICLOUD))    fs.mkdirSync(ICLOUD,    { recursive: true });
if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });

// Detect projects root for this machine
const PROJECTS_ROOT = (() => {
  for (const p of [
    path.join(os.homedir(), 'Desktop', 'Projects'),
    path.join(os.homedir(), 'projects'),
    path.join(os.homedir(), 'Projects'),
  ]) { if (fs.existsSync(p)) return p; }
  return path.join(os.homedir(), 'Desktop', 'Projects');
})();
const PROJECTS_ROOT_ENCODED = PROJECTS_ROOT.replace(/\//g, '-');
const HOME_ENCODED = os.homedir().replace(/\//g, '-');

// Memory dir matches where Claude Code reads from — keyed to home dir since that's the CWD we spawn Claude with
const MEMORY_DIR = path.join(
  os.homedir(), '.claude', 'projects',
  HOME_ENCODED,
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
  let content = '';
  try {
    if (fs.statSync(p).isFile()) content = fs.readFileSync(p, 'utf8');
  } catch {}
  res.json({ content, path: p });
});

app.post('/api/claude-md', (req, res) => {
  const { project, content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'No content' });
  const p = project ? path.join(project, 'CLAUDE.md') : path.join(os.homedir(), 'CLAUDE.md');
  try {
    if (fs.existsSync(p) && !fs.statSync(p).isFile()) {
      return res.status(400).json({ error: `${p} exists but is not a regular file` });
    }
    fs.writeFileSync(p, content);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
          const projName = dirName.startsWith(PROJECTS_ROOT_ENCODED + '-')
            ? dirName.slice(PROJECTS_ROOT_ENCODED.length + 1)
            : dirName === HOME_ENCODED ? 'home' : dirName.split('-').filter(Boolean).pop() || dirName;
          sessions.push({
            projectName: projName,
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
const CC_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');
if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });

function parseSkillFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out = {};
  const descMatch = m[1].match(/^description:\s*(.+)$/m);
  if (descMatch) out.description = descMatch[1].trim();
  return out;
}

app.get('/api/skills', (req, res) => {
  const out = [];

  // Base flat skills: ~/skills/*.md  (editable)
  if (fs.existsSync(SKILLS_DIR)) {
    for (const f of fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.md')).sort()) {
      out.push({ name: f.replace(/\.md$/, ''), kind: 'flat' });
    }
  }

  // Agent Skills: ~/.claude/skills/<name>/SKILL.md  (read-only)
  if (fs.existsSync(CC_SKILLS_DIR)) {
    for (const dir of fs.readdirSync(CC_SKILLS_DIR).sort()) {
      const skillFile = path.join(CC_SKILLS_DIR, dir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      let description = '';
      try { description = parseSkillFrontmatter(fs.readFileSync(skillFile, 'utf8')).description || ''; } catch {}
      out.push({ name: dir, kind: 'agent', description });
    }
  }

  res.json(out);
});

app.get('/api/skills/:name', (req, res) => {
  const name = req.params.name;
  // Try flat first
  const flat = path.join(SKILLS_DIR, name + '.md');
  if (fs.existsSync(flat)) return res.json({ content: fs.readFileSync(flat, 'utf8'), kind: 'flat' });
  // Try agent skill
  const agent = path.join(CC_SKILLS_DIR, name, 'SKILL.md');
  if (fs.existsSync(agent)) return res.json({ content: fs.readFileSync(agent, 'utf8'), kind: 'agent' });
  res.status(404).json({ error: 'Not found' });
});

app.post('/api/skills/:name', (req, res) => {
  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'No content' });
  const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!name) return res.status(400).json({ error: 'Invalid name' });
  // Agent skills are read-only — don't allow overwriting
  if (fs.existsSync(path.join(CC_SKILLS_DIR, name, 'SKILL.md'))) {
    return res.status(403).json({ error: 'Agent skill is read-only' });
  }
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
  const { text, theme } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const todos = loadTodos();
  const todo = { id: Date.now(), text, done: false, createdAt: new Date().toISOString() };
  if (theme) todo.theme = theme;
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

// ── Dumps ─────────────────────────────────────────────────────────────────────

app.get('/api/dumps', (req, res) => {
  const files = fs.readdirSync(DUMPS_DIR).filter(f => /^dump-\d+\.txt$/.test(f));
  const dumps = files.map(f => {
    const ts = f.match(/^dump-(\d+)\.txt$/)[1];
    const rawPath = path.join(DUMPS_DIR, f);
    const orgPath = path.join(DUMPS_DIR, `dump-${ts}.organized.json`);
    const raw = fs.readFileSync(rawPath, 'utf8');
    return {
      ts,
      createdAt: fs.statSync(rawPath).mtime.toISOString(),
      preview: raw.slice(0, 140),
      organized: fs.existsSync(orgPath),
    };
  }).sort((a, b) => b.ts.localeCompare(a.ts));
  res.json({ dumps });
});

app.post('/api/dumps', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  const ts = Date.now().toString();
  const rawPath = path.join(DUMPS_DIR, `dump-${ts}.txt`);
  const orgPath = path.join(DUMPS_DIR, `dump-${ts}.organized.json`);
  fs.writeFileSync(rawPath, text);
  res.json({ ts, rawPath, orgPath });
});

app.get('/api/dumps/:ts', (req, res) => {
  const ts = req.params.ts.replace(/[^0-9]/g, '');
  if (!ts) return res.status(400).json({ error: 'bad ts' });
  const rawPath = path.join(DUMPS_DIR, `dump-${ts}.txt`);
  const orgPath = path.join(DUMPS_DIR, `dump-${ts}.organized.json`);
  if (!fs.existsSync(rawPath)) return res.status(404).json({ error: 'not found' });
  const raw = fs.readFileSync(rawPath, 'utf8');
  let organized = null;
  if (fs.existsSync(orgPath)) {
    try { organized = JSON.parse(fs.readFileSync(orgPath, 'utf8')); } catch {}
  }
  res.json({ ts, raw, organized });
});

app.delete('/api/dumps/:ts', (req, res) => {
  const ts = req.params.ts.replace(/[^0-9]/g, '');
  if (!ts) return res.status(400).json({ error: 'bad ts' });
  for (const f of [`dump-${ts}.txt`, `dump-${ts}.organized.json`]) {
    const p = path.join(DUMPS_DIR, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  res.json({ ok: true });
});

// ── Notes ─────────────────────────────────────────────────────────────────────

function walkMd(dir, base = dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(full, base));
    else if (e.isFile() && e.name.endsWith('.md')) {
      try {
        const stat = fs.statSync(full);
        let preview = '';
        try {
          const head = fs.readFileSync(full, 'utf8').slice(0, 600);
          // Strip frontmatter for preview
          preview = head.replace(/^---[\s\S]*?\n---\n/, '').replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim().slice(0, 160);
        } catch {}
        out.push({ path: full, name: e.name, mtime: stat.mtime.toISOString(), size: stat.size, preview });
      } catch {}
    }
  }
  return out;
}

app.get('/api/notes', (req, res) => {
  const groups = {};

  // ~/notes/
  groups['notes'] = walkMd(NOTES_DIR).map(f => ({ ...f, label: path.relative(NOTES_DIR, f.path) }));

  // ~/.claude/MEMORY_CONSOLIDATED.md
  const consolidated = path.join(os.homedir(), '.claude', 'MEMORY_CONSOLIDATED.md');
  if (fs.existsSync(consolidated)) {
    const stat = fs.statSync(consolidated);
    let preview = '';
    try {
      const head = fs.readFileSync(consolidated, 'utf8').slice(0, 600);
      preview = head.replace(/^---[\s\S]*?\n---\n/, '').replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim().slice(0, 160);
    } catch {}
    groups['consolidated'] = [{ path: consolidated, name: 'MEMORY_CONSOLIDATED.md', label: 'MEMORY_CONSOLIDATED.md', mtime: stat.mtime.toISOString(), size: stat.size, preview }];
  }

  // Sort each group by mtime desc
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  }

  res.json({ groups });
});

app.get('/api/notes/content', (req, res) => {
  const p = req.query.path;
  if (!p) return res.status(400).json({ error: 'path required' });
  const roots = [NOTES_DIR, path.join(os.homedir(), '.claude')];
  const abs = path.resolve(p);
  if (!roots.some(r => abs.startsWith(r))) return res.status(403).json({ error: 'forbidden path' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'not found' });
  res.json({ path: abs, content: fs.readFileSync(abs, 'utf8') });
});

app.delete('/api/notes', (req, res) => {
  const p = req.query.path;
  if (!p) return res.status(400).json({ error: 'path required' });
  const roots = [NOTES_DIR, path.join(os.homedir(), '.claude')];
  const abs = path.resolve(p);
  if (!roots.some(r => abs.startsWith(r))) return res.status(403).json({ error: 'forbidden path' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'not found' });
  try {
    fs.unlinkSync(abs);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Commands (slash commands) ────────────────────────────────────────────────

const COMMANDS_DIR = path.join(os.homedir(), '.claude', 'commands');

app.get('/api/commands', (req, res) => {
  if (!fs.existsSync(COMMANDS_DIR)) return res.json({ commands: [] });
  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md')).sort();
  const commands = files.map(f => {
    const full = path.join(COMMANDS_DIR, f);
    const content = fs.readFileSync(full, 'utf8');
    const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    let description = '', argumentHint = '', body = content;
    if (m) {
      const fm = m[1];
      body = m[2];
      const descMatch = fm.match(/^description:\s*(.+)$/m);
      const argMatch = fm.match(/^argument-hint:\s*(.+)$/m);
      if (descMatch) description = descMatch[1].trim();
      if (argMatch) argumentHint = argMatch[1].trim();
    }
    return { name: f.replace(/\.md$/, ''), description, argumentHint, body: body.trim() };
  });
  res.json({ commands });
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
    sess.term.write(str);
  });

  ws.on('close', () => { if (sess.ws === ws) sess.ws = null; });
  ws.on('error', () => { if (sess.ws === ws) sess.ws = null; });
});

// ── Daily memory — one global summary + per-project appends at midnight ────────

let lastDailyDate = new Date().toISOString().slice(0, 10);

function extractProjectName(dirName) {
  if (dirName.startsWith(PROJECTS_ROOT_ENCODED + '-')) return dirName.slice(PROJECTS_ROOT_ENCODED.length + 1) || null;
  if (dirName === HOME_ENCODED) return 'home';
  return null;
}

function readSessionText(filePath, dateStr) {
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
  let hasToday = false;
  const turns = [];
  for (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.timestamp?.slice(0, 10) === dateStr) hasToday = true;
    if (e.type !== 'user' && e.type !== 'assistant') continue;
    const c = e.message?.content;
    let text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join(' ')
      : '';
    text = text.trim().replace(/\n+/g, ' ').slice(0, 600);
    if (text) turns.push(`${e.type === 'user' ? 'Noah' : 'Claude'}: ${text}`);
  }
  return hasToday ? turns.join('\n') : null;
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', prompt], { env: { ...process.env } });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    proc.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(err || `exit ${code}`)));
    const t = setTimeout(() => { proc.kill(); reject(new Error('claude -p timeout')); }, 120000);
    proc.on('close', () => clearTimeout(t));
  });
}

function upsertMemoryIndex(indexPath, filename, label) {
  const entry = `- [${label}](${filename}) — ${label}`;
  if (fs.existsSync(indexPath)) {
    const idx = fs.readFileSync(indexPath, 'utf8');
    if (idx.includes(filename)) {
      fs.writeFileSync(indexPath, idx.split('\n').map(l => l.includes(filename) ? entry : l).join('\n'));
    } else {
      fs.appendFileSync(indexPath, '\n' + entry);
    }
  } else {
    fs.writeFileSync(indexPath, `# Memory Index\n\n${entry}\n`);
  }
}

async function saveDailySummary(dateStr) {
  // Race guard: if the other machine already wrote today's summary into iCloud, skip.
  const dailyFile = path.join(MEMORY_DIR, `daily_${dateStr}.md`);
  if (fs.existsSync(dailyFile)) {
    console.log(`[daily] ${dateStr} already exists (probably written by another machine) — skipping`);
    return;
  }

  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return;

  // Collect sessions from today, grouped by project
  const byProject = {};
  for (const dirName of fs.readdirSync(projectsDir)) {
    const projName = extractProjectName(dirName);
    if (!projName) continue;
    const dirPath = path.join(projectsDir, dirName);
    try { if (!fs.statSync(dirPath).isDirectory()) continue; } catch { continue; }
    let files = [];
    try { files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const file of files) {
      try {
        const text = readSessionText(path.join(dirPath, file), dateStr);
        if (!text) continue;
        if (!byProject[projName]) byProject[projName] = [];
        byProject[projName].push(text);
      } catch {}
    }
  }

  if (!Object.keys(byProject).length) { console.log(`[daily] no sessions for ${dateStr}`); return; }

  // Build one transcript block with all projects
  let transcriptBlock = '';
  for (const [projName, texts] of Object.entries(byProject).sort()) {
    transcriptBlock += `## ${projName}\n${texts.join('\n---\n').slice(0, 2500)}\n\n`;
  }

  // One claude -p call produces a structured daily summary with ## Project sections
  const fullSummary = await runClaude(
    `Summarize today's Claude Code sessions (${dateStr}). ` +
    `Write a daily log organized by project. For each project use a "## ProjectName" header ` +
    `and bullet points covering what was built/changed, key decisions, current state, open items. ` +
    `Be specific — name files, features, technical details. No preamble.\n\n` +
    `Today's sessions:\n${transcriptBlock}`
  ).catch(e => { console.error('[daily] claude -p failed:', e.message); return null; });

  if (!fullSummary) return;

  // 1. Save global daily summary to home memory dir
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const dailyFileName = `daily_${dateStr}.md`;
  fs.writeFileSync(
    dailyFile,
    `---\nname: daily-${dateStr}\ndescription: Daily log ${dateStr}\nmetadata:\n  type: project\n---\n\n${fullSummary}\n`
  );
  upsertMemoryIndex(path.join(MEMORY_DIR, 'MEMORY.md'), dailyFileName, `Daily log ${dateStr}`);
  console.log(`[daily] saved global summary for ${dateStr}`);

  // 2. Parse ## sections and append to each active project's memory
  const sections = {};
  let cur = null, curLines = [];
  for (const line of fullSummary.split('\n')) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      if (cur) sections[cur] = curLines.join('\n').trim();
      cur = m[1].trim();
      curLines = [];
    } else if (cur) {
      curLines.push(line);
    }
  }
  if (cur) sections[cur] = curLines.join('\n').trim();

  for (const [projName, content] of Object.entries(sections)) {
    if (!byProject[projName] || !content) continue; // only projects that actually had sessions
    const projMemDir = path.join(
      os.homedir(), '.claude', 'projects',
      path.join(PROJECTS_ROOT, projName).replace(/\//g, '-'),
      'memory'
    );
    if (!fs.existsSync(projMemDir)) fs.mkdirSync(projMemDir, { recursive: true });
    const projFile = `daily_${dateStr}.md`;
    fs.writeFileSync(
      path.join(projMemDir, projFile),
      `---\nname: daily-${dateStr}\ndescription: Daily summary ${dateStr}\nmetadata:\n  type: project\n---\n\n${content}\n`
    );
    upsertMemoryIndex(path.join(projMemDir, 'MEMORY.md'), projFile, `Daily summary ${dateStr}`);
    console.log(`[daily] saved project summary: ${projName}`);
  }
}

setInterval(() => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getHours() === 0 && now.getMinutes() === 0 && today !== lastDailyDate) {
    const yesterday = lastDailyDate;
    lastDailyDate = today;
    saveDailySummary(yesterday).catch(e => console.error('[daily] error:', e.message));
  }
}, 60000);

const cfg = loadConfig();
const PORT = cfg.port || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Base running at http://localhost:${PORT}`);
  console.log(`  Projects root: ${PROJECTS_ROOT}\n`);

  // On startup, generate yesterday's summary if it was missed (e.g. server was down at midnight)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const yesterdayFile = path.join(MEMORY_DIR, `daily_${yesterday}.md`);
  if (!fs.existsSync(yesterdayFile)) {
    console.log(`[daily] no summary for ${yesterday} — generating now`);
    setTimeout(() => {
      saveDailySummary(yesterday).catch(e => console.error('[daily] startup catch-up failed:', e.message));
    }, 3000);
  }
});
