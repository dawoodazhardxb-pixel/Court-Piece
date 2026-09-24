'use strict';
// Court Piece (Rang) rules engine and computer players. Pure state, no I/O.
const crypto = require('crypto');

const SUITS = ['S', 'H', 'C', 'D'];
const rk = id => +id.slice(1);
const team = p => p % 2;

function deck() {
  const d = SUITS.flatMap(s => Array.from({ length: 13 }, (_, i) => s + (i + 2)));
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function newGame(target, dealer) {
  return {
    phase: 'lobby', target, score: [0, 0], dealer, handNo: 0,
    hands: [[], [], [], []], rest: [], trick: [], trickWinner: null, tricks: [0, 0],
    played: [], voids: [{}, {}, {}, {}], trump: null, caller: null, turn: null, leader: null, result: null,
  };
}

function startHand(st) {
  const d = deck();
  st.caller = (st.dealer + 1) % 4;
  st.hands = [[], [], [], []];
  for (let i = 0; i < 5; i++) for (let k = 0; k < 4; k++) st.hands[(st.caller + k) % 4].push(d.pop());
  Object.assign(st, {
    rest: d, trump: null, trick: [], trickWinner: null, tricks: [0, 0], played: [],
    voids: [{}, {}, {}, {}], result: null, handNo: st.handNo + 1, phase: 'trump',
    turn: st.caller, leader: st.caller,
  });
}

function chooseTrump(st, p, s) {
  if (st.phase !== 'trump' || p !== st.caller || !SUITS.includes(s)) return false;
  st.trump = s;
  for (let round = 0; round < 2; round++)
    for (let k = 0; k < 4; k++)
      for (let i = 0; i < 4; i++) st.hands[(st.caller + k) % 4].push(st.rest.pop());
  st.rest = [];
  st.phase = 'play';
  st.turn = st.caller;
  st.leader = st.caller;
  return true;
}

const beats = (a, b, T) => (a[0] === b[0] ? rk(a) > rk(b) : a[0] === T);

function winnerOf(trick, T) {
  let w = trick[0];
  for (const t of trick.slice(1)) if (beats(t.c, w.c, T)) w = t;
  return w;
}

function legal(st, p) {
  if (st.phase !== 'play' || st.turn !== p || st.trick.length === 4) return [];
  const h = st.hands[p];
  if (!st.trick.length) return h.slice();
  const f = h.filter(id => id[0] === st.trick[0].c[0]);
  return f.length ? f : h.slice();
}

// Plays a card. After the 4th card the trick stays on the table (turn = null)
// until finishTrick() is called, so everyone can see who won it.
function play(st, p, id) {
  if (typeof id !== 'string' || !legal(st, p).includes(id)) return false;
  const tr = st.trick;
  if (tr.length && id[0] !== tr[0].c[0]) st.voids[p][tr[0].c[0]] = true;
  st.hands[p] = st.hands[p].filter(x => x !== id);
  tr.push({ p, c: id });
  st.played.push(id);
  if (tr.length < 4) { st.turn = (p + 1) % 4; return true; }
  const w = winnerOf(tr, st.trump).p;
  st.trickWinner = w;
  st.tricks[team(w)]++;
  st.turn = null;
  return true;
}

function checkEnd(t) {
  for (const a of [0, 1]) {
    if (t[a] === 13) return { winner: a, court: true };
    if (t[a] >= 7 && t[1 - a] > 0) return { winner: a, court: false };
  }
  return null;
}

function finishTrick(st) {
  if (st.trick.length !== 4) return;
  const w = st.trickWinner;
  st.trick = [];
  st.trickWinner = null;
  const end = checkEnd(st.tricks);
  if (end) {
    const pts = end.court ? 3 : 1;
    st.score[end.winner] += pts;
    const callerLost = team(st.caller) !== end.winner;
    st.result = { winner: end.winner, court: end.court, pts, callerLost, lastWinner: w };
    if (callerLost) st.dealer = (st.dealer + 1) % 4;
    st.phase = st.score[end.winner] >= st.target ? 'gameover' : 'handover';
    st.turn = null;
  } else {
    st.turn = w;
    st.leader = w;
  }
}

// ---------------- computer players ----------------
const low = cs => cs.reduce((a, b) => (rk(b) < rk(a) ? b : a));
const high = cs => cs.reduce((a, b) => (rk(b) > rk(a) ? b : a));

function isBoss(st, id, p) {
  for (let r = rk(id) + 1; r <= 14; r++) {
    const x = id[0] + r;
    if (!st.played.includes(x) && !st.hands[p].includes(x)) return false;
  }
  return true;
}

function aiTrump(st, p) {
  let best = 'S', bs = -1;
  for (const s of SUITS) {
    const cs = st.hands[p].filter(c => c[0] === s);
    const sc = cs.length * 12 + cs.reduce((t, c) => t + rk(c), 0);
    if (sc > bs) { bs = sc; best = s; }
  }
  return best;
}

function discard(st, p) {
  const h = st.hands[p], non = h.filter(c => c[0] !== st.trump);
  if (!non.length) return low(h);
  const len = s => h.filter(c => c[0] === s).length;
  return non.reduce((a, b) => (rk(b) < rk(a) || (rk(b) === rk(a) && len(b[0]) < len(a[0])) ? b : a));
}

function lead(st, p) {
  const h = st.hands[p], T = st.trump;
  const opps = [(p + 1) % 4, (p + 3) % 4], partner = (p + 2) % 4;
  const cut = s => opps.some(o => st.voids[o][s] && !st.voids[o][T]);
  const trumps = h.filter(c => c[0] === T), non = h.filter(c => c[0] !== T);
  const bosses = non.filter(c => isBoss(st, c, p) && !cut(c[0]));
  if (bosses.length) return high(bosses);
  const bossT = trumps.filter(c => isBoss(st, c, p));
  if (bossT.length && trumps.length >= 4) return high(bossT);
  const feed = non.filter(c => st.voids[partner][c[0]] && !st.voids[partner][T]);
  if (feed.length) return low(feed);
  if (non.length) {
    const by = {};
    for (const c of non) (by[c[0]] ||= []).push(c);
    return low(Object.values(by).sort((a, b) => b.length - a.length)[0]);
  }
  return low(trumps);
}

function follow(st, p) {
  const h = st.hands[p], T = st.trump, tr = st.trick;
  const L = tr[0].c[0];
  const win = winnerOf(tr, T), W = win.c;
  const pw = team(win.p) === team(p);
  const last = tr.length === 3, next = (p + 1) % 4;
  const nextCut = W[0] !== T && st.voids[next][L] && !st.voids[next][T];
  const safe = pw && (last || (isBoss(st, W, p) && !nextCut));
  const inSuit = h.filter(c => c[0] === L);
  if (inSuit.length) {
    if (safe) return low(inSuit);
    const winners = inSuit.filter(c => beats(c, W, T));
    if (!winners.length) return low(inSuit);
    if (last) return low(winners);
    const bw = winners.filter(c => isBoss(st, c, p));
    if (bw.length) return low(bw);
    if (pw || tr.length === 1) return low(inSuit);
    return high(winners);
  }
  if (safe) return discard(st, p);
  const cutters = h.filter(c => c[0] === T && beats(c, W, T));
  if (cutters.length) return low(cutters);
  return discard(st, p);
}

const aiCard = (st, p) => (st.trick.length ? follow(st, p) : lead(st, p));

module.exports = { SUITS, team, newGame, startHand, chooseTrump, legal, play, finishTrick, aiTrump, aiCard };
