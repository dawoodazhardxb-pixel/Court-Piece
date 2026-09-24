'use strict';
(() => {
  const SUITS = ['S', 'H', 'C', 'D'];
  const SYM = { S: '♠', H: '♥', C: '♣', D: '♦' };
  const SNAME = { S: 'Spades', H: 'Hearts', C: 'Clubs', D: 'Diamonds' };
  const RED = { H: true, D: true };
  const RLABEL = r => ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }[r] || String(r));
  const REACTIONS = ['Shabash! 👏', '😂', 'Kya baat hai! 🔥', 'Rang lagao!', 'Jaldi karo ⏱', 'Oh no 😩', 'Sorry partner 🙏', 'GG 🤝'];
  const team = p => p % 2;
  const rk = id => +id.slice(1);
  const $ = id => document.getElementById(id);

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  let sid = store.get('cp.sid');
  if (!sid || !/^[A-Za-z0-9]{16,40}$/.test(sid)) {
    const a = new Uint8Array(16); crypto.getRandomValues(a);
    sid = Array.from(a, b => b.toString(36).padStart(2, '0')).join('').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
    store.set('cp.sid', sid);
  }

  const S = {
    ws: null, v: null, open: false, retry: 0, replaced: false, busy: false,
    deadlineAt: 0, prevTrick: [], prevTrickWinner: null, prevHandNo: -1, prevHandCount: -1,
    collecting: false, lastTurnWasMine: false, sound: store.get('cp.sound') !== 'off', resultKey: null,
  };

  // ---------------- sound ----------------
  let ac = null;
  function audio() {
    if (!S.sound) return null;
    try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    return ac;
  }
  function tone(freq, dur, type = 'sine', vol = 0.08, when = 0) {
    const a = audio(); if (!a) return;
    const t = a.currentTime + when;
    const o = a.createOscillator(), g = a.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination); o.start(t); o.stop(t + dur);
  }
  const sfx = {
    card() { tone(420, 0.07, 'triangle', 0.07); tone(260, 0.05, 'triangle', 0.05, 0.02); },
    turn() { tone(660, 0.12, 'sine', 0.07); tone(880, 0.16, 'sine', 0.07, 0.1); },
    win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.18, 'triangle', 0.07, i * 0.1)); },
    lose() { [392, 330, 262].forEach((f, i) => tone(f, 0.2, 'sine', 0.06, i * 0.12)); },
  };
  document.addEventListener('pointerdown', () => { if (S.sound) audio(); }, { once: true });

  // ---------------- connection ----------------
  function connect() {
    if (S.replaced) return;
    const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    S.ws = ws;
    ws.onopen = () => {
      S.open = true; S.retry = 0;
      $('netBanner').hidden = true;
      ws.send(JSON.stringify({ t: 'hello', sid }));
    };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } onMessage(m); };
    ws.onclose = () => {
      S.open = false;
      if (S.ws !== ws || S.replaced) return;
      if (S.v) $('netBanner').hidden = false;
      else $('homeNote').textContent = 'Connecting to the game server… (the first visit can take up to a minute)';
      const wait = Math.min(5000, 800 * 2 ** S.retry++);
      clearTimeout(S.rt); S.rt = setTimeout(connect, wait);
    };
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !S.open && !S.replaced) { clearTimeout(S.rt); connect(); }
  });
  function send(m) {
    if (S.ws && S.open) { S.ws.send(JSON.stringify(m)); return true; }
    toast('Not connected yet — trying again…');
    return false;
  }

  function onMessage(m) {
    switch (m.t) {
      case 'home': {
        const wasIn = !!S.v;
        S.v = null; S.busy = false;
        showHome();
        $('homeNote').textContent = '';
        if (wasIn && !S.leaving) $('homeErr').textContent = 'You were away too long and the computer took your seat. Enter the code again to watch — you’ll get a seat in the next game.';
        S.leaving = false;
        setJoinBusy(false);
        break;
      }
      case 'state':
        S.busy = false;
        setJoinBusy(false);
        S.v = m.s;
        S.deadlineAt = m.s.left ? Date.now() + m.s.left : 0;
        $('home').hidden = true;
        render();
        break;
      case 'error':
        setJoinBusy(false);
        if (!S.v) $('homeErr').textContent = m.text; else toast(m.text);
        break;
      case 'note': toast(m.text); break;
      case 'react': showReaction(m); break;
      case 'replaced':
        S.replaced = true;
        toast('This game is now open in another tab or device.');
        $('netBanner').textContent = 'Opened somewhere else. Reload to play here.';
        $('netBanner').hidden = false;
        break;
    }
  }

  // ---------------- home ----------------
  const nameIn = $('nameIn'), codeIn = $('codeIn');
  nameIn.value = store.get('cp.name') || '';
  let target = 7;
  const params = new URLSearchParams(location.search);
  const urlCode = (params.get('c') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
  if (urlCode) codeIn.value = urlCode;

  function myName() { return nameIn.value.trim().slice(0, 16); }
  function needName() {
    if (myName()) { store.set('cp.name', myName()); return false; }
    $('homeErr').textContent = 'Type your name first so others know who you are.';
    nameIn.focus();
    return true;
  }
  function setJoinBusy(b) { $('joinBtn').disabled = b; $('createBtn').disabled = b; }
  function showHome() {
    $('home').hidden = false;
    ['resultModal', 'leaveModal'].forEach(id => ($(id).hidden = true));
    $('scores').hidden = true; $('codeBtn').hidden = true; $('leaveBtn').hidden = true;
    clearTable();
  }
  function join() {
    $('homeErr').textContent = '';
    if (needName()) return;
    const code = codeIn.value.toUpperCase().replace(/[^A-Z]/g, '');
    if (code.length !== 5) { $('homeErr').textContent = 'Game codes are 5 letters, like KQRTM.'; codeIn.focus(); return; }
    if (send({ t: 'join', name: myName(), code })) setJoinBusy(true);
  }
  $('joinBtn').onclick = join;
  codeIn.addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
  codeIn.addEventListener('input', () => { codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z]/g, ''); });
  $('createBtn').onclick = () => {
    $('homeErr').textContent = '';
    if (needName()) return;
    if (send({ t: 'create', name: myName(), target })) setJoinBusy(true);
  };
  document.querySelectorAll('#targetOpts .opt').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('#targetOpts .opt').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    target = +b.dataset.t;
  }));

  // ---------------- helpers ----------------
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 4200);
  }
  const me = () => (S.v ? S.v.me.seat : -1);
  const viewSeat = () => Math.max(0, me());
  const relOf = p => (p - viewSeat() + 4) % 4;
  const seatOfRel = r => (viewSeat() + r) % 4;
  const pname = p => (p === me() ? 'You' : S.v.seats[p].name);
  function teamLabel(t) { return `${pname(t)} & ${pname(t + 2)}`; }
  function inviteLink() { return `${location.origin}/?c=${S.v.code}`; }
  function secsLeft() { return S.deadlineAt ? Math.max(0, Math.ceil((S.deadlineAt - Date.now()) / 1000)) : 0; }

  function cardEl(id, tag = 'div') {
    const s = id[0], r = rk(id);
    const el = document.createElement(tag);
    el.className = 'card' + (RED[s] ? ' red' : '') + (r > 10 ? ' court' : '') + (S.v && s === S.v.trump ? ' trump' : '');
    const lab = RLABEL(r);
    el.innerHTML = `<span class="cn tl">${lab}<small>${SYM[s]}</small></span><span class="pip">${r > 10 ? lab : SYM[s]}</span><span class="cn br">${lab}<small>${SYM[s]}</small></span>`;
    el.setAttribute('aria-label', `${({ J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' }[lab] || lab)} of ${SNAME[s]}`);
    return el;
  }
  function sortedHand(h) {
    const T = S.v.trump;
    const order = T ? [T, ...SUITS.filter(s => s !== T)] : SUITS;
    return [...h].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]) || rk(b) - rk(a));
  }
  function clearTable() {
    document.querySelectorAll('.slot').forEach(s => s.replaceChildren());
    document.querySelectorAll('.seat .plate, .seat .backs, .seat .count').forEach(e => e.replaceChildren());
    $('hand').replaceChildren(); $('status').textContent = '';
    ['picker', 'lobby', 'watching', 'reactBtn', 'reactions'].forEach(id => ($(id).hidden = true));
    S.prevTrick = []; S.prevHandNo = -1;
  }

  // ---------------- rendering ----------------
  function renderHeader() {
    const v = S.v;
    $('scores').hidden = false;
    $('tnA').textContent = teamLabel(0);
    $('tnB').textContent = teamLabel(1);
    $('ptsA').textContent = v.score[0];
    $('ptsB').textContent = v.score[1];
    for (const [id, t] of [['trkA', 0], ['trkB', 1]]) {
      const el = $(id); el.replaceChildren();
      for (let i = 1; i <= 13; i++) {
        const d = document.createElement('i');
        if (i <= v.tricks[t]) d.className = 'on';
        if (i === 7) d.classList.add('seven');
        el.appendChild(d);
      }
      el.title = `${v.tricks[t]} tricks this hand`;
    }
    $('rangSym').textContent = v.trump ? SYM[v.trump] : '–';
    $('rangSym').className = 'sym' + (v.trump && RED[v.trump] ? ' red' : '');
    $('rangName').textContent = v.trump ? SNAME[v.trump] : 'Rang';
    $('codeBtn').hidden = false;
    $('codeBtn').textContent = v.code;
    $('leaveBtn').hidden = false;
  }

  function renderSeats() {
    const v = S.v, my = me();
    document.querySelectorAll('.seat').forEach(seatEl => {
      const rel = +seatEl.dataset.rel, p = seatOfRel(rel), s = v.seats[p];
      const plate = seatEl.querySelector('.plate');
      const active = (v.phase === 'play' && v.turn === p) || (v.phase === 'trump' && v.caller === p);
      plate.className = 'plate ' + (team(p) === 0 ? 'a' : 'b') + (active ? ' turn' : '');
      plate.dataset.seat = p;
      plate.replaceChildren();
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = pname(p);
      plate.appendChild(nm);
      const role = document.createElement('span'); role.className = 'role';
      if (!s.human) role.textContent = v.phase === 'lobby' ? 'empty seat' : 'computer';
      else if (my >= 0 && p !== my) role.textContent = team(p) === team(my) ? 'partner' : 'opponent';
      if (role.textContent) plate.appendChild(role);
      if (s.away) { const a = document.createElement('span'); a.className = 'away'; a.textContent = 'reconnecting…'; plate.appendChild(a); }
      if (s.host) plate.insertAdjacentHTML('beforeend', '<span class="chip h" title="Game host">Host</span>');
      if (v.phase !== 'lobby' && v.dealer === p) plate.insertAdjacentHTML('beforeend', '<span class="chip d" title="Dealer">Dealer</span>');
      if (v.trump && v.caller === p && v.phase !== 'lobby') plate.insertAdjacentHTML('beforeend', `<span class="chip c" title="Called the rang">Rang ${SYM[v.trump]}</span>`);
      if (v.phase === 'lobby' && !s.human) {
        const b = document.createElement('button');
        b.className = 'sit'; b.type = 'button'; b.textContent = 'Sit here'; b.dataset.seat = p;
        plate.appendChild(b);
      }
      const n = s.count;
      const backs = rel === 0 ? $('bottomBacks') : seatEl.querySelector('.backs');
      backs.replaceChildren();
      if (rel !== 0 || my < 0) for (let i = 0; i < n; i++) { const b = document.createElement('div'); b.className = 'back'; backs.appendChild(b); }
      const cnt = seatEl.querySelector('.count');
      if (cnt) cnt.textContent = n ? `${n} card${n === 1 ? '' : 's'}` : '';
    });
  }

  function renderHand() {
    const v = S.v, hand = $('hand'), my = me();
    hand.replaceChildren();
    if (my < 0) { hand.className = 'hand'; return; }
    const cards = sortedHand(v.hand);
    const active = v.legal.length > 0 && !S.busy;
    const legal = new Set(v.legal);
    hand.className = 'hand' + (active ? ' active' : '');
    const deal = v.handNo !== S.prevHandNo || cards.length > S.prevHandCount + 1;
    cards.forEach((id, i) => {
      const el = cardEl(id, 'button');
      el.type = 'button'; el.dataset.id = id;
      if (active && legal.has(id)) el.classList.add('legal');
      else if (active) el.setAttribute('aria-disabled', 'true');
      if (deal) { el.classList.add('deal'); el.style.animationDelay = (i * 30) + 'ms'; }
      hand.appendChild(el);
    });
    S.prevHandNo = v.handNo; S.prevHandCount = cards.length;
  }

  function renderTrick() {
    const v = S.v;
    const tr = v.phase === 'lobby' ? [] : v.trick;
    const center = $('center');
    // the last trick just got cleared: sweep it toward the winner first
    if (!tr.length && S.prevTrick.length === 4 && S.prevTrickWinner != null && !S.collecting) {
      S.collecting = true;
      center.classList.add('to-' + relOf(S.prevTrickWinner));
      S.prevTrick = []; S.prevTrickWinner = null;
      setTimeout(() => {
        S.collecting = false;
        center.classList.remove('to-0', 'to-1', 'to-2', 'to-3');
        if (S.v) renderTrick();
      }, 420);
      return;
    }
    if (S.collecting) return;
    const prev = new Set(S.prevTrick.map(t => t.c));
    document.querySelectorAll('.slot').forEach(s => s.replaceChildren());
    const w = tr.length === 4 ? v.trickWinner : null;
    let fresh = false;
    for (const t of tr) {
      const el = cardEl(t.c);
      if (!prev.has(t.c)) { el.classList.add('fresh'); fresh = true; }
      if (t.p === w) el.classList.add('win');
      document.querySelector(`.slot[data-rel="${relOf(t.p)}"]`).appendChild(el);
    }
    if (fresh) sfx.card();
    S.prevTrick = tr.slice();
    S.prevTrickWinner = w;
  }

  function statusText() {
    const v = S.v, my = me(), secs = secsLeft();
    const hurry = n => (n && n <= 20 ? ` <span class="hurry">${n}s</span>` : '');
    if (v.phase === 'lobby' || v.phase === 'gameover' || v.phase === 'handover') return '';
    if (v.phase === 'trump') {
      if (v.caller === my) return '';
      return esc(`${pname(v.caller)} is choosing the rang…`) + (v.leftFor === v.caller ? hurry(secs) : '');
    }
    if (v.trick.length === 4) return esc(v.trickWinner === my ? 'You take the trick' : `${pname(v.trickWinner)} takes the trick`);
    if (v.turn === my) {
      if (!v.trick.length) return 'Your lead' + hurry(secs);
      const L = v.trick[0].c[0];
      const has = v.hand.some(x => x[0] === L);
      return (has ? `Your turn — follow ${SYM[L]}` : `No ${SYM[L]} — cut with rang or throw any card`) + hurry(secs);
    }
    if (!v.seats[v.turn].human) return '';
    return esc(`Waiting for ${pname(v.turn)}…`) + (v.leftFor === v.turn ? hurry(secs) : '');
  }
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function renderPanels() {
    const v = S.v, my = me();
    // lobby
    const lobby = $('lobby');
    lobby.hidden = v.phase !== 'lobby';
    if (!lobby.hidden) {
      $('lobbyCode').textContent = v.code;
      $('waBtn').href = 'https://wa.me/?text=' + encodeURIComponent(`Court Piece khelo! 🃏 Game code: ${v.code}\n${inviteLink()}`);
      const humans = v.seats.filter(s => s.human).length;
      const host = v.seats.find(s => s.host);
      if (v.me.host) {
        $('lobbyText').textContent = humans < 4
          ? `${humans} of 4 seats taken. Start whenever you're ready — empty seats will be played by the computer.`
          : 'All 4 seats are taken. Start when everyone is ready!';
      } else if (my < 0) {
        $('lobbyText').textContent = 'Tap "Sit here" on an empty seat to play.';
      } else {
        $('lobbyText').textContent = `Waiting for ${host ? host.name : 'the host'} to start the game.`;
      }
      $('lobbyTarget').hidden = !v.me.host;
      $('lobbyTarget').querySelectorAll('.opt').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.t === v.target)));
      $('startBtn').hidden = !v.me.host;
      $('standBtn').hidden = my < 0;
    }
    // trump picker
    const pick = v.phase === 'trump' && v.caller === my;
    const picker = $('picker');
    if (pick && picker.hidden) {
      const box = $('suits'); box.replaceChildren();
      for (const s of SUITS) {
        const n = v.hand.filter(c => c[0] === s).length;
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'suitbtn' + (RED[s] ? ' red' : ''); b.dataset.suit = s;
        b.innerHTML = `<span class="s">${SYM[s]}</span><small>${n} card${n === 1 ? '' : 's'}</small>`;
        b.setAttribute('aria-label', `${SNAME[s]}, ${n} in hand`);
        box.appendChild(b);
      }
    }
    picker.hidden = !pick;
    // watching
    const watching = $('watching');
    watching.hidden = !(my < 0 && v.phase !== 'lobby');
    if (!watching.hidden) watching.textContent = 'You’re watching this game. You’ll get a seat automatically when the next game starts.';
    $('reactBtn').hidden = false;
    // result
    const done = v.phase === 'handover' || v.phase === 'gameover';
    const key = done ? v.handNo + v.phase : null;
    if (!done) { $('resultModal').hidden = true; S.resultKey = null; }
    else {
      fillResult();
      if (S.resultKey !== key) {
        S.resultKey = key;
        $('resultModal').hidden = false;
        const mine = my >= 0 && team(my) === v.result.winner;
        if (my >= 0) (mine ? sfx.win : sfx.lose)();
        if (!$('resBtn').hidden) $('resBtn').focus();
      }
    }
  }

  function fillResult() {
    const v = S.v, my = me(), r = v.result, over = v.phase === 'gameover';
    const mine = my >= 0 && team(my) === r.winner;
    const who = teamLabel(r.winner);
    let title, text;
    if (over) {
      title = my < 0 ? `${who} win the game` : mine ? 'Game won! Shabash!' : 'Game lost';
      text = `${who} reach ${v.score[r.winner]} points.`;
    } else if (r.court) {
      title = my < 0 ? 'Court!' : mine ? 'Court! 🔥' : 'Court against you';
      text = `${who} took all 13 tricks — 3 points.`;
    } else {
      title = my < 0 ? `${who} win the hand` : mine ? 'Hand won' : 'Hand lost';
      text = `${who} took 7 tricks first. ` + (r.callerLost ? `The rang callers lost, so ${pname(v.dealer)} deals next.` : `${pname(v.dealer)} deals again.`);
    }
    $('resTitle').textContent = title;
    $('resText').textContent = text;
    $('resTricks').textContent = `${v.tricks[0]}–${v.tricks[1]}`;
    $('resScore').textContent = `${v.score[0]}–${v.score[1]}`;
    $('resTarget').textContent = v.target;
    const host = v.seats.find(s => s.host);
    $('resBtn').hidden = !(over && v.me.host);
    $('resBtn').textContent = 'New game (new code)';
    $('resWait').textContent = over
      ? (v.me.host ? 'Everyone here moves to the new game with you.' : `Waiting for ${host ? host.name : 'the host'} to start a new game…`)
      : `Next hand in ${secsLeft()}s`;
  }

  function render() {
    if (!S.v) return;
    renderHeader();
    renderSeats();
    renderHand();
    renderTrick();
    renderPanels();
    $('status').innerHTML = statusText();
    $('pickTimer').textContent = S.v.phase === 'trump' && S.v.caller === me() && secsLeft() <= 20 ? `${secsLeft()}s left` : '';
    const myTurn = S.v.legal.length > 0 || (S.v.phase === 'trump' && S.v.caller === me());
    if (myTurn && !S.lastTurnWasMine) sfx.turn();
    S.lastTurnWasMine = myTurn;
  }

  // countdowns tick without a full re-render
  setInterval(() => {
    if (!S.v || !S.deadlineAt) return;
    $('status').innerHTML = statusText();
    if (S.v.phase === 'trump' && S.v.caller === me()) $('pickTimer').textContent = secsLeft() <= 20 ? `${secsLeft()}s left` : '';
    if (!$('resultModal').hidden && S.v.phase === 'handover') $('resWait').textContent = `Next hand in ${secsLeft()}s`;
  }, 500);

  // ---------------- reactions ----------------
  REACTIONS.forEach((txt, i) => {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = txt; b.dataset.i = i;
    $('reactions').appendChild(b);
  });
  $('reactBtn').onclick = () => {
    const open = $('reactions').hidden;
    $('reactions').hidden = !open;
    $('reactBtn').setAttribute('aria-expanded', String(open));
  };
  $('reactions').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    send({ t: 'react', i: +b.dataset.i });
    $('reactions').hidden = true; $('reactBtn').setAttribute('aria-expanded', 'false');
  });
  function showReaction(m) {
    const txt = REACTIONS[m.i]; if (!txt || !S.v) return;
    if (m.seat < 0) { toast(`${m.name}: ${txt}`); return; }
    const plate = document.querySelector(`.seat[data-rel="${relOf(m.seat)}"] .plate`);
    const host = plate ? plate.parentElement.classList.contains('bottomrow') ? plate.parentElement : plate.closest('.seat') : null;
    if (!host) return;
    const b = document.createElement('div'); b.className = 'bubble'; b.textContent = txt;
    host.appendChild(b);
    setTimeout(() => b.remove(), 3200);
  }

  // ---------------- table actions ----------------
  $('hand').addEventListener('click', e => {
    const btn = e.target.closest('.card');
    if (!btn || !btn.classList.contains('legal') || S.busy) return;
    if (send({ t: 'play', card: btn.dataset.id })) { S.busy = true; renderHand(); }
  });
  $('suits').addEventListener('click', e => {
    const b = e.target.closest('.suitbtn');
    if (b && send({ t: 'trump', suit: b.dataset.suit })) $('picker').hidden = true;
  });
  $('table').addEventListener('click', e => {
    const b = e.target.closest('.sit');
    if (b) send({ t: 'seat', seat: +b.dataset.seat });
  });
  $('startBtn').onclick = () => send({ t: 'start' });
  $('standBtn').onclick = () => send({ t: 'unseat' });
  $('lobbyTarget').addEventListener('click', e => {
    const b = e.target.closest('.opt'); if (b) send({ t: 'target', target: +b.dataset.t });
  });
  $('resBtn').onclick = () => send({ t: 'newgame' });

  async function shareInvite() {
    const url = inviteLink(), text = `Court Piece khelo! 🃏 Game code: ${S.v.code}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Court Piece', text, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(`${text}\n${url}`); toast('Invite link copied — paste it in WhatsApp or anywhere.'); }
    catch { toast(`Share this code: ${S.v.code}`); }
  }
  $('shareBtn').onclick = shareInvite;
  $('codeBtn').onclick = shareInvite;

  $('leaveBtn').onclick = () => {
    const v = S.v;
    if (!v) return;
    if (v.phase === 'lobby' || me() < 0 || v.phase === 'gameover') { S.leaving = true; send({ t: 'leave' }); return; }
    $('leaveModal').hidden = false; $('leaveNo').focus();
  };
  $('leaveYes').onclick = () => { $('leaveModal').hidden = true; S.leaving = true; send({ t: 'leave' }); };
  $('leaveNo').onclick = () => { $('leaveModal').hidden = true; };

  function setSound(on) {
    S.sound = on; store.set('cp.sound', on ? 'on' : 'off');
    $('soundBtn').setAttribute('aria-pressed', String(on));
    $('soundBtn').textContent = on ? 'Sound on' : 'Sound off';
    if (on) sfx.card();
  }
  $('soundBtn').onclick = () => setSound(!S.sound);
  setSound(S.sound);

  const openRules = () => { $('rulesModal').hidden = false; $('closeRules').focus(); };
  $('rulesBtn').onclick = openRules;
  $('homeRules').onclick = openRules;
  $('closeRules').onclick = () => { $('rulesModal').hidden = true; };
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    $('rulesModal').hidden = true; $('leaveModal').hidden = true; $('reactions').hidden = true;
  });

  if (urlCode && nameIn.value) $('joinBtn').focus(); else nameIn.focus();
  connect();
})();
