// Lumalou: phone-first control page for the Fisher-Price Lumalou bridge (ESP32 + components/lumalou).
// Served by the board itself (web_server js_include): no internet needed. ESPHome's own UI: #advanced
// Data in:  text_sensor "Lamp data" (JSON, see Lumalou::json) + the simple entities.
// Commands: POST /text/Lamp command/set?value=<hex opcode + args>  (byte layouts: COMMANDS.md)

const COLOURS = [
  { name: 'Warm spectrum', css: 'conic-gradient(#ff7a45,#ffb347,#ff5e7e,#ff9a3c,#ff7a45)', glow: '#ff9a52' },
  { name: 'Red', css: '#ff4d5e', glow: '#ff4d5e' },
  { name: 'Yellow', css: '#ffd84d', glow: '#ffd84d' },
  { name: 'Orange', css: '#ff9a3c', glow: '#ff9a3c' },
  { name: 'Green', css: '#4cd98a', glow: '#4cd98a' },
  { name: 'Blue', css: '#4d8dff', glow: '#4d8dff' },
  { name: 'Purple', css: '#a46cff', glow: '#a46cff' },
  { name: 'Night light', css: 'radial-gradient(circle at 40% 35%,#fff3d6,#e8b86b)', glow: '#f2cf8a' },
  { name: 'Cool spectrum', css: 'conic-gradient(#4d8dff,#4fd1e8,#a46cff,#6ad0ff,#4d8dff)', glow: '#6aa8ff' },
  { name: 'Rainbow', css: 'conic-gradient(#ff4d5e,#ff9a3c,#ffd84d,#4cd98a,#4d8dff,#a46cff,#ff4d5e)', glow: '#c48bff' },
];
const SOUNDS = [
  { name: 'Sleep playlist', icon: '🎵' }, { name: 'Custom playlist', icon: '🎶' }, { name: 'Pink noise', icon: '〰️' },
  { name: 'Ocean', icon: '🌊' }, { name: 'Rain', icon: '🌧️' }, { name: 'Brown noise', icon: '🟤' },
  { name: 'Nature', icon: '🌿' }, { name: 'Highway', icon: '🚗' },
];
const SONGS = ['No song', 'Sleep Baby Sleep', 'Hour Glass', 'Frère Jacques', 'How Lovely the Evening', 'Lágrima (Tárrega)',
  'What’s the Matter, Dear', 'Suo Gân', 'Watercolor Dreams', 'Dance of the Jellyfish', 'Inside the Bubble', 'Paper Kites',
  'Crickets in Space', 'Pink noise', 'Ocean', 'Rain', 'Brown noise', 'Nature', 'Highway'];
const LIGHT_DURATIONS = ['15 min', '30 min', '1 h', '1 h 30', 'Always on', '1 min (test)'];
const MODES = ['Soother', '—', 'Daytime', 'Sleepy time', 'Pairing', 'Updating', 'Nap time', 'Routine'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEK = [1, 2, 3, 4, 5, 6, 0]; // display order Mon..Sun, values = lamp weekday (0 = Sunday)
// Alarm index on the wire: 0 at wake time, 1–8 = 15…120 min later, 9 = off, 10 = 1 min (test)
const ALARMS = [[9, 'No alarm'], [0, 'At wake time'], [1, '+15 min'], [2, '+30 min'], [3, '+45 min'], [4, '+1 h'],
  [6, '+1 h 30'], [8, '+2 h']];
const NAPS = [[1, '15 min'], [2, '30 min'], [3, '45 min'], [4, '1 h'], [6, '1 h 30'], [8, '2 h']];
const TASKS = [null, ['👕', 'Get dressed'], ['🧼', 'Wash'], ['🪥', 'Brush teeth'], ['🚽', 'Toilet'], ['🎒', 'Backpack'],
  ['🍽️', 'Eat'], ['📚', 'Book'], ['🧹', 'Tidy up'], ['❤️', 'Heart'], ['🌀', 'Swirly'], ['✨', 'Starburst']];

function advancedView() {
  const s = document.createElement('script');
  s.src = 'https://oi.esphome.io/v3/www.js';
  document.body.appendChild(s);
  const back = document.createElement('a');
  back.href = '/';
  back.textContent = '← Lamp view';
  back.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:9;padding:10px 14px;border-radius:999px;' +
    'background:#6c5ce7;color:#fff;font:600 14px system-ui,sans-serif;text-decoration:none';
  back.addEventListener('click', (e) => { e.preventDefault(); location.hash = ''; location.reload(); });
  document.body.appendChild(back);
}

// ---- small helpers ----
const pad = (n) => String(n).padStart(2, '0');
const bcd = (n) => pad(n);                                    // BCD byte as hex text = the decimal digits
const toMin = (t) => { if (!t) return null; const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const hhmm = (m) => (m == null ? '' : `${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
const hexTime = (t) => (t ? t.split(':').map((x) => bcd(Number(x))).join(' ') : 'ff ff');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function lampView() {
  setupHead();
  document.querySelector('esp-app')?.remove();
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  let D = null;                    // last "Lamp data" JSON
  let rssi = null;
  const sun = { on: null, minutes: 20 };   // sunrise wake light settings (switch + number on the board)
  let lastEvent = 0;
  const hold = {};                 // optimistic values: key -> {v, until}
  let tab = 'lamp';
  try { tab = localStorage.getItem('lumalou.tab') || 'lamp'; } catch { /* private mode */ }
  const drafts = { sleep: null, routines: {} };   // unsaved edits, so live updates don't overwrite typing
  let openDay = null;

  const app = document.createElement('main');
  app.className = 'app';
  app.innerHTML = `
    <div class="stars" aria-hidden="true"></div>
    <header>
      <h1>Lumalou</h1>
      <span class="pill" id="pill" role="status" aria-live="polite"><i></i><span>Connecting…</span></span>
    </header>
    <div class="alarmbar" id="alarmbar" hidden><span>⏰ The wake-up alarm is ringing</span><button id="stopAlarm">Stop</button></div>
    <section class="hero">
      <div class="cloudwrap" id="cloudwrap">
        <svg class="cloud" viewBox="0 0 220 150" aria-hidden="true">
          <defs><radialGradient id="cg" cx="50%" cy="45%" r="65%">
            <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="var(--glow)" stop-opacity=".95"/></radialGradient></defs>
          <path fill="url(#cg)" d="M58 128c-24 0-42-17-42-39 0-20 15-36 35-38 6-25 28-41 54-41 26 0 48 16 55 40 23 1 44 18 44 41 0 21-18 37-41 37z"/>
          <path class="star" d="M168 16l6 13 14 2-10 10 2 14-12-7-12 7 2-14-10-10 14-2z"/>
        </svg>
        <div class="lampclock" id="lampclock"></div>
      </div>
      <div class="now" id="now">—</div>
      <div class="sub" id="sub"></div>
    </section>
    <nav class="tabs" id="tabs" role="tablist">
      <button data-tab="lamp" role="tab">💡<span>Lamp</span></button>
      <button data-tab="sleep" role="tab">🌙<span>Sleep</span></button>
      <button data-tab="routines" role="tab">✅<span>Routines</span></button>
      <button data-tab="clock" role="tab">🕰️<span>Clock</span></button>
    </nav>
    <div id="panel"></div>
    <footer><span id="meta"></span> · <a href="#" id="refresh">Refresh</a> · <a href="#advanced" id="adv">Advanced</a></footer>
    <div class="toast" id="toast" role="alert"></div>`;
  document.body.appendChild(app);

  const $ = (id) => document.getElementById(id);
  const enc = encodeURIComponent;

  // ---- talking to the bridge ----
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }
  function post(path) {
    return fetch(path, { method: 'POST' })
      .then((r) => { if (!r.ok) throw new Error(r.status); })
      .catch(() => { toast('Couldn’t reach the lamp bridge. Are you on the home WiFi?'); throw new Error('net'); });
  }
  // Commands go one by one (the bridge queues them for the lamp; a short gap keeps the order on slow phones).
  let chain = Promise.resolve();
  function cmd(hex) {
    chain = chain.then(() => post(`/text/${enc('Lamp command')}/set?value=${enc(hex)}`)).then(() => new Promise((r) => setTimeout(r, 120)));
    return chain.catch(() => { chain = Promise.resolve(); });
  }
  const press = (name) => post(`/button/${enc(name)}/press`).catch(() => {});
  const setHold = (k, v) => { hold[k] = { v, until: Date.now() + 6000 }; };
  const held = (k, v) => (hold[k] && hold[k].until > Date.now() ? hold[k].v : v);
  const g = () => (D && D.g) || {};

  // ---- tabs ----
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    tab = b.dataset.tab;
    try { localStorage.setItem('lumalou.tab', tab); } catch { /* ignore */ }
    renderPanel(true);
  });
  $('refresh').addEventListener('click', (e) => { e.preventDefault(); press('Refresh'); toast('Reading everything from the lamp…'); });
  $('adv').addEventListener('click', (e) => { e.preventDefault(); location.hash = 'advanced'; location.reload(); });
  $('stopAlarm').addEventListener('click', () => {
    cmd('03 01');
    if (g().mode === 7) cmd('6b 04');
  });

  // ---- panels ----
  function panelLamp() {
    const c = held('colour', g().light === 0 ? 10 : g().colour);
    return `
    <section class="card">
      <div class="row"><h2>Light</h2><button class="ghost" data-act="lightOff">Turn off</button></div>
      <div class="swatches">
        ${COLOURS.map((x, i) => `<button class="sw" data-colour="${i}" aria-pressed="${i === c}" style="--sw:${x.css}" aria-label="${x.name}"><span></span><b>${x.name}</b></button>`).join('')}
      </div>
      <label class="slab"><span>Brightness</span><output id="bv">${held('brightness', g().brightness) ?? '–'}</output></label>
      <input type="range" min="0" max="9" step="1" data-num="brightness" value="${held('brightness', g().brightness) ?? 5}">
      <label class="slab"><span>Light stays on for</span></label>
      <div class="chips">${LIGHT_DURATIONS.map((t, i) => `<button class="chip" data-ld="${i}" aria-pressed="${i === g().lightDuration}">${t}</button>`).join('')}</div>
    </section>
    <section class="card">
      <div class="row"><h2>Sound</h2><button class="ghost" data-act="soundOff">Stop</button></div>
      <div class="nowplaying">${g().music === 1 && g().song > 0 ? `▶ ${esc(SONGS[g().song] || '')}` : g().music === 1 ? '▶ Playing' : 'Not playing'}</div>
      <div class="sounds">
        ${SOUNDS.map((s, i) => `<button class="snd" data-sound="${i}"><span class="ico">${s.icon}</span>${s.name}</button>`).join('')}
      </div>
      <label class="slab"><span>Volume</span><output id="vv">${held('volume', g().volume) ?? '–'}</output></label>
      <input type="range" min="0" max="9" step="1" data-num="volume" value="${held('volume', g().volume) ?? 5}">
    </section>
    ${panelSongs()}`;
  }

  // The lamp's 12 built-in songs, one by one. The lamp can only play a single song through its custom playlist, so this
  // puts that one song in the playlist; the user's own playlist is remembered here and can be put back.
  const SONG_ICON = ['', '🌙', '⏳', '🔔', '🌅', '🎸', '💭', '🏴', '🎨', '🪼', '🫧', '🪁', '🦗'];
  const savedPlaylist = () => { try { return JSON.parse(localStorage.getItem('lumalou.playlist') || 'null'); } catch { return null; } };
  function rememberPlaylist() {
    const p = D?.playlist || [];
    if (p.filter((x) => x > 0).length > 1) { try { localStorage.setItem('lumalou.playlist', JSON.stringify(p)); } catch { /* ignore */ } }
  }
  function panelSongs() {
    const p = D?.playlist || [];
    const playing = g().music === 1 ? g().song : 0;
    const single = p.filter((x) => x > 0).length === 1;
    const editing = drafts.playlist;
    const list = editing || p.filter((x) => x > 0);
    return `
    <section class="card">
      <div class="row"><h2>🎵 Songs</h2><button class="ghost" data-act="soundOff">Stop</button></div>
      <div class="songs">
        ${SONGS.slice(1, 13).map((s, i) => `<button class="song" data-song="${i + 1}" aria-pressed="${playing === i + 1}">
          <span class="ico">${SONG_ICON[i + 1]}</span><span>${esc(s)}</span>${playing === i + 1 ? '<i class="eq"><b></b><b></b><b></b></i>' : ''}</button>`).join('')}
      </div>
    </section>
    <section class="card">
      <div class="row"><h2>My playlist</h2>${editing ? '' : '<button class="ghost" data-act="editPl">Edit</button>'}</div>
      <p class="hint">${editing ? 'Tap songs below to add them in order (up to 12); tap a numbered one to remove it.'
        : single && savedPlaylist() ? 'A single song is loaded right now (from the song list above).' : 'Plays with “Custom playlist” in the Sound card.'}</p>
      <div class="seq">${list.length ? list.map((s, i) => `<button class="tk on" ${editing ? `data-plrm="${i}"` : 'disabled'} title="${esc(SONGS[s] || '')}">${SONG_ICON[s] || '♪'}<small>${i + 1}</small></button>`).join('') : '<span class="hint">Empty</span>'}</div>
      ${editing ? `<div class="pick">${SONGS.slice(1, 13).map((s, i) => `<button class="tk" data-pladd="${i + 1}" ${list.length >= 12 ? 'disabled' : ''}>${SONG_ICON[i + 1]}<small>${esc(s)}</small></button>`).join('')}</div>
        <div class="btnrow"><button class="ghost" data-act="cancelPl">Cancel</button><button class="primary" data-act="savePl" ${list.length ? '' : 'disabled'}>Save playlist to Lumalou</button></div>`
        : single && savedPlaylist() ? '<button class="ghost wide" data-act="restorePl">Put my playlist back</button>' : ''}
    </section>`;
  }

  // Sleep trainer: per night D (D = evening's weekday): bedtime sleepy[D], wake r2r[D+1], alarm alarms[D+1]
  function sleepModel() {
    if (drafts.sleep) return drafts.sleep;
    const nights = {};
    for (let d = 0; d < 7; d++) {
      const n = (d + 1) % 7;
      nights[d] = { bed: D?.sleepy?.[d] || '', wake: D?.wake?.[n] || '', alarm: D?.alarms?.[n] ?? 9 };
    }
    return nights;
  }
  // Next morning with a wake time (device r2r slots are mornings), and when its sunrise starts.
  function nextSunrise() {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    for (let i = 0; i < 8; i++) {
      const wd = (now.getDay() + i) % 7;
      const w = toMin(D?.wake?.[wd]);
      if (w == null || (i === 0 && w <= nowMin)) continue;
      const start = w - (sun.minutes || 20);
      return { day: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : DAYS[wd], start: hhmm((start + 1440) % 1440), wake: hhmm(w) };
    }
    return null;
  }
  function panelSunrise() {
    const n = nextSunrise();
    const running = D?.sunrise;
    return `
    <section class="card sunrise">
      <div class="row"><h2>🌅 Sunrise wake light</h2>
        <div class="seg"><button data-sun="on" aria-pressed="${sun.on === true}">On</button><button data-sun="off" aria-pressed="${sun.on === false}">Off</button></div></div>
      <div class="sunbar"><span></span></div>
      <p class="hint">${running ? (running === 'demo' ? '☀️ Demo sunrise running…' : '☀️ Sunrise in progress') :
        !n ? 'Set a wake-up time below and the light will slowly fade in before it.' :
        sun.on === false ? `Off. Next wake-up: ${n.day} ${n.wake}.` :
        `Next: <b>${n.day} ${n.start}</b> → fades red, orange, yellow until <b>${n.wake}</b>.`}</p>
      <label class="slab"><span>Fade-in time</span></label>
      <div class="chips">${[10, 20, 30, 45, 60].map((v) => `<button class="chip" data-sunmin="${v}" aria-pressed="${sun.minutes === v}">${v} min</button>`).join('')}</div>
      <button class="ghost wide" data-act="testSun" ${running ? 'disabled' : ''}>Try it now (2-minute demo)</button>
    </section>`;
  }
  function panelSleep() {
    const m = sleepModel();
    const napping = g().mode === 6;
    const any = Object.values(m).some((x) => x.bed || x.wake);
    return panelSunrise() + `
    <section class="card">
      <div class="row"><h2>Sleep trainer</h2><span class="tag ${any ? 'on' : ''}">${any ? 'Scheduled' : 'Not set'}</span></div>
      <p class="hint">Per night: when Lumalou turns to sleepy time, and when it shows it’s OK to get up. The alarm is optional.</p>
      <div class="nights">
        ${WEEK.map((d) => {
          const x = m[d];
          return `<div class="night" data-night="${d}">
            <div class="nname">${SHORT[d]}<small>night</small></div>
            <label class="tin"><span>🌙</span><input type="time" data-f="bed" value="${x.bed}"></label>
            <label class="tin"><span>☀️</span><input type="time" data-f="wake" value="${x.wake}"></label>
            <select data-f="alarm" aria-label="Alarm">${ALARMS.map(([v, t]) => `<option value="${v}" ${v === x.alarm ? 'selected' : ''}>${t}</option>`).join('')}</select>
          </div>`;
        }).join('')}
      </div>
      <div class="btnrow">
        <button class="ghost" data-act="copyMon">Copy Monday to weekdays</button>
        <button class="ghost" data-act="clearSleep">Clear all</button>
      </div>
      <button class="primary" data-act="saveSleep" ${drafts.sleep ? '' : 'disabled'}>${drafts.sleep ? 'Save schedule to Lumalou' : 'Saved on the lamp'}</button>
    </section>
    <section class="card">
      <div class="row"><h2>Nap</h2><span class="tag ${napping ? 'on' : ''}">${napping ? 'Napping now' : 'Off'}</span></div>
      <div class="chips">${NAPS.map(([v, t]) => `<button class="chip" data-nap="${v}">${t}</button>`).join('')}</div>
      <button class="ghost wide" data-act="stopNap" ${napping ? '' : 'disabled'}>Stop nap</button>
    </section>`;
  }

  function routineModel(d) {
    if (drafts.routines[d]) return drafts.routines[d];
    const r = D?.routines?.[d];
    return { start: r?.start && r.start !== '00:00' || (r?.tasks?.length) ? r.start : (r ? '' : ''), tasks: r?.tasks ? [...r.tasks] : [] };
  }
  function panelRoutines() {
    const inRoutine = g().mode === 7;
    const st = D?.taskStatus || [];
    const step = D?.taskStep ?? 0;
    return `
    <section class="card">
      <div class="row"><h2>Routine now</h2><span class="tag ${inRoutine ? 'on' : ''}">${inRoutine ? `Step ${step}` : 'Idle'}</span></div>
      ${inRoutine ? `<div class="progress">${TASKS.slice(1).map((t, i) => st[i] > 0 ? `<span class="pt s${st[i]}" title="${t[1]}">${t[0]}</span>` : '').join('')}</div>` : ''}
      <div class="btnrow">
        <button class="ghost" data-act="rStart">▶ Start</button>
        <button class="ghost" data-act="rPrev" ${inRoutine ? '' : 'disabled'}>◀ Back</button>
        <button class="ghost" data-act="rNext" ${inRoutine ? '' : 'disabled'}>Done ✓</button>
        <button class="ghost" data-act="rCancel" ${inRoutine ? '' : 'disabled'}>✕ Stop</button>
      </div>
      <label class="slab"><span>Routine volume</span><output>${g().routineVolume ?? '–'}</output></label>
      <input type="range" min="0" max="9" step="1" data-num="routineVolume" value="${g().routineVolume ?? 5}">
      <div class="btnrow">
        <button class="ghost" data-act="rOn">Routines on</button><button class="ghost" data-act="rOff">Routines off</button>
      </div>
    </section>
    <section class="card">
      <h2>Weekly routines</h2>
      <p class="hint">Pick a start time and the tasks in order (up to 12). Tap a day to edit.</p>
      ${WEEK.map((d) => {
        const r = routineModel(d);
        const open = openDay === d;
        const dirty = !!drafts.routines[d];
        return `<div class="rday ${open ? 'open' : ''}" data-day="${d}">
          <button class="rhead" data-act="toggleDay">
            <b>${DAYS[d]}</b>
            <span class="rsum">${r.tasks.length ? `${r.start || '--:--'} · ${r.tasks.map((t) => TASKS[t]?.[0] || '').join(' ')}` : 'No routine'}</span>
            <span class="chev">${open ? '▴' : '▾'}</span>
          </button>
          ${open ? `<div class="rbody">
            <label class="tin big"><span>Starts at</span><input type="time" data-f="rstart" value="${r.start || ''}"></label>
            <div class="seq">${r.tasks.length ? r.tasks.map((t, i) => `<button class="tk on" data-rm="${i}" title="Remove">${TASKS[t]?.[0]}<small>${i + 1}</small></button>`).join('') : '<span class="hint">No tasks yet: add some below.</span>'}</div>
            <div class="pick">${TASKS.slice(1).map((t, i) => `<button class="tk" data-add="${i + 1}" ${r.tasks.length >= 12 ? 'disabled' : ''}>${t[0]}<small>${t[1]}</small></button>`).join('')}</div>
            <div class="btnrow">
              <button class="ghost" data-act="clearDay">Clear day</button>
              <button class="primary" data-act="saveDay" ${dirty ? '' : 'disabled'}>${dirty ? 'Save to Lumalou' : 'Saved'}</button>
            </div>
          </div>` : ''}
        </div>`;
      }).join('')}
    </section>`;
  }

  function panelClock() {
    const c = D?.clock || {};
    return `
    <section class="card">
      <div class="row"><h2>Lamp clock</h2><button class="ghost" data-act="syncClock">Sync now</button></div>
      <div class="bigtime">${D?.lampTime ? D.lampTime.slice(0, 5) : '--:--'}<small>${D?.lampWeekday != null ? DAYS[D.lampWeekday] : ''}</small></div>
      <p class="hint">The bridge sets the lamp’s clock from internet time when it connects and every night at 03:00.</p>
    </section>
    <section class="card">
      <div class="row"><h2>Clock display</h2>
        <div class="seg"><button data-clk="on" aria-pressed="${c.on === 1}">On</button><button data-clk="off" aria-pressed="${c.on === 0}">Off</button></div></div>
      <label class="slab"><span>Display brightness</span><output>${c.brightness ?? '–'}</output></label>
      <input type="range" min="0" max="9" step="1" data-num="clockBrightness" value="${c.brightness ?? 2}">
      <label class="slab"><span>Format</span></label>
      <div class="seg wide"><button data-fmt="0" aria-pressed="${c.h24 === 0}">12 h</button><button data-fmt="1" aria-pressed="${c.h24 === 1}">24 h</button></div>
    </section>`;
  }

  const PANELS = { lamp: panelLamp, sleep: panelSleep, routines: panelRoutines, clock: panelClock };
  function renderPanel(force) {
    // don't rebuild while the user is typing a time or choosing in a menu
    const a = document.activeElement;
    if (!force && a && $('panel').contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT')) return;
    document.querySelectorAll('#tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    $('panel').innerHTML = PANELS[tab]();
    const dis = !(D && D.connected);
    $('panel').querySelectorAll('button,input,select').forEach((el) => { if (dis) el.disabled = true; });
  }

  // ---- panel events (one delegated handler) ----
  function clockCmd(on, bright, h24) {
    const c = D?.clock || {};
    on = on ?? c.on ?? 1; bright = bright ?? c.brightness ?? 2; h24 = h24 ?? c.h24 ?? 0;
    cmd(`79 0${on} ${bright}${h24}`);
  }
  $('panel').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    const night = b.closest('[data-night]');
    const dayEl = b.closest('[data-day]');
    if (b.dataset.colour) { setHold('colour', Number(b.dataset.colour)); cmd(`3c ${pad(Number(b.dataset.colour).toString(16))}`); render(); return; }
    if (b.dataset.sound) { cmd(`3f 0${b.dataset.sound}`); toast(`Playing ${SOUNDS[b.dataset.sound].name}`); return; }
    if (b.dataset.song) {
      const s = Number(b.dataset.song);
      rememberPlaylist();
      cmd('38');
      cmd('40 ' + [s, ...Array(11).fill(0)].map((x) => pad(x.toString(16))).join(' '));
      cmd('3f 01');
      setTimeout(() => cmd('53'), 1500);
      toast(`Playing ${SONGS[s]}`);
      return;
    }
    if (b.dataset.pladd) {
      const l = [...(drafts.playlist || [])];
      if (l.length < 12) l.push(Number(b.dataset.pladd));
      drafts.playlist = l; renderPanel(true); return;
    }
    if (b.dataset.plrm) {
      const l = [...(drafts.playlist || [])]; l.splice(Number(b.dataset.plrm), 1);
      drafts.playlist = l; renderPanel(true); return;
    }
    if (b.dataset.ld) { cmd(`6c 0${b.dataset.ld}`); return; }
    if (b.dataset.nap) { cmd(`4d 0${b.dataset.nap}`); toast('Nap started'); return; }
    if (b.dataset.clk) { clockCmd(b.dataset.clk === 'on' ? 1 : 0); return; }
    if (b.dataset.sun) {
      sun.on = b.dataset.sun === 'on'; renderPanel(true);
      post(`/switch/${enc('Sunrise wake light')}/${sun.on ? 'turn_on' : 'turn_off'}`).catch(() => {}); return;
    }
    if (b.dataset.sunmin) {
      sun.minutes = Number(b.dataset.sunmin); renderPanel(true);
      post(`/number/${enc('Sunrise minutes')}/set?value=${sun.minutes}`).catch(() => {}); return;
    }
    if (b.dataset.fmt) { clockCmd(null, null, Number(b.dataset.fmt)); return; }
    if (b.dataset.add && dayEl) {
      const d = Number(dayEl.dataset.day); const r = { ...routineModel(d), tasks: [...routineModel(d).tasks] };
      if (r.tasks.length < 12) r.tasks.push(Number(b.dataset.add));
      drafts.routines[d] = r; renderPanel(true); return;
    }
    if (b.dataset.rm && dayEl) {
      const d = Number(dayEl.dataset.day); const r = { ...routineModel(d), tasks: [...routineModel(d).tasks] };
      r.tasks.splice(Number(b.dataset.rm), 1);
      drafts.routines[d] = r; renderPanel(true); return;
    }
    switch (b.dataset.act) {
      case 'lightOff': setHold('colour', 10); cmd('3e'); render(); break;
      case 'soundOff': cmd('38'); break;
      case 'copyMon': {
        const m = JSON.parse(JSON.stringify(sleepModel()));
        [2, 3, 4, 5].forEach((d) => { m[d] = { ...m[1] }; });   // Tue..Fri nights from Monday night
        drafts.sleep = m; renderPanel(true); break;
      }
      case 'clearSleep': {
        const m = {}; for (let d = 0; d < 7; d++) m[d] = { bed: '', wake: '', alarm: 9 };
        drafts.sleep = m; renderPanel(true); break;
      }
      case 'saveSleep': {
        const m = sleepModel();
        const sleepy = [], wake = [], alarm = [];
        for (let d = 0; d < 7; d++) {                                 // device slot d
          sleepy.push(hexTime(m[d].bed));
          const prev = (d + 6) % 7;                                  // the night before morning d
          wake.push(hexTime(m[prev].wake));
          alarm.push(m[prev].wake ? m[prev].alarm : 9);
        }
        const nib = (a, b) => (a << 4 | b).toString(16).padStart(2, '0');
        const any = Object.values(m).some((x) => x.bed || x.wake);
        cmd('48 ' + sleepy.join(' '));
        cmd('46 ' + wake.join(' '));
        cmd(`4a ${nib(alarm[0], alarm[1])} ${nib(alarm[2], alarm[3])} ${nib(alarm[4], alarm[5])} ${nib(alarm[6], 0)}`);
        cmd(any ? '44 01' : '44 00');
        drafts.sleep = null; toast('Sleep schedule saved to Lumalou'); setTimeout(() => renderPanel(true), 300);
        break;
      }
      case 'stopNap': cmd('4d 00'); break;
      case 'rStart': cmd('7b'); toast('Routine started'); break;
      case 'rPrev': cmd('6b 01'); break;
      case 'rNext': cmd((D?.taskStep ?? 0) > 0 ? '6b 00' : '6b 02'); break;
      case 'rCancel': cmd('6b 04'); break;
      case 'rOn': cmd('58 01'); toast('Routines on'); break;
      case 'rOff': cmd('58 00'); toast('Routines off'); break;
      case 'toggleDay': { const d = Number(dayEl.dataset.day); openDay = openDay === d ? null : d; renderPanel(true); break; }
      case 'clearDay': { const d = Number(dayEl.dataset.day); drafts.routines[d] = { start: '', tasks: [] }; renderPanel(true); break; }
      case 'saveDay': {
        const d = Number(dayEl.dataset.day); const r = routineModel(d);
        const slots = []; for (let i = 0; i < 12; i++) slots.push(((i + 1) << 4 | (r.tasks[i] || 0)).toString(16).padStart(2, '0'));
        if (g().mode === 7) cmd('6b 04');                             // the app cancels a running routine first
        cmd(`${(0x5a + 2 * d).toString(16)} ${r.tasks.length ? hexTime(r.start) : 'ff ff'} ${slots.join(' ')}`);
        delete drafts.routines[d]; toast(`${DAYS[d]} routine saved`); setTimeout(() => renderPanel(true), 300);
        break;
      }
      case 'syncClock': press('Sync lamp clock'); toast('Setting the lamp clock…'); break;
      case 'testSun': press('Test sunrise'); toast('Watch the lamp: a 2-minute sunrise'); break;
      case 'editPl': drafts.playlist = (D?.playlist || []).filter((x) => x > 0 && x <= 12); renderPanel(true); break;
      case 'cancelPl': delete drafts.playlist; renderPanel(true); break;
      case 'savePl': {
        const l = drafts.playlist || [];
        cmd('40 ' + [...l, ...Array(12 - l.length).fill(0)].map((x) => pad(x.toString(16))).join(' '));
        try { localStorage.setItem('lumalou.playlist', JSON.stringify(l)); } catch { /* ignore */ }
        delete drafts.playlist; toast('Playlist saved to Lumalou'); setTimeout(() => renderPanel(true), 300);
        break;
      }
      case 'restorePl': {
        const l = savedPlaylist() || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        cmd('40 ' + [...l, ...Array(12 - l.length).fill(0)].slice(0, 12).map((x) => pad(x.toString(16))).join(' '));
        toast('Your playlist is back');
        break;
      }
      default: break;
    }
  });
  $('panel').addEventListener('change', (e) => {
    const el = e.target;
    const night = el.closest('[data-night]');
    const dayEl = el.closest('[data-day]');
    if (night) {
      const m = JSON.parse(JSON.stringify(sleepModel()));
      const d = Number(night.dataset.night);
      if (el.dataset.f === 'alarm') m[d].alarm = Number(el.value); else m[d][el.dataset.f] = el.value;
      drafts.sleep = m; renderPanel(true); return;
    }
    if (dayEl && el.dataset.f === 'rstart') {
      const d = Number(dayEl.dataset.day);
      drafts.routines[d] = { ...routineModel(d), tasks: [...routineModel(d).tasks], start: el.value };
      renderPanel(true); return;
    }
    if (el.dataset.num) {
      const v = Number(el.value);
      const k = el.dataset.num;
      if (k === 'brightness') { setHold('brightness', v); cmd(`3a 0${v}`); }
      if (k === 'volume') { setHold('volume', v); cmd(`37 0${v}`); }
      if (k === 'routineVolume') cmd(`77 0${v}`);
      if (k === 'clockBrightness') clockCmd(null, v);
    }
  });
  $('panel').addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.num) { const o = el.previousElementSibling?.querySelector('output'); if (o) o.textContent = el.value; }
  });

  // ---- state in ----
  function route(d) {
    const id = d.name_id || '';
    if (id === 'text_sensor/Lamp data') {
      try { D = JSON.parse(d.value ?? d.state); } catch { return; }
      render(); renderPanel(false);
    } else if (id === 'sensor/Lamp Bluetooth signal') { rssi = typeof d.value === 'number' ? d.value : null; render(); }
    else if (id === 'switch/Sunrise wake light') { sun.on = d.value === true || d.state === 'ON'; renderPanel(false); }
    else if (id === 'number/Sunrise minutes') { const v = Number(d.value); if (Number.isFinite(v)) sun.minutes = v; renderPanel(false); }
  }
  let es = null;
  function connect() {
    if ((es && es.readyState !== EventSource.CLOSED) || document.hidden) return;
    es?.close();
    es = new EventSource('/events');
    es.addEventListener('ping', () => { lastEvent = Date.now(); render(); });
    es.addEventListener('state', (ev) => { lastEvent = Date.now(); try { route(JSON.parse(ev.data)); } catch { /* ignore */ } });
  }
  const getJSON = (p) => fetch(p, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));
  function poll() {
    getJSON(`/text_sensor/${enc('Lamp data')}`).then((d) => { lastEvent = Date.now(); route(d); }).catch(() => {});
    getJSON(`/sensor/${enc('Lamp Bluetooth signal')}`).then(route).catch(() => {});
    getJSON(`/switch/${enc('Sunrise wake light')}`).then(route).catch(() => {});
    getJSON(`/number/${enc('Sunrise minutes')}`).then(route).catch(() => {});
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { es?.close(); es = null; return; }
    poll(); connect();
  });
  poll(); connect();
  setInterval(() => {
    if (document.hidden) return;
    if (!es || es.readyState !== EventSource.OPEN || Date.now() - lastEvent > 30000) { poll(); connect(); }
    render();
  }, 5000);

  // ---- header / hero ----
  function render() {
    const live = Date.now() - lastEvent < 30000;
    const [cls, text] = !live ? ['bad', 'Reconnecting…'] : !D ? ['', 'Connecting…']
      : D.connected ? ['live', 'Connected'] : ['warn', 'Lamp not connected'];
    $('pill').className = 'pill ' + cls;
    $('pill').lastElementChild.textContent = text;
    const G = g();
    const c = held('colour', G.light === 0 ? 10 : G.colour);
    const on = c != null && c >= 0 && c < 10;
    document.documentElement.style.setProperty('--glow', on ? COLOURS[c].glow : '#5b6478');
    const lvl = held('brightness', G.brightness) ?? 5;
    $('cloudwrap').style.setProperty('--lvl', on ? (0.35 + lvl / 9 * 0.65).toFixed(2) : '0');
    $('cloudwrap').classList.toggle('off', !on);
    $('lampclock').textContent = D?.clock?.on === 1 && D?.lampTime ? D.lampTime.slice(0, 5) : '';
    $('now').textContent = !D ? 'Loading…' : on ? COLOURS[c].name : 'Light off';
    const bits = [];
    if (G.mode != null && G.mode >= 0 && G.mode !== 0) bits.push(MODES[G.mode]);
    if (G.music === 1) bits.push(G.song > 0 ? `♪ ${SONGS[G.song]}` : '♪ Playing');
    if (G.volume != null) bits.push(`Volume ${held('volume', G.volume)}`);
    $('sub').textContent = bits.join(' · ');
    $('alarmbar').hidden = G.alarm !== 1;
    const m = [];
    if (rssi != null) m.push(`Bluetooth ${rssi} dBm`);
    if (D?.fw) m.push(`Lamp firmware ${D.fw}`);
    $('meta').textContent = m.join(' · ') || 'Lumalou bridge';
  }
  render();
  renderPanel(true);
}

function setupHead() {
  const add = (tag, attrs) => { const el = document.createElement(tag); Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v)); document.head.appendChild(el); return el; };
  add('meta', { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' });
  add('meta', { name: 'theme-color', content: '#141433' });
  add('meta', { name: 'mobile-web-app-capable', content: 'yes' });
  add('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' });
  add('meta', { name: 'apple-mobile-web-app-title', content: 'Lumalou' });
  document.title = 'Lumalou';
  try { // home-screen icon: a cloud with a star, drawn at runtime
    const c = document.createElement('canvas'); c.width = c.height = 180;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 180); grad.addColorStop(0, '#2b2a6b'); grad.addColorStop(1, '#141433');
    g.fillStyle = grad; g.fillRect(0, 0, 180, 180);
    g.fillStyle = '#ffe7b0';
    [[62, 112, 34], [92, 92, 42], [124, 108, 32], [90, 120, 36]].forEach(([x, y, r]) => { g.beginPath(); g.arc(x, y, r, 0, 7); g.fill(); });
    g.fillStyle = '#fff'; g.beginPath();
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 9 : 20; g.lineTo(138 + r * Math.cos(a), 42 + r * Math.sin(a)); }
    g.fill();
    const url = c.toDataURL('image/png');
    document.querySelectorAll('link[rel~="icon"]').forEach((l) => l.remove());
    add('link', { rel: 'icon', href: url }); add('link', { rel: 'apple-touch-icon', href: url });
  } catch { /* no canvas */ }
}

const CSS = `
:root{--bg1:#141433;--bg2:#2b2a6b;--card:rgba(255,255,255,.07);--line:rgba(255,255,255,.12);--text:#f4f2ff;--muted:#b7b3d9;--accent:#a99cff;--glow:#ff9a52;color-scheme:dark}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;min-height:100%;background:linear-gradient(180deg,var(--bg2),var(--bg1) 55%) fixed;color:var(--text);font:16px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
body{padding:calc(env(safe-area-inset-top) + 14px) 16px calc(env(safe-area-inset-bottom) + 24px)}
button,select,input{font:inherit;color:inherit}
button{border:0;background:none;cursor:pointer;touch-action:manipulation}
button:disabled,input:disabled,select:disabled{opacity:.4;cursor:default}
.app{position:relative;max-width:480px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.stars{position:fixed;inset:0;pointer-events:none;z-index:-1;background-image:radial-gradient(1.5px 1.5px at 20% 15%,#fff8,transparent),radial-gradient(1px 1px at 70% 8%,#fff9,transparent),radial-gradient(1.5px 1.5px at 85% 30%,#fff6,transparent),radial-gradient(1px 1px at 40% 40%,#fff5,transparent),radial-gradient(1px 1px at 10% 60%,#fff6,transparent),radial-gradient(1.5px 1.5px at 60% 70%,#fff4,transparent),radial-gradient(1px 1px at 90% 85%,#fff5,transparent)}
header{display:flex;align-items:center;justify-content:space-between}
h1{margin:0;font-size:26px;font-weight:700;letter-spacing:-.02em}
h2{margin:0;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.pill{display:inline-flex;align-items:center;gap:7px;padding:6px 11px;border-radius:999px;background:var(--card);color:var(--muted);font-size:13px;font-weight:500}
.pill i{width:8px;height:8px;border-radius:50%;background:#8a86ad}
.pill.live i{background:#4cd98a;box-shadow:0 0 8px #4cd98a}.pill.warn i{background:#ffb347}.pill.bad i{background:#ff4d5e}
.alarmbar{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border-radius:16px;background:linear-gradient(135deg,#ff9a3c,#ff4d5e);font-weight:600;animation:pulse 1.2s infinite alternate}
.alarmbar[hidden]{display:none}
.alarmbar button{padding:8px 16px;border-radius:999px;background:#fff;color:#c2253a;font-weight:700}
@keyframes pulse{to{filter:brightness(1.15)}}
.hero{text-align:center;padding:2px 0 0}
.cloudwrap{--lvl:.8;position:relative;width:min(62vw,230px);margin:0 auto}
.cloudwrap::before{content:"";position:absolute;inset:-18%;border-radius:50%;background:radial-gradient(circle,var(--glow),transparent 65%);opacity:var(--lvl);filter:blur(18px);transition:opacity .5s,background .5s}
.cloud{position:relative;width:100%;display:block;filter:drop-shadow(0 6px 24px rgba(0,0,0,.35))}
.cloud .star{fill:#fff;opacity:.95}
.cloudwrap.off .cloud path:first-child{fill:#5b6478}.cloudwrap.off .star{fill:#8a86ad}
.lampclock{position:absolute;left:0;right:8%;top:52%;transform:translateY(-50%);font:600 22px/1 ui-monospace,Consolas,monospace;color:rgba(40,30,70,.75);letter-spacing:.06em;pointer-events:none}
.now{margin-top:8px;font-size:22px;font-weight:600}
.sub{min-height:20px;color:var(--muted);font-size:14px}
.tabs{position:sticky;top:6px;z-index:5;display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:5px;border-radius:20px;background:rgba(20,20,51,.75);border:1px solid var(--line);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.tabs button{display:flex;flex-direction:column;align-items:center;gap:2px;padding:8px 0;border-radius:15px;font-size:18px;color:var(--muted)}
.tabs button span{font-size:12px;font-weight:600}
.tabs button[aria-selected=true]{background:linear-gradient(135deg,#6c5ce7,#a46cff);color:#fff;box-shadow:0 4px 16px rgba(108,92,231,.45)}
#panel{display:flex;flex-direction:column;gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:24px;padding:18px;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}
.hint{margin:4px 0 12px;color:var(--muted);font-size:14px}
.tag{padding:4px 10px;border-radius:999px;background:rgba(255,255,255,.08);color:var(--muted);font-size:12px;font-weight:600}
.tag.on{background:rgba(76,217,138,.18);color:#7ff0b0}
.ghost{padding:8px 14px;border-radius:999px;background:rgba(255,255,255,.1);font-size:14px;font-weight:600}
.ghost.wide{width:100%;margin-top:10px}
.primary{width:100%;margin-top:12px;min-height:50px;border-radius:16px;background:linear-gradient(135deg,#6c5ce7,#a46cff);font-size:16px;font-weight:700;box-shadow:0 6px 20px rgba(108,92,231,.4)}
.primary:disabled{background:rgba(255,255,255,.08);box-shadow:none;opacity:.7}
.btnrow{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.btnrow .primary{flex:1;margin-top:0}
.swatches{display:grid;grid-template-columns:repeat(5,1fr);gap:10px 6px;margin-bottom:14px}
.sw{display:flex;flex-direction:column;align-items:center;gap:6px;font-size:11px;color:var(--muted)}
.sw span{width:44px;height:44px;border-radius:50%;background:var(--sw);box-shadow:inset 0 0 0 2px rgba(255,255,255,.15);transition:transform .15s}
.sw b{font-weight:500;line-height:1.15;text-align:center}
.sw[aria-pressed=true] span{transform:scale(1.08);box-shadow:0 0 0 3px var(--bg1),0 0 0 5px #fff,0 0 18px var(--glow)}
.sw[aria-pressed=true] b{color:var(--text);font-weight:700}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{padding:9px 14px;border-radius:12px;background:rgba(255,255,255,.07);font-size:14px;font-weight:600}
.chip[aria-pressed=true]{background:linear-gradient(135deg,#6c5ce7,#a46cff)}
.nowplaying{margin:-4px 0 12px;color:var(--muted);font-size:14px}
.sounds{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:14px}
.snd{display:flex;align-items:center;gap:10px;min-height:50px;padding:0 14px;border-radius:16px;background:rgba(255,255,255,.06);font-size:15px;font-weight:600;text-align:left}
.snd:active{background:linear-gradient(135deg,#6c5ce7,#a46cff)}
.snd .ico{font-size:20px}
.slab{display:flex;justify-content:space-between;margin:10px 0 6px;font-size:15px;font-weight:600}
.slab output{color:var(--muted);font-variant-numeric:tabular-nums}
input[type=range]{width:100%;accent-color:var(--accent);height:28px}
.nights{display:flex;flex-direction:column;gap:8px}
.night{display:grid;grid-template-columns:44px 1fr 1fr;grid-template-areas:"n b w" "n a a";gap:6px 8px;align-items:center;padding:10px;border-radius:16px;background:rgba(255,255,255,.05)}
.nname{grid-area:n;font-weight:700;font-size:15px;display:flex;flex-direction:column}
.nname small{font-weight:500;color:var(--muted);font-size:11px}
.night .tin:nth-of-type(1){grid-area:b}.night .tin:nth-of-type(2){grid-area:w}.night select{grid-area:a}
.tin{display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:12px;background:rgba(0,0,0,.25)}
.tin input{min-width:0;flex:1;border:0;background:none;font-size:15px;font-variant-numeric:tabular-nums}
.tin.big{justify-content:space-between;margin-bottom:12px}
.tin.big span{font-weight:600}
select{width:100%;padding:8px 10px;border-radius:12px;border:0;background:rgba(0,0,0,.25);font-size:14px}
.rday{border-top:1px solid var(--line)}
.rday:first-of-type{border-top:0}
.rhead{display:grid;grid-template-columns:96px 1fr 18px;align-items:center;gap:8px;width:100%;padding:12px 2px;text-align:left}
.rsum{color:var(--muted);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chev{color:var(--muted)}
.rbody{padding:4px 0 14px}
.seq,.pick{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.tk{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;width:62px;min-height:62px;padding:6px 2px;border-radius:16px;background:rgba(255,255,255,.06);font-size:24px}
.tk small{font-size:10px;color:var(--muted);line-height:1.1;text-align:center}
.tk.on{background:linear-gradient(135deg,#6c5ce7,#a46cff)}
.tk.on small{position:absolute;top:3px;left:6px;color:#fff;font-weight:700}
.progress{display:flex;gap:8px;flex-wrap:wrap;margin:-4px 0 10px}
.pt{width:40px;height:40px;display:grid;place-items:center;border-radius:12px;font-size:20px;background:rgba(255,255,255,.08)}
.pt.s1{box-shadow:0 0 0 2px #ffd84d}.pt.s2{background:rgba(76,217,138,.3)}
.bigtime{font:600 54px/1 ui-monospace,Consolas,monospace;letter-spacing:.04em;text-align:center;padding:6px 0}
.bigtime small{display:block;margin-top:8px;font:500 15px system-ui,sans-serif;color:var(--muted);letter-spacing:0}
.seg{display:inline-grid;grid-auto-flow:column;gap:4px;padding:4px;border-radius:14px;background:rgba(0,0,0,.25)}
.seg.wide{display:grid;grid-auto-columns:1fr}
.seg button{padding:8px 16px;border-radius:10px;font-size:14px;font-weight:600;color:var(--muted)}
.seg button[aria-pressed=true]{background:linear-gradient(135deg,#6c5ce7,#a46cff);color:#fff}
.songs{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.song{position:relative;display:flex;align-items:center;gap:10px;min-height:54px;padding:6px 12px;border-radius:16px;background:rgba(255,255,255,.06);font-size:14px;font-weight:600;text-align:left;line-height:1.2}
.song .ico{font-size:20px;flex:none}
.song[aria-pressed=true]{background:linear-gradient(135deg,#6c5ce7,#a46cff);box-shadow:0 4px 18px rgba(164,108,255,.4)}
.eq{position:absolute;right:10px;top:50%;transform:translateY(-50%);display:flex;gap:2px;align-items:flex-end;height:14px}
.eq b{width:3px;background:#fff;border-radius:2px;animation:eq .9s infinite ease-in-out alternate}
.eq b:nth-child(2){animation-delay:.3s}.eq b:nth-child(3){animation-delay:.6s}
@keyframes eq{from{height:3px}to{height:14px}}
.pick .tk small{font-size:9px}
.sunrise{background:linear-gradient(160deg,rgba(255,94,126,.16),rgba(255,154,60,.12) 45%,rgba(255,216,77,.08)),var(--card)}
.sunbar{height:10px;margin:2px 0 4px;border-radius:999px;background:linear-gradient(90deg,#3a2a5e,#ff4d5e 30%,#ff9a3c 60%,#ffd84d)}
.sunbar span{display:none}
footer{text-align:center;color:var(--muted);font-size:13px}
footer a{color:inherit}
.toast{position:fixed;left:16px;right:16px;bottom:calc(env(safe-area-inset-bottom) + 16px);max-width:440px;margin:0 auto;padding:13px 16px;border-radius:14px;background:#2b2a6b;color:#fff;text-align:center;opacity:0;transform:translateY(12px);pointer-events:none;transition:.2s;z-index:20}
.toast.show{opacity:1;transform:none}
@media (max-width:360px){.swatches{grid-template-columns:repeat(4,1fr)}.tk{width:56px}}
`;

if (location.hash === '#advanced') advancedView(); else lampView();
