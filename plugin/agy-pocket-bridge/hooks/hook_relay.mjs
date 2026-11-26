import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ALLOWED_DECISIONS = new Set([
  'auto_approve',
  'allow',
  'deny',
  'ask',
  'force_ask',
  'deny_unless_prior_grant',
]);

const eventType = process.argv[2] || 'PreToolUse';

function getRuntimePath() {
  if (process.env.AGYPOCKET_BACKEND_RUNTIME_FILE) {
    return process.env.AGYPOCKET_BACKEND_RUNTIME_FILE;
  }
  return path.join(
    os.homedir(),
    '.gemini',
    'antigravity',
    'sidecar_data',
    'agy-pocket-bridge',
    'agypocket_backend.json',
  );
}

function defaultFallback(evType) {
  if (evType === 'PreToolUse') {
    return { decision: 'allow' };
  }
  if (evType === 'Stop') {
    return { decision: 'stop' };
  }
  return {};
}

function readStdinText() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => resolve(''));
  });
}

function postLoopbackJson(port, secret, reqPath, bodyObj, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify(bodyObj);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-AgyPocket-Hook-Secret': secret,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve(null);
            return;
          }
          try {
            const txt = Buffer.concat(chunks).toString('utf8');
            resolve(txt ? JSON.parse(txt) : null);
          } catch {
            resolve(null);
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

async function main() {
  const fallback = defaultFallback(eventType);
  const runtimePath = getRuntimePath();

  if (!fs.existsSync(runtimePath)) {
    process.stdout.write(JSON.stringify(fallback));
    return;
  }

  let runtime;
  try {
    runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8'));
  } catch {
    process.stdout.write(JSON.stringify(fallback));
    return;
  }

  const port = Number(runtime?.port || 0);
  const secret = String(runtime?.secret || '');
  if (!port || !secret) {
    process.stdout.write(JSON.stringify(fallback));
    return;
  }

  const stdinRaw = await readStdinText();
  let payload = {};
  try {
    payload = stdinRaw.trim() ? JSON.parse(stdinRaw) : {};
  } catch {
    payload = {};
  }

  if (eventType === 'PreToolUse') {
    const resp = await postLoopbackJson(
      port,
      secret,
      '/api/internal/hook/pre-tool',
      payload,
      105000,
    );
    if (resp && typeof resp === 'object' && ALLOWED_DECISIONS.has(resp.decision)) {
      const out = { decision: resp.decision };
      if (typeof resp.reason === 'string' && resp.reason) {
        out.reason = resp.reason;
      }
      process.stdout.write(JSON.stringify(out));
      return;
    }
    process.stdout.write(JSON.stringify(fallback));
    return;
  }

  await postLoopbackJson(
    port,
    secret,
    '/api/internal/hook/event',
    { event: eventType, payload },
    1500,
  );
  process.stdout.write(JSON.stringify(fallback));
}

main().catch(() => {
  process.stdout.write(JSON.stringify(defaultFallback(eventType)));
});
