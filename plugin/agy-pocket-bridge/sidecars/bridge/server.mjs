import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function installEpipeGuard() {
  for (const stream of [process.stdout, process.stderr]) {
    stream?.on?.('error', (err) => {
      if (err?.code === 'EPIPE') return;
    });
  }
}

installEpipeGuard();

function resolveDataDir() {
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  }
  return path.join(
    os.homedir(),
    '.gemini',
    'antigravity',
    'sidecar_data',
    'agy-pocket-bridge',
    'bridge',
    'data',
  );
}

const DATA_DIR = resolveDataDir();
const EVENTS_DIR = path.resolve(DATA_DIR, '..', 'events');
const RUNTIME_FILE = path.join(DATA_DIR, 'bridge_runtime.json');
const CONFIG_FILE = path.join(os.homedir(), '.gemini', 'config', 'config.json');
const AUTH_TOKEN = crypto.randomBytes(32).toString('hex');
const STARTED_AT = Date.now() / 1000;

function atomicWriteJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function readSidecarProjectId() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.sidecars?.['agy-pocket-bridge/bridge']?.projectId || '';
  } catch {
    return '';
  }
}

function parseBatTargetExe(batPath) {
  try {
    const content = fs.readFileSync(batPath, 'utf8');
    const m = content.match(/"([^"]+\.exe)"\s+agentapi\b/i);
    if (m && fs.existsSync(m[1])) {
      return { exe: m[1], prefixArgs: ['agentapi'] };
    }
  } catch {
    // ignore
  }
  return null;
}

function resolveAgentApiRunner() {
  const override = process.env.AGY_AGENTAPI_EXE || process.env.ANTIGRAVITY_AGENTAPI_EXE;
  if (override && fs.existsSync(override)) {
    return { exe: override, prefixArgs: ['agentapi'], source: override };
  }

  const batPath = path.join(os.homedir(), '.gemini', 'antigravity', 'bin', 'agentapi.bat');
  if (fs.existsSync(batPath)) {
    const parsed = parseBatTargetExe(batPath);
    if (parsed) {
      return { ...parsed, source: batPath };
    }
  }

  const defaultExe = path.join(
    os.homedir(),
    'AppData',
    'Local',
    'Programs',
    'antigravity',
    'resources',
    'bin',
    'language_server.exe',
  );
  if (fs.existsSync(defaultExe)) {
    return { exe: defaultExe, prefixArgs: ['agentapi'], source: defaultExe };
  }

  return { exe: 'agentapi', prefixArgs: [], source: 'PATH' };
}

function runAgentApi(args, { projectId = '', timeoutMs = 45000 } = {}) {
  const runner = resolveAgentApiRunner();
  const childEnv = { ...process.env };
  if (projectId) {
    childEnv.ANTIGRAVITY_PROJECT_ID = projectId;
  }
  return new Promise((resolve, reject) => {
    execFile(
      runner.exe,
      [...runner.prefixArgs, ...args],
      {
        env: childEnv,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const detail = (stderr || stdout || err.message || 'agentapi failed').toString().trim();
          reject(new Error(detail));
          return;
        }
        resolve({
          stdout: (stdout || '').toString(),
          stderr: (stderr || '').toString(),
        });
      },
    );
  });
}

function listEventFiles() {
  try {
    return new Set(fs.readdirSync(EVENTS_DIR));
  } catch {
    return new Set();
  }
}

function extractConvIdFromJsonOrText(raw) {
  if (!raw) return '';
  try {
    const obj = JSON.parse(raw);
    const direct =
      obj?.conversationId ||
      obj?.conversation_id ||
      obj?.payload?.conversationId ||
      obj?.payload?.conversation_id ||
      obj?.payload?.conversationMetadata?.conversationId;
    if (typeof direct === 'string' && UUID_RE.test(direct)) {
      return direct.match(UUID_RE)[0];
    }
  } catch {
    // fallback to regex scan
  }
  const m = String(raw).match(UUID_RE);
  return m ? m[0] : '';
}

async function detectNewConversationId(stdoutText, beforeFiles) {
  const fromStdout = extractConvIdFromJsonOrText(stdoutText);
  if (fromStdout) {
    return fromStdout;
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      const current = fs.readdirSync(EVENTS_DIR);
      const added = current.filter((name) => !beforeFiles.has(name)).sort().reverse();
      for (const fname of added) {
        const nameMatch = fname.match(UUID_RE);
        if (nameMatch) return nameMatch[0];
        try {
          const parsed = extractConvIdFromJsonOrText(
            fs.readFileSync(path.join(EVENTS_DIR, fname), 'utf8'),
          );
          if (parsed) return parsed;
        } catch {
          // ignore
        }
      }
    } catch {
      // events dir might not exist yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return '';
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 2 * 1024 * 1024) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function isAuthorized(req) {
  const remote = req.socket?.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
    return false;
  }
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return false;
  }
  const supplied = auth.slice(7).trim();
  if (supplied.length !== AUTH_TOKEN.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(AUTH_TOKEN));
}

const server = http.createServer(async (req, res) => {
  if (!isAuthorized(req)) {
    sendJson(res, 403, { ok: false, error: 'Forbidden' });
    return;
  }

  const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');

  try {
    if (req.method === 'GET' && reqUrl.pathname === '/health') {
      const runner = resolveAgentApiRunner();
      sendJson(res, 200, {
        ok: true,
        pid: process.pid,
        started_at: STARTED_AT,
        agentapi_available: runner.exe === 'agentapi' || fs.existsSync(runner.exe),
        agentapi_source: runner.source,
        sidecar_project_id: readSidecarProjectId(),
        events_dir: EVENTS_DIR,
      });
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/new-conversation') {
      const body = await readJsonBody(req);
      let prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      const model = typeof body.model === 'string' ? body.model.trim() : '';
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const projectId = typeof body.project_id === 'string' ? body.project_id.trim() : '';
      if (!prompt) {
        sendJson(res, 400, { ok: false, error: 'prompt is required' });
        return;
      }
      if (prompt.startsWith('-')) {
        prompt = ` ${prompt}`;
      }

      const args = ['new-conversation'];
      if (model) args.push('--model', model);
      if (title) args.push('--title', title);
      args.push(prompt);

      const beforeFiles = listEventFiles();
      const result = await runAgentApi(args, { projectId });
      const conversationId = await detectNewConversationId(result.stdout, beforeFiles);
      sendJson(res, 200, {
        ok: true,
        conversation_id: conversationId,
        project_id: projectId,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      });
      return;
    }

    if (req.method === 'POST' && reqUrl.pathname === '/send-message') {
      const body = await readJsonBody(req);
      const conversationId = typeof body.conversation_id === 'string' ? body.conversation_id.trim() : '';
      let prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const projectId = typeof body.project_id === 'string' ? body.project_id.trim() : '';
      if (!conversationId || !prompt) {
        sendJson(res, 400, { ok: false, error: 'conversation_id and prompt are required' });
        return;
      }
      if (prompt.startsWith('-')) {
        prompt = ` ${prompt}`;
      }

      const args = ['send-message'];
      if (title) args.push('--title', title);
      args.push(conversationId, prompt);

      const result = await runAgentApi(args, { projectId });
      sendJson(res, 200, {
        ok: true,
        conversation_id: conversationId,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      });
      return;
    }

    if (req.method === 'GET' && reqUrl.pathname === '/conversation-metadata') {
      const convId = (reqUrl.searchParams.get('id') || '').trim();
      if (!convId) {
        sendJson(res, 400, { ok: false, error: 'id query param is required' });
        return;
      }
      const result = await runAgentApi(['get-conversation-metadata', convId], { timeoutMs: 15000 });
      let metadata = null;
      try {
        metadata = JSON.parse(result.stdout);
      } catch {
        metadata = result.stdout.trim();
      }
      sendJson(res, 200, { ok: true, conversation_id: convId, metadata });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

server.listen(0, '127.0.0.1', () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  atomicWriteJson(RUNTIME_FILE, {
    port,
    token: AUTH_TOKEN,
    pid: process.pid,
    started_at: STARTED_AT,
    events_dir: EVENTS_DIR,
    sidecar_project_id: readSidecarProjectId(),
  });
});

function shutdown() {
  try {
    if (fs.existsSync(RUNTIME_FILE)) {
      fs.unlinkSync(RUNTIME_FILE);
    }
  } catch {
    // ignore cleanup failure
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
