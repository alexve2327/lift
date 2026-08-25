// timer.js — the rest timer.
//
// The one thing that matters here: NEVER count ticks. iOS suspends JavaScript
// the moment you lock the phone or switch apps, which is exactly what you do
// between sets. A timer built on "add 1 every second" freezes in your pocket
// and lies to you when you come back.
//
// Instead we store a start TIMESTAMP and compute elapsed = now - start on
// every paint. The interval is only there to trigger repaints; the arithmetic
// never depends on it having fired. Come back after four minutes in your
// pocket and the number is correct because it was never being accumulated.
//
// State is mirrored into sessionStorage so an accidental refresh mid-workout
// does not lose the running timer.

const KEY = 'rest-timer';
const listeners = new Set();
let state = load();
let ticker = null;

function load() {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    return { startedAt: s.startedAt, targetSec: s.targetSec, label: s.label };
  } catch { return null; }
}

function save() {
  try {
    if (state) sessionStorage.setItem(KEY, JSON.stringify(state));
    else sessionStorage.removeItem(KEY);
  } catch { /* private mode */ }
}

function emit() { for (const fn of listeners) fn(read()); }

function ensureTicker() {
  if (ticker || !state) return;
  ticker = setInterval(emit, 250);
}

function stopTicker() {
  clearInterval(ticker);
  ticker = null;
}

export function start(targetSec, label = '') {
  state = { startedAt: Date.now(), targetSec, label };
  save();
  ensureTicker();
  emit();
}

export function stop() {
  const elapsed = state ? Math.round((Date.now() - state.startedAt) / 1000) : null;
  state = null;
  save();
  stopTicker();
  emit();
  return elapsed;
}

/** The single source of truth for the UI. Derived, never accumulated. */
export function read() {
  if (!state) return null;
  const elapsedSec = (Date.now() - state.startedAt) / 1000;
  return {
    elapsedSec,
    remainingSec: state.targetSec - elapsedSec,
    targetSec: state.targetSec,
    label: state.label,
    done: elapsedSec >= state.targetSec,
  };
}

export function subscribe(fn) {
  listeners.add(fn);
  ensureTicker();
  fn(read());
  return () => listeners.delete(fn);
}

// Recompute immediately on wake rather than waiting up to 250ms, so the number
// is already right the instant the screen comes back on.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) emit();
});

// A short beep when rest is up. Web Audio needs a user gesture to unlock on
// iOS, so we create the context lazily on the first tap and swallow failures:
// a missing beep must never break the timer.
let audioCtx = null;
let beeped = false;

export function unlockAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume?.();
  } catch { /* no audio available */ }
}

export function beep() {
  if (!audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.36);
  } catch { /* ignore */ }
}

subscribe((t) => {
  if (!t) { beeped = false; return; }
  if (t.done && !beeped) { beeped = true; beep(); navigator.vibrate?.(200); }
  if (!t.done) beeped = false;
});
