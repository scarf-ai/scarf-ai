// SCARF on the site: the bird is "alive" (breathes, turns toward the cursor, looks around) and speaks with answers from /api/ask.
// Mood poses (pose-<name>.webp) are used once their files exist; until then the mood is shown through motion.
type View = 'profile-left' | 'left' | 'front' | 'right' | 'profile-right';
type Pose = 'neutral' | 'thinking' | 'win' | 'loss' | 'skip' | 'waiting' | 'celebrate' | 'halt';
interface Item { ts: string; kind: string; text: string }
interface Feed { stats: { closed: number; wins: number; pnlUsd: number; open: number; mode: 'paper' | 'live' }; items: Item[] }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const bird = $('bird'), body = $('body'), bubble = $('bubble'), say = $('say');
const log = $<HTMLOListElement>('log'), form = $<HTMLFormElement>('ask'), input = $<HTMLInputElement>('q'), send = $<HTMLButtonElement>('send');
const views = new Map<string, HTMLImageElement>();
body.querySelectorAll<HTMLImageElement>('img.v').forEach(i => views.set(i.dataset.v!, i));

// ---------- Bird ----------
let view: View = 'front';
let talking = false, waiting = false;
let lastPointer = 0;

function setView(v: View) {
  if (v === view) return;
  views.get(view)?.classList.remove('on');
  views.get(v)?.classList.add('on');
  view = v;
  if (!reduced) body.animate([{ transform: 'scale(1,1)' }, { transform: 'scale(1.012,0.988)' }, { transform: 'scale(1,1)' }], { duration: 160, easing: 'ease-out' });
}

/** Where to look: horizontal offset from the bird's center to the point, five views. */
function viewFor(x: number): View {
  const r = bird.getBoundingClientRect();
  const dx = (x - (r.left + r.width / 2)) / Math.max(240, innerWidth / 2);
  return dx < -0.6 ? 'profile-left' : dx < -0.16 ? 'left' : dx < 0.16 ? 'front' : dx < 0.6 ? 'right' : 'profile-right';
}

let pendingView: View | undefined; let pendingTimer = 0;
addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch') return;
  lastPointer = Date.now();
  if (talking || waiting) return;
  const v = viewFor(e.clientX);
  if (v === pendingView) return;
  pendingView = v;
  clearTimeout(pendingTimer);
  pendingTimer = window.setTimeout(() => setView(v), 90); // no jitter at the boundary
}, { passive: true });

function hop(h = 7, ms = 190) {
  if (reduced) return;
  bird.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${-h}px)` }, { transform: 'translateY(0)' }], { duration: ms, easing: 'cubic-bezier(.3,.7,.4,1)', composite: 'add' });
}
function tilt(deg: number, ms = 600): Animation | undefined {
  if (reduced) return undefined;
  return bird.animate([{ transform: 'rotate(0deg)' }, { transform: `rotate(${deg}deg)` }], { duration: ms, easing: 'ease-out', fill: 'forwards' });
}

// Looks around if the cursor has not moved for a while (and on phones)
(async function idle() {
  const seq: View[] = ['left', 'front', 'right', 'front', 'profile-right', 'front', 'profile-left', 'front'];
  let i = 0;
  for (;;) {
    await sleep(4200 + Math.random() * 4800);
    if (talking || waiting || Date.now() - lastPointer < 7000 || document.hidden) continue;
    setView(seq[i++ % seq.length]);
    if (Math.random() < 0.25) hop(5);
  }
})();

bird.addEventListener('click', () => { if (!talking && !waiting) { hop(12, 260); setView('front'); } });

// Mood poses (enabled automatically once the files exist)
const poseCache = new Map<Pose, HTMLImageElement | null>();
async function poseImg(p: Pose): Promise<HTMLImageElement | null> {
  if (poseCache.has(p)) return poseCache.get(p)!;
  const img = new Image();
  img.className = 'v'; img.alt = ''; img.width = 720; img.height = 720;
  const ok = await new Promise<boolean>(res => { img.onload = () => res(true); img.onerror = () => res(false); img.src = `assets/pose-${p}.webp`; });
  const r = ok && p !== 'neutral' ? img : null;
  if (r) body.appendChild(r);
  poseCache.set(p, r);
  return r;
}

// ---------- Speech ----------
function showThinking() {
  say.innerHTML = '<span class="dots" aria-label="thinking"><span></span><span></span><span></span></span>';
  bubble.classList.add('show');
}

async function speak(text: string, pose: Pose) {
  talking = true;
  const posed = await poseImg(pose);
  if (posed) { views.get(view)?.classList.remove('on'); posed.classList.add('on'); } else setView('left'); // toward the bubble
  let mood: Animation | undefined;
  if (!posed) {
    if (pose === 'win' || pose === 'celebrate') { hop(16, 240); await sleep(250); hop(10, 200); }
    else if (pose === 'loss' || pose === 'halt') mood = tilt(-3, 500);
    else if (pose === 'skip') { if (!reduced) bird.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(3deg)' }, { transform: 'rotate(-3deg)' }, { transform: 'rotate(0)' }], { duration: 360, composite: 'add' }); }
    else if (pose === 'thinking') mood = tilt(2.5, 500);
  }
  bubble.classList.add('show');
  if (reduced) { say.textContent = text; }
  else {
    say.textContent = '';
    const caret = document.createElement('span'); caret.className = 'caret';
    const node = document.createTextNode('');
    say.append(node, caret);
    let words = 0;
    for (let i = 0; i < text.length; i++) {
      node.data += text[i];
      say.scrollTop = say.scrollHeight;
      if (text[i] === ' ') { if (++words % 2 === 0) hop(5, 170); }
      if (/[.!?]/.test(text[i]) && text[i + 1] === ' ') { setView(view === 'left' ? 'front' : 'left'); await sleep(220); }
      await sleep(text[i] === ',' ? 90 : 26);
    }
    caret.remove();
  }
  mood?.reverse();
  if (posed) { await sleep(1800); posed.classList.remove('on'); views.get(view)?.classList.add('on'); }
  talking = false;
}

// ---------- Terminal ----------
const time = (iso: string) => iso.slice(11, 16);
function line(cls: string, text: string, ts?: string) {
  const li = document.createElement('li');
  li.className = cls;
  if (ts) { const t = document.createElement('span'); t.className = 't'; t.textContent = time(ts); li.append(t); }
  li.append(document.createTextNode(text));
  log.append(li);
  log.scrollTop = log.scrollHeight;
  return li;
}

const turns: { q: string; a: string }[] = [];
async function ask(q: string) {
  q = q.trim().slice(0, 400);
  if (!q || waiting || talking) return;
  line('q', q);
  input.value = ''; send.disabled = true; waiting = true;
  setView('front'); const t = tilt(2.5, 500);
  showThinking();
  let r: { text: string; pose: Pose };
  try {
    const res = await fetch('/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q, history: turns.slice(-3) }) });
    r = await res.json();
  } catch { r = { text: 'I lost the connection. Ask again in a moment.', pose: 'thinking' }; }
  waiting = false; t?.reverse();
  turns.push({ q, a: r.text });
  line('a', r.text);
  await speak(r.text, r.pose);
  send.disabled = false;
  if (matchMedia('(pointer: fine)').matches) input.focus();
}

form.addEventListener('submit', (e) => { e.preventDefault(); void ask(input.value); });
$('chips').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (b) void ask(b.textContent ?? '');
});

// ---------- Journal and stats ----------
function fmtUsd(v: number) { return `${v >= 0 ? '+' : '−'}$${Math.abs(v).toFixed(2)}`; }
async function loadFeed() {
  try {
    const f: Feed = await (await fetch('/api/feed')).json();
    const s = f.stats;
    const stats = $('stats');
    stats.textContent = '';
    const mode = document.createElement('span'); mode.className = s.mode === 'paper' ? 'paper' : ''; mode.textContent = s.mode === 'paper' ? 'Paper trading' : 'Live trading';
    stats.append(mode);
    if (s.closed > 0) {
      const pnl = document.createElement('span'); pnl.className = s.pnlUsd >= 0 ? 'up' : 'down'; pnl.textContent = fmtUsd(s.pnlUsd);
      stats.append(`. ${s.closed} closed, ${s.wins} won, `, pnl, s.open ? `. ${s.open} open.` : '.');
    } else stats.append('. No closed trades yet.');
    const recent = f.items.slice(0, 5).reverse();
    if (recent.length) { line('sys', 'Lately in my journal (UTC):'); for (const it of recent) line('a', it.text, it.ts); }
    else line('sys', 'My journal is empty so far — I am just getting started.');
  } catch { line('sys', 'Journal unavailable right now.'); }
}

(async () => {
  await loadFeed();
  await sleep(reduced ? 0 : 700);
  const hello = "Hi, I'm SCARF. I trade on-chain and post what I think. Ask me about a trade or a project I've looked at.";
  await speak(hello, 'neutral');
})();
