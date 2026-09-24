'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const G = require('./game');

const PORT = +process.env.PORT || 3000;

// ---------------- tuning ----------------
const F = +process.env.TIME_SCALE || 1;  // tests speed the clock up
const GRACE_MS = 90_000 * F;    // how long a dropped player can reconnect to the same game
const TURN_MS = 60_000 * F;     // time a connected player gets for a move
const TRUMP_MS = 45_000 * F;    // time to call the rang
const AWAY_MS = 12_000 * F;     // time before the computer moves for a disconnected player
const BOT_MS = 850 * F;         // computer "thinking" pause
const BOT_TRUMP_MS = 1400 * F;
const TRICK_SHOW_MS = 1500 * F; // completed trick stays on the table
const NEXT_HAND_MS = 7000 * F;  // pause between hands
const MAX_ROOMS = 2000;
const MAX_PEOPLE = 12;          // 4 seats + watchers
const REACTIONS = 8;
const BOT_NAMES = ['Chacha Bot', 'Mamu Bot', 'Khala Bot', 'Phuppo Bot'];
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// ---------------- static files ----------------
const PUB = path.join(__dirname, 'public');
const TYPES = {
  'index.html': 'text/html; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'client.js': 'text/javascript; charset=utf-8',
  'manifest.webmanifest': 'application/manifest+json',
  'icon.svg': 'image/svg+xml',
};
const FILES = {};
for (const f of Object.keys(TYPES)) FILES['/' + f] = { body: fs.readFileSync(path.join(PUB, f)), type: TYPES[f] };
FILES['/'] = FILES['/index.html'];

function securityHeaders(req) {
  const host = /^[a-z0-9.\-:]{1,255}$/i.test(req.headers.host || '') ? req.headers.host : 'localhost';
  const h = {
    'Content-Security-Policy': [
      "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com",
      'font-src https://fonts.gstatic.com', "img-src 'self' data:", `connect-src 'self' wss://${host} ws://${host}`,
      "manifest-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
  if (req.headers['x-forwarded-proto'] === 'https') h['Strict-Transport-Security'] = 'max-age=31536000';
  return h;
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = new URL(req.url, 'http://x').pathname; } catch { pathname = ''; }
  if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  const f = FILES[pathname];
  if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain', ...securityHeaders(req) }); return res.end('Not found'); }
  res.writeHead(200, {
    'Content-Type': f.type,
    'Cache-Control': pathname === '/' || pathname === '/index.html' ? 'no-cache' : 'public, max-age=300',
    ...securityHeaders(req),
  });
  res.end(req.method === 'HEAD' ? undefined : f.body);
});

// ---------------- rooms ----------------
const rooms = new Map();     // code -> room
const sessions = new Map();  // sid -> player

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_ABC[crypto.randomInt(CODE_ABC.length)];
    if (!rooms.has(c)) return c;
  }
}

function cleanName(n) {
  const s = String(n || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || 'Player';
}
function uniqueName(room, name) {
  const taken = new Set([...room.people].map(p => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) { const n = `${name.slice(0, 13)} ${i}`; if (!taken.has(n.toLowerCase())) return n; }
}

function makeRoom(target) {
  const room = {
    code: newCode(), people: new Set(), seats: [null, null, null, null], hostSid: null,
    st: G.newGame(target, crypto.randomInt(4)), timer: null, tok: 0, deadline: 0, deadlineFor: null,
  };
  rooms.set(room.code, room);
  return room;
}

function destroyRoom(room) {
  clearTimeout(room.timer);
  room.tok++;
  if (rooms.get(room.code) === room) rooms.delete(room.code);
}

const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

function view(room, pl) {
  const st = room.st, me = pl.seat;
  return {
    code: room.code, phase: st.phase, target: st.target, score: st.score, dealer: st.dealer, caller: st.caller,
    trump: st.trump, handNo: st.handNo, turn: st.turn, trick: st.trick, trickWinner: st.trickWinner,
    tricks: st.tricks, result: st.result,
    seats: room.seats.map((s, i) => ({
      name: s ? s.name : BOT_NAMES[i], human: !!s, away: !!s && !s.connected,
      host: !!s && s.sid === room.hostSid, count: st.hands[i].length,
    })),
    me: { seat: me, host: pl.sid === room.hostSid, name: pl.name },
    hand: me >= 0 ? st.hands[me] : [],
    legal: me >= 0 ? G.legal(st, me) : [],
    watchers: [...room.people].filter(p => p.seat < 0).map(p => p.name),
    left: room.deadline ? Math.max(0, room.deadline - Date.now()) : 0,
    leftFor: room.deadline ? room.deadlineFor : null,
  };
}

function broadcast(room) {
  for (const p of room.people) if (p.connected) send(p.ws, { t: 'state', s: view(room, p) });
}
function note(room, text, except) {
  for (const p of room.people) if (p.connected && p !== except) send(p.ws, { t: 'note', text });
}

// ---------------- game clock ----------------
function schedule(room, ms, fn, forWhom) {
  clearTimeout(room.timer);
  const tok = ++room.tok;
  room.deadline = forWhom !== undefined ? Date.now() + ms : 0;
  room.deadlineFor = forWhom !== undefined ? forWhom : null;
  room.timer = setTimeout(() => {
    if (tok !== room.tok) return;
    room.deadline = 0;
    try { fn(); } catch (e) { console.error('game step failed', e); }
    advance(room);
    broadcast(room);
  }, ms);
}

function advance(room) {
  const st = room.st;
  clearTimeout(room.timer);
  room.tok++;
  room.deadline = 0;
  room.deadlineFor = null;
  if (st.phase === 'trump') {
    const p = st.caller, pl = room.seats[p];
    const auto = () => G.chooseTrump(st, p, G.aiTrump(st, p));
    if (!pl) return schedule(room, BOT_TRUMP_MS, auto);
    return schedule(room, pl.connected ? TRUMP_MS : AWAY_MS, auto, p);
  }
  if (st.phase === 'play') {
    if (st.trick.length === 4) return schedule(room, TRICK_SHOW_MS, () => G.finishTrick(st));
    const p = st.turn, pl = room.seats[p];
    const auto = () => G.play(st, p, G.aiCard(st, p));
    if (!pl) return schedule(room, BOT_MS, auto);
    return schedule(room, pl.connected ? TURN_MS : AWAY_MS, auto, p);
  }
  if (st.phase === 'handover') return schedule(room, NEXT_HAND_MS, () => G.startHand(st), 'hand');
}

// ---------------- people ----------------
function seatInLobby(room, pl) {
  const free = room.seats.findIndex(s => !s);
  if (free >= 0) { room.seats[free] = pl; pl.seat = free; }
}

function addToRoom(room, pl, name) {
  pl.room = room;
  pl.name = uniqueName(room, name);
  pl.seat = -1;
  room.people.add(pl);
  if (!room.hostSid) room.hostSid = pl.sid;
  if (room.st.phase === 'lobby') seatInLobby(room, pl);
}

function pickNewHost(room) {
  const list = [...room.people];
  const next = list.find(p => p.seat >= 0 && p.connected) || list.find(p => p.connected) || list[0];
  room.hostSid = next ? next.sid : null;
}

function removeFromRoom(pl, reason) {
  const room = pl.room;
  if (!room) return;
  clearTimeout(pl.graceTimer);
  pl.graceTimer = null;
  room.people.delete(pl);
  const wasSeated = pl.seat >= 0;
  if (wasSeated) room.seats[pl.seat] = null;
  pl.seat = -1;
  pl.room = null;
  if (!room.people.size) return destroyRoom(room);
  if (room.hostSid === pl.sid) pickNewHost(room);
  const inGame = room.st.phase !== 'lobby';
  if (wasSeated && inGame) note(room, `${pl.name} ${reason === 'timeout' ? 'lost connection' : 'left'} — the computer plays their seat for the rest of this game.`);
  else note(room, `${pl.name} left.`);
  if (inGame) advance(room);
  broadcast(room);
}

function forget(pl) {
  sessions.delete(pl.sid);
}

// ---------------- abuse limits ----------------
const joinFails = new Map(); // ip -> {n, since}
function joinBlocked(ip) {
  const r = joinFails.get(ip);
  if (!r) return false;
  if (Date.now() - r.since > 10 * 60_000) { joinFails.delete(ip); return false; }
  return r.n >= 25;
}
function joinFailed(ip) {
  const r = joinFails.get(ip);
  if (!r || Date.now() - r.since > 10 * 60_000) joinFails.set(ip, { n: 1, since: Date.now() });
  else r.n++;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of joinFails) if (now - r.since > 10 * 60_000) joinFails.delete(ip);
}, 60_000).unref();

// ---------------- messages ----------------
const handlers = {
  hello(pl, m, ctx) {
    const sid = typeof m.sid === 'string' && /^[A-Za-z0-9]{16,40}$/.test(m.sid) ? m.sid : null;
    if (!sid) return send(ctx.ws, { t: 'fatal', text: 'Bad session' });
    const existing = sessions.get(sid);
    if (existing && existing.room) {
      if (existing.ws && existing.ws !== ctx.ws) { send(existing.ws, { t: 'replaced' }); existing.ws.close(4000, 'replaced'); }
      existing.ws = ctx.ws;
      existing.connected = true;
      clearTimeout(existing.graceTimer);
      existing.graceTimer = null;
      ctx.pl = existing;
      advance(existing.room);
      broadcast(existing.room);
      return;
    }
    const fresh = { sid, name: 'Player', ws: ctx.ws, room: null, seat: -1, connected: true, graceTimer: null, lastReact: 0 };
    sessions.set(sid, fresh);
    ctx.pl = fresh;
    send(ctx.ws, { t: 'home' });
  },

  create(pl, m) {
    if (pl.room) removeFromRoom(pl, 'left');
    if (rooms.size >= MAX_ROOMS) return send(pl.ws, { t: 'error', text: 'The server is full right now. Try again in a few minutes.' });
    const target = [5, 7, 11].includes(m.target) ? m.target : 7;
    const room = makeRoom(target);
    addToRoom(room, pl, cleanName(m.name));
    room.hostSid = pl.sid;
    broadcast(room);
  },

  join(pl, m, ctx) {
    if (joinBlocked(ctx.ip)) return send(pl.ws, { t: 'error', text: 'Too many wrong codes. Wait 10 minutes and try again.' });
    const code = String(m.code || '').toUpperCase().replace(/[^A-Z]/g, '');
    const room = rooms.get(code);
    if (!room) {
      joinFailed(ctx.ip);
      return send(pl.ws, { t: 'error', text: `No game with code ${code || '—'}. Codes change for every new game, so ask for the latest one.` });
    }
    if (pl.room === room) return broadcast(room);
    if (room.people.size >= MAX_PEOPLE) return send(pl.ws, { t: 'error', text: 'That game is full.' });
    if (pl.room) removeFromRoom(pl, 'left');
    addToRoom(room, pl, cleanName(m.name));
    note(room, pl.seat >= 0 ? `${pl.name} joined.` : `${pl.name} is watching and will play in the next game.`, pl);
    broadcast(room);
  },

  seat(pl, m) {
    const room = pl.room;
    if (!room || room.st.phase !== 'lobby') return;
    const s = m.seat;
    if (!Number.isInteger(s) || s < 0 || s > 3 || room.seats[s]) return;
    if (pl.seat >= 0) room.seats[pl.seat] = null;
    room.seats[s] = pl;
    pl.seat = s;
    broadcast(room);
  },

  unseat(pl) {
    const room = pl.room;
    if (!room || room.st.phase !== 'lobby' || pl.seat < 0) return;
    room.seats[pl.seat] = null;
    pl.seat = -1;
    broadcast(room);
  },

  target(pl, m) {
    const room = pl.room;
    if (!room || room.hostSid !== pl.sid || room.st.phase !== 'lobby' || ![5, 7, 11].includes(m.target)) return;
    room.st.target = m.target;
    broadcast(room);
  },

  start(pl) {
    const room = pl.room;
    if (!room || room.hostSid !== pl.sid || room.st.phase !== 'lobby') return;
    G.startHand(room.st);
    advance(room);
    broadcast(room);
  },

  trump(pl, m) {
    const room = pl.room;
    if (!room || pl.seat < 0) return;
    if (G.chooseTrump(room.st, pl.seat, m.suit)) { advance(room); broadcast(room); }
  },

  play(pl, m) {
    const room = pl.room;
    if (!room || pl.seat < 0) return;
    if (G.play(room.st, pl.seat, m.card)) { advance(room); broadcast(room); }
    else send(pl.ws, { t: 'state', s: view(room, pl) });
  },

  react(pl, m) {
    const room = pl.room;
    if (!room || !Number.isInteger(m.i) || m.i < 0 || m.i >= REACTIONS) return;
    if (Date.now() - pl.lastReact < 1500) return;
    pl.lastReact = Date.now();
    for (const p of room.people) if (p.connected) send(p.ws, { t: 'react', seat: pl.seat, name: pl.name, i: m.i });
  },

  newgame(pl) {
    const room = pl.room;
    if (!room || room.hostSid !== pl.sid || room.st.phase !== 'gameover') return;
    rooms.delete(room.code);
    room.code = newCode();
    rooms.set(room.code, room);
    room.st = G.newGame(room.st.target, crypto.randomInt(4));
    for (const p of room.people) if (p.seat < 0) seatInLobby(room, p);
    advance(room);
    note(room, `New game! The new code is ${room.code}.`);
    broadcast(room);
  },

  leave(pl) {
    if (pl.room) removeFromRoom(pl, 'left');
    send(pl.ws, { t: 'home' });
  },

  ping(pl) { send(pl.ws, { t: 'pong' }); },
};

// ---------------- websocket ----------------
const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: 2048,
  verifyClient({ origin, req }) {
    if (!origin) return true; // non-browser clients
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  },
});

wss.on('connection', (ws, req) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const ctx = { ws, ip, pl: null, tokens: 40, last: Date.now() };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    // token bucket: ~4 messages/second sustained, bursts of 40
    const now = Date.now();
    ctx.tokens = Math.min(40, ctx.tokens + (now - ctx.last) / (250 * F));
    ctx.last = now;
    if (--ctx.tokens < 0) return ws.close(1008, 'slow down');
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string' || !Object.hasOwn(handlers, m.t)) return;
    if (m.t !== 'hello' && !ctx.pl) return;
    if (m.t === 'hello' && ctx.pl) return;
    try { handlers[m.t](ctx.pl, m, ctx); } catch (e) { console.error('handler failed', m.t, e); }
  });

  ws.on('close', () => {
    const pl = ctx.pl;
    if (!pl || pl.ws !== ws) return;
    pl.connected = false;
    pl.ws = null;
    if (!pl.room) return forget(pl);
    const room = pl.room;
    pl.graceTimer = setTimeout(() => { removeFromRoom(pl, 'timeout'); forget(pl); }, GRACE_MS);
    if (room.hostSid === pl.sid) pickNewHost(room);
    if (room.st.phase !== 'lobby') advance(room);
    broadcast(room);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000).unref();

server.listen(PORT, () => console.log(`Court Piece running on http://localhost:${PORT}`));
