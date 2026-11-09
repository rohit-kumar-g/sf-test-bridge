// Local hub between MCP server processes and the browser extension.
//
// The first MCP process to bind 127.0.0.1:<port> becomes the hub; the
// extension connects to /ext. Further MCP processes (other Claude Code
// sessions) connect to /peer with a shared token and have their requests
// relayed. If the hub process exits, a peer takes over the port.
//
// Security:
//  - binds to 127.0.0.1 only and checks the Host header (DNS rebinding)
//  - /ext only accepts the extension's chrome-extension:// origin, so web
//    pages (which always send an http(s) Origin) cannot connect
//  - /peer requires the token stored in ~/.sf-test-bridge/token
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

export const EXTENSION_ID = process.env.BROWSER_BRIDGE_EXTENSION_ID || 'kokfnnhacmipalbbndbpnbhpfhilopef';
export const STATE_DIR = path.join(os.homedir(), '.sf-test-bridge');
// Raw traffic log: <mcp-server>/logs/extension-raw-YYYY-MM-DD.log
export const RAW_LOG_DIR = process.env.BROWSER_BRIDGE_RAW_LOG_DIR
  || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs');

const log = (...a) => process.stderr.write(`[sf-test-bridge] ${a.join(' ')}\n`);

// Every frame exchanged with the extension, written unedited:
//   <ISO time>\t<ext->mcp | mcp->ext>\t<connection id>\t<raw message>
// The raw message is the exact text received/sent (never parsed or re-serialized).
function rawLog(dir, connId, data) {
  try {
    fs.mkdirSync(RAW_LOG_DIR, { recursive: true });
    const now = new Date();
    const file = path.join(RAW_LOG_DIR, `extension-raw-${now.toISOString().slice(0, 10)}.log`);
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    fs.appendFileSync(file, Buffer.concat([Buffer.from(`${now.toISOString()}\t${dir}\t${connId}\t`), raw, Buffer.from('\n')]));
  } catch (e) {
    log(`raw log write failed: ${e.message}`);
  }
}

export function loadToken() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = path.join(STATE_DIR, 'token');
  try {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  return fs.readFileSync(file, 'utf8').trim();
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export class Bridge extends EventEmitter {
  constructor({ port = 17345, token = loadToken(), allowedOrigins = [] } = {}) {
    super();
    this.port = port;
    this.token = token;
    this.allowedOrigins = new Set([`chrome-extension://${EXTENSION_ID}`, ...allowedOrigins]);
    this.role = 'starting';
    this.seq = 0;
    this.pending = new Map(); // id -> {resolve, reject, timer} (own requests)
    this.relayed = new Map(); // hub: extension request id -> {peer, peerId}
    this.extensions = new Map(); // hub: connId -> {ws, info, since}
    this.activeExt = null;
    this.peers = new Set();
    this.evidenceIds = new Set(); // hub: request ids of evidenceShot calls (raw log placeholder)
    this.hubWs = null; // peer: connection to the hub
    this.closed = false;
  }

  start() { this.#tryHub(); return this; }

  close() {
    this.closed = true;
    this.server?.close();
    this.wss?.close();
    this.hubWs?.close();
  }

  // ---------------- hub ----------------
  #tryHub() {
    if (this.closed) return;
    const server = http.createServer((req, res) => { res.writeHead(404).end(); });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      const host = (req.headers.host || '').toLowerCase();
      if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return socket.destroy();
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/ext') {
        if (!this.allowedOrigins.has(req.headers.origin)) {
          log(`rejected /ext connection from origin ${req.headers.origin}`);
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          return socket.destroy();
        }
        wss.handleUpgrade(req, socket, head, (ws) => this.#onExtension(ws));
      } else if (url.pathname === '/peer') {
        if (req.headers.origin || !safeEqual(req.headers['x-bridge-token'] || '', this.token)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          return socket.destroy();
        }
        wss.handleUpgrade(req, socket, head, (ws) => this.#onPeer(ws));
      } else {
        socket.destroy();
      }
    });
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE') this.#becomePeer();
      else { log('hub error', e.message); setTimeout(() => this.#tryHub(), 3000); }
    });
    server.listen(this.port, '127.0.0.1', () => {
      this.server = server;
      this.wss = wss;
      this.role = 'hub';
      log(`hub listening on 127.0.0.1:${this.port}`);
      this.emit('role', 'hub');
    });
  }

  #onExtension(ws) {
    const id = `ext${++this.seq}`;
    const rec = { ws, info: {}, since: Date.now() };
    this.extensions.set(id, rec);
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { rawLog('ext->mcp', id, data); return; }
      // Evidence screenshots are stored as files by the caller; in the raw log
      // the image becomes a placeholder (size + hash) instead of ~100 KB of base64.
      if (msg.type === 'response' && this.evidenceIds.delete(msg.id) && typeof msg.result?.image === 'string') {
        const img = msg.result.image;
        const sha = crypto.createHash('sha256').update(img, 'base64').digest('hex').slice(0, 16);
        rawLog('ext->mcp', id, JSON.stringify({ ...msg, result: { ...msg.result, image: `[evidence image omitted: ${img.length} base64 chars, sha256 ${sha}]` } }));
      } else {
        rawLog('ext->mcp', id, data);
      }
      if (msg.type === 'hello') {
        rec.info = { browser: msg.browser, version: msg.version, userAgent: msg.userAgent };
        this.activeExt = id; // most recent connection wins
        log(`extension connected: ${msg.browser} ${msg.version} (${id})`);
        this.emit('extension', id);
      } else if (msg.type === 'ping') {
        ws.send('{"type":"pong"}');
      } else if (msg.type === 'response') {
        this.#settle(msg);
      }
    });
    ws.on('close', () => {
      this.extensions.delete(id);
      if (this.activeExt === id) this.activeExt = [...this.extensions.keys()].pop() || null;
      log(`extension disconnected (${id})`);
      for (const [rid, r] of this.relayed) {
        if (r.extId === id) { this.relayed.delete(rid); r.fail('browser extension disconnected'); }
      }
    });
  }

  #onPeer(ws) {
    this.peers.add(ws);
    ws.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type !== 'request') return;
      const reply = (o) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'response', id: msg.id, ...o }));
      try {
        reply({ result: await this.#hubRequest(msg.method, msg.params, msg.timeoutMs) });
      } catch (e) {
        reply({ error: { message: e.message } });
      }
    });
    ws.on('close', () => this.peers.delete(ws));
  }

  #settle(msg) {
    const r = this.relayed.get(msg.id);
    if (!r) return;
    this.relayed.delete(msg.id);
    if (msg.error) r.fail(msg.error.message); else r.ok(msg.result);
  }

  hubStatus() {
    return {
      role: 'hub', port: this.port, peers: this.peers.size,
      extensions: [...this.extensions.entries()].map(([id, e]) => ({ id, active: id === this.activeExt, ...e.info, connectedFor: `${Math.round((Date.now() - e.since) / 1000)}s` })),
    };
  }

  async #waitForExtension(ms) {
    if (this.activeExt) return true;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.off('extension', on); resolve(false); }, ms);
      const on = () => { clearTimeout(t); resolve(true); };
      this.once('extension', on);
    });
  }

  async #hubRequest(method, params = {}, timeoutMs = 60_000) {
    if (method === 'hub.status') return this.hubStatus();
    if (method === 'hub.use') {
      if (!this.extensions.has(params.id)) throw new Error(`no extension connection ${params.id}`);
      this.activeExt = params.id;
      return this.hubStatus();
    }
    if (!(await this.#waitForExtension(params.__waitMs ?? 35_000))) {
      throw new Error(
        'Browser extension is not connected. Make sure Chrome/Edge is running with the "SF Test Bridge" extension loaded '
        + '(chrome://extensions -> Developer mode -> Load unpacked -> the extension/ folder). It reconnects every ~30s; '
        + 'clicking its toolbar icon reconnects immediately.',
      );
    }
    const ext = this.extensions.get(this.activeExt);
    const id = `r${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.relayed.delete(id);
        this.evidenceIds.delete(id);
        // Tell the extension to stop this command, so it cannot act on the page later.
        const cancel = JSON.stringify({ type: 'cancel', id });
        rawLog('mcp->ext', extId, cancel);
        if (ext.ws.readyState === 1) ext.ws.send(cancel);
        reject(new Error(`browser did not answer "${method}" within ${timeoutMs}ms (the command was cancelled in the extension)`));
      }, timeoutMs);
      const extId = this.activeExt;
      this.relayed.set(id, {
        extId,
        ok: (v) => { clearTimeout(timer); resolve(v); },
        fail: (m) => { clearTimeout(timer); reject(new Error(m)); },
      });
      // __budgetMs lets the extension's watchdog stop the command (and report
      // the step it was on) before this timeout fires.
      const frame = JSON.stringify({ type: 'request', id, method, params: { ...params, __budgetMs: timeoutMs } });
      if (method === 'evidenceShot') this.evidenceIds.add(id);
      rawLog('mcp->ext', this.activeExt, frame);
      ext.ws.send(frame);
    });
  }

  // ---------------- peer ----------------
  #becomePeer() {
    if (this.closed) return;
    this.role = 'peer';
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/peer`, { headers: { 'x-bridge-token': this.token } });
    ws.on('open', () => { this.hubWs = ws; this.retries = 0; log(`connected to existing hub on port ${this.port} as peer`); this.emit('role', 'peer'); });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
    });
    ws.on('unexpected-response', (_req, res) => {
      log(`port ${this.port} is in use by something that refused us (HTTP ${res.statusCode}). Set BROWSER_BRIDGE_PORT to another port (and the same port in the extension popup).`);
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (this.hubWs === ws) this.hubWs = null;
      for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('lost connection to the hub; retry')); this.pending.delete(id); }
      if (this.closed) return;
      this.role = 'starting';
      // Hub may have exited: try to take over the port (with jitter so peers don't race).
      this.retries = (this.retries || 0) + 1;
      setTimeout(() => this.#tryHub(), Math.min(200 * 2 ** this.retries, 10_000) + Math.random() * 800);
    });
  }

  // ---------------- public ----------------
  async request(method, params = {}, timeoutMs = 60_000) {
    for (let i = 0; this.role === 'starting' && i < 50; i++) await new Promise((r) => setTimeout(r, 100));
    if (this.role === 'hub') return this.#hubRequest(method, params, timeoutMs);
    if (this.role === 'peer') {
      for (let i = 0; !this.hubWs && i < 30; i++) await new Promise((r) => setTimeout(r, 100));
      if (!this.hubWs) throw new Error(`cannot reach the browser-bridge hub on port ${this.port}`);
      const id = `p${++this.seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`no answer for "${method}" within ${timeoutMs + 40_000}ms`)); }, timeoutMs + 40_000);
        this.pending.set(id, { resolve, reject, timer });
        this.hubWs.send(JSON.stringify({ type: 'request', id, method, params, timeoutMs }));
      });
    }
    throw new Error('browser bridge hub is not running');
  }
}
