// app.js — the shell. Router, tab bar, and the one piece of UI that must
// survive re-renders: the rest timer.

import { initDb } from './db.js';
import { el, clear } from './ui.js';
import { fmtClock } from './util.js';
import * as timer from './timer.js';

import * as today from './views/today.js';
import * as food from './views/food.js';
import * as library from './views/library.js';
import * as settings from './views/settings.js';

const VIEWS = {
  today:    { module: today,    label: 'Train',    icon: '▲' },
  food:     { module: food,     label: 'Food',     icon: '●' },
  library:  { module: library,  label: 'Library',  icon: '≡' },
  settings: { module: settings, label: 'Settings', icon: '⚙' },
};

const main = document.getElementById('view');
const timerBar = document.getElementById('timer-bar');
const tabBar = document.getElementById('tabs');

let current = location.hash.slice(1) || 'today';
let rendering = false;

/** Re-render the current view from scratch. Every view is a pure function of
 *  the database, so "something changed" and "render again" are the same thing.
 *  The guard stops overlapping async renders from racing each other into the
 *  DOM out of order. */
async function refresh() {
  if (rendering) return;
  rendering = true;
  try {
    const view = VIEWS[current] ?? VIEWS.today;
    const scroll = main.scrollTop;
    const node = await view.module.render(refresh);
    clear(main);
    main.append(node);
    main.scrollTop = scroll;
    drawTabs();
  } catch (err) {
    console.error('[app] render failed', err);
    clear(main);
    main.append(el('div', { class: 'screen' },
      el('h1', {}, 'Something broke'),
      el('p', { class: 'muted' }, String(err?.message ?? err)),
      el('p', { class: 'muted small' },
        'Your data is still there. Reload the app, and if this keeps happening, '
        + 'export a backup from Settings before doing anything else.')));
  } finally {
    rendering = false;
  }
}

function go(route) {
  current = route;
  location.hash = route;
  main.scrollTop = 0;
  refresh();
}

function drawTabs() {
  tabBar.replaceChildren(...Object.entries(VIEWS).map(([key, v]) =>
    el('button', {
      type: 'button',
      class: 'tab' + (key === current ? ' on' : ''),
      'aria-current': key === current ? 'page' : null,
      onclick: () => go(key),
    },
      el('span', { class: 'tab-icon' }, v.icon),
      el('span', { class: 'tab-label' }, v.label))));
}

// The timer bar lives outside the view so a re-render never interrupts it.
// It subscribes once, at boot, and updates itself.
timer.subscribe((t) => {
  if (!t) { timerBar.hidden = true; timerBar.replaceChildren(); return; }
  timerBar.hidden = false;
  const over = t.remainingSec <= 0;
  const pct = Math.min(100, (t.elapsedSec / t.targetSec) * 100);
  timerBar.classList.toggle('done', over);
  timerBar.replaceChildren(
    el('div', { class: 'timer-fill', style: { width: pct + '%' } }),
    el('div', { class: 'timer-body' },
      el('span', { class: 'timer-label' }, over ? 'Rest over' : 'Resting'),
      el('span', { class: 'timer-clock' },
        over ? '+' + fmtClock(-t.remainingSec) : fmtClock(t.remainingSec)),
      el('button', { class: 'timer-skip', type: 'button', onclick: () => timer.stop() }, 'Skip')));
});

window.addEventListener('hashchange', () => {
  const next = location.hash.slice(1) || 'today';
  if (next !== current) { current = next; refresh(); }
});

// Any tap unlocks audio for the rest-timer beep. iOS refuses to create an
// AudioContext outside a user gesture, so we take the first one we get.
document.addEventListener('pointerdown', () => timer.unlockAudio(), { once: true });

(async function boot() {
  await initDb();
  await refresh();
  document.body.classList.remove('booting');

  // Service worker: what makes this work with no signal in a gym basement.
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js'); }
    catch (err) { console.warn('[app] service worker failed', err); }
  }
})();
