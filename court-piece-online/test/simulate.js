'use strict';
// End-to-end check: starts the server with a fast clock and plays whole games
// with simulated players, including leaving, reconnecting and new-game codes.
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const G = require('../game');

const PORT = 3900 + Math.floor(Math.random() * 90);
const URL = `ws://localhost:${PORT}/ws`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = msg => { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); };
const ok = msg => console.log('ok -', msg);

function client(name, sid, { autoplay = true } = {}) {
  const c = { name, sid, v: null, notes: [], errors: [], ws: null, autoplay, homes: 0 };
  c.connect = () => new Promise(res => {
    c.ws = new WebSocket(URL);
    c.ws.on('open', () => { c.ws.send(JSON.stringify({ t: 'hello', sid })); res(); });
    c.ws.on('message', d => {
      const m = JSON.parse(d);
      if (m.t === 'state') {
        c.v = m.s;
        if (c.autoplay) act(c);
      } else if (m.t === 'home') { c.v = null; c.homes++; }
      else if (m.t === 'note') c.notes.push(m.text);
      else if (m.t === 'error') c.errors.push(m.text);
    });
  });
  c.send = m => c.ws.send(JSON.stringify(m));
  return c;
}
function act(c) {
  const v = c.v;
  if (v.phase === 'trump' && v.caller === v.me.seat) setTimeout(() => c.send({ t: 'trump', suit: G.SUITS[Math.floor(Math.random() * 4)] }), 5);
  if (v.legal.length) {
    // sanity: legal cards must be in hand and follow suit when possible
    for (const id of v.legal) if (!v.hand.includes(id)) fail(`${c.name} legal card not in hand`);
    if (v.trick.length && v.trick.length < 4) {
      const L = v.trick[0].c[0];
      if (v.hand.some(x => x[0] === L) && v.legal.some(x => x[0] !== L)) fail('legal ignores follow-suit rule');
    }
    const card = v.legal[Math.floor(Math.random() * v.legal.length)];
    setTimeout(() => c.send({ t: 'play', card }), 5);
  }
}
async function until(pred, what, ms = 20000) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) fail('timed out waiting for ' + what); await sleep(10); }
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, TIME_SCALE: '0.01' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise(r => srv.stdout.once('data', r));
  try {
    const a = client('Dawood', 'aaaaaaaaaaaaaaaaaaaa1');
    const b = client('Sara', 'bbbbbbbbbbbbbbbbbbbb2');
    const c = client('Ali', 'cccccccccccccccccccc3');
    await Promise.all([a.connect(), b.connect(), c.connect()]);

    a.send({ t: 'create', name: 'Dawood', target: 5 });
    await until(() => a.v, 'create');
    const code1 = a.v.code;
    if (!/^[A-Z]{5}$/.test(code1)) fail('bad code ' + code1);
    ok('game created with code ' + code1);

    b.send({ t: 'join', name: 'Sara', code: 'ZZZZZ' });
    await until(() => b.errors.length, 'wrong-code error');
    ok('wrong code rejected: ' + b.errors[0]);

    b.send({ t: 'join', name: 'Sara', code: code1.toLowerCase() });
    c.send({ t: 'join', name: '<b>Ali</b>', code: code1 });
    await until(() => a.v.seats.filter(s => s.human).length === 3, 'players seated');
    if (a.v.seats.some(s => /[<>]/.test(s.name))) fail('name not sanitised');
    ok('3 players seated: ' + a.v.seats.map(s => s.name).join(', '));

    b.send({ t: 'start' });
    await sleep(50);
    if (a.v.phase !== 'lobby') fail('non-host was able to start');
    a.send({ t: 'start' });
    await until(() => a.v.phase === 'trump' || a.v.phase === 'play', 'game start');
    ok('host started the game');

    // cheating attempts
    {
      const st = G.newGame(7, 0);
      G.startHand(st);
      const notCaller = (st.caller + 1) % 4;
      if (G.chooseTrump(st, notCaller, 'S')) fail('wrong player could call rang');
      G.chooseTrump(st, st.caller, 'H');
      const wrong = (st.turn + 1) % 4;
      if (G.play(st, wrong, st.hands[wrong][0])) fail('out-of-turn play accepted');
      if (G.play(st, st.turn, 'S99')) fail('fake card accepted');
      const lead = st.hands[st.turn][0];
      G.play(st, st.turn, lead);
      const p = st.turn, L = lead[0];
      const off = st.hands[p].find(x => x[0] !== L);
      if (st.hands[p].some(x => x[0] === L) && off && G.play(st, p, off)) fail('revoke (not following suit) accepted');
      ok('rules engine refuses out-of-turn, fake and not-following-suit cards');
    }
    b.send({ t: 'play', card: 'S99' });
    b.send({ t: 'trump', suit: '<script>' });
    b.send({ t: 'seat', seat: 99 });
    b.send({ t: 'nonsense' });
    await sleep(50);
    if (a.v.phase === 'lobby') fail('state broke after junk messages');
    ok('server ignores junk and fake moves');
    const handsSeen = [a, b, c].map(x => x.v.hand);
    if (JSON.stringify(a.v).includes(JSON.stringify(b.v.hand.slice().sort()))) fail('other hands leaked');
    ok('each player only receives their own cards (' + handsSeen.map(h => h.length).join('/') + ')');

    // drop Ali's connection and reconnect with the same session
    await until(() => c.v.phase === 'play', 'play phase');
    c.ws.terminate();
    await until(() => a.v.seats[c.v.me.seat].away, 'away flag');
    ok('dropped player shown as reconnecting');
    const c2 = client('Ali', c.sid);
    await c2.connect();
    await until(() => c2.v && c2.v.me.seat >= 0, 'resume seat');
    ok('reconnected into the same seat within the grace period');

    // Sara leaves mid-game -> computer takes over, rejoin makes her a watcher
    const saraSeat = b.v.me.seat;
    b.send({ t: 'leave' });
    await until(() => !a.v.seats[saraSeat].human, 'computer takeover');
    ok('Sara left, computer took seat ' + saraSeat + ' — note: ' + a.notes.at(-1));
    b.send({ t: 'join', name: 'Sara', code: code1 });
    await until(() => b.v && b.v.me.seat === -1 && b.v.hand.length === 0, 'watcher');
    ok('Sara rejoined as a watcher (no cards shown)');

    await until(() => a.v.phase === 'gameover', 'game over', 120000).catch(e => {
      console.log(JSON.stringify({ phase: a.v.phase, turn: a.v.turn, trick: a.v.trick, tricks: a.v.tricks, score: a.v.score,
        hand: a.v.handNo, seats: a.v.seats, left: a.v.left, leftFor: a.v.leftFor, c2: c2.v && { legal: c2.v.legal, seat: c2.v.me.seat } }));
      throw e;
    });
    ok(`game finished ${a.v.score[0]}–${a.v.score[1]} after ${a.v.handNo} hands`);

    c2.send({ t: 'newgame' });
    await sleep(50);
    if (a.v.phase !== 'gameover') fail('non-host started new game');
    a.send({ t: 'newgame' });
    await until(() => a.v.phase === 'lobby', 'new lobby');
    const code2 = a.v.code;
    if (code2 === code1) fail('code did not change');
    ok('new game code ' + code2 + ' (old ' + code1 + ')');
    await until(() => b.v && b.v.me.seat >= 0, 'watcher seated');
    ok('Sara got a seat in the new game');

    const d = client('Zara', 'dddddddddddddddddddd4');
    await d.connect();
    d.send({ t: 'join', name: 'Zara', code: code1 });
    await until(() => d.errors.length, 'old code rejected');
    ok('old code no longer works');

    // a full second game with 4 humans
    d.send({ t: 'join', name: 'Zara', code: code2 });
    await until(() => a.v.seats.every(s => s.human), '4 humans');
    a.send({ t: 'target', target: 5 });
    a.send({ t: 'start' });
    await until(() => a.v.phase === 'gameover', 'second game over', 120000);
    ok(`4-player game finished ${a.v.score[0]}–${a.v.score[1]}`);

    console.log('\nALL CHECKS PASSED');
  } catch (e) {
    if (!process.exitCode) { console.error(e); process.exitCode = 1; }
  } finally {
    srv.kill();
    setTimeout(() => process.exit(), 100);
  }
})();
