// views/progress.js — per-exercise charts.
//
// The point-per-day rules come straight from the plotting-preferences doc:
//
//   weight = the weight used on the MOST sets that day (ties go to the heavier)
//   reps   = the best set at that weight
//   sets   = how many were logged that day
//
// Why not plot every set? Because a working day is "I did 4 sets at 150 and one
// backoff at 120", and plotting all five makes the line zigzag in a way that
// hides the thing you actually want to see. One point per day per exercise,
// chosen as the day's working weight, is the signal.

import { db, historyFor, exerciseLibrary } from '../db.js';
import {
  el, screen, card, btn, empty, sheet, textInput, segmented, stat, toast,
} from '../ui.js';
import { r1, toDayKey } from '../util.js';
import { lineChart } from '../chart.js';

let selectedId = null;
let sideView = 'both';   // for unilateral exercises: both | left | right

export async function render(refresh) {
  const exercises = await exerciseLibrary();
  const sets = await db.setEntries.toArray();

  // Most recently trained first: the lift you care about is the one you just did.
  const lastSeen = new Map();
  for (const s of sets) {
    const t = +new Date(s.completedAt);
    if (t > (lastSeen.get(s.exerciseId) ?? 0)) lastSeen.set(s.exerciseId, t);
  }
  const withData = exercises
    .filter((e) => lastSeen.has(e.id))
    .sort((a, b) => lastSeen.get(b.id) - lastSeen.get(a.id));

  if (!withData.length) {
    return screen('Progress', null, empty('Log some sets and your charts will appear here.'));
  }

  if (!selectedId || !withData.some((e) => e.id === selectedId)) {
    selectedId = withData[0].id;
  }
  const exercise = withData.find((e) => e.id === selectedId);

  const picker = btn(
    exercise.name,
    () => pickerSheet(withData, lastSeen, refresh),
    'picker block',
  );

  return screen('Progress', null,
    picker,
    ...(await charts(exercise, refresh)));
}

function pickerSheet(list, lastSeen, refresh) {
  sheet('Choose exercise', (close) => {
    const search = textInput({ placeholder: 'Search', class: 'search' });
    const out = el('ul', { class: 'list' });
    const draw = () => {
      const q = search.value.trim().toLowerCase();
      const hits = list.filter((e) =>
        !q || e.name.toLowerCase().includes(q) || (e.muscleGroup ?? '').toLowerCase().includes(q));
      out.replaceChildren(...hits.map((e) =>
        el('li', {},
          el('button', {
            class: 'pick-row' + (e.id === selectedId ? ' on' : ''), type: 'button',
            onclick: () => { selectedId = e.id; sideView = 'both'; close(); refresh(); },
          },
            el('span', { class: 'list-title' }, e.name),
            el('span', { class: 'list-sub' },
              [e.muscleGroup, 'last ' + new Date(lastSeen.get(e.id)).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })]
                .filter(Boolean).join(' · '))))));
    };
    search.addEventListener('input', draw);
    draw();
    return [search, out];
  });
}

// ---------------------------------------------------------------------------
// Day reduction
// ---------------------------------------------------------------------------

/** Collapse a set list into one point per day, following the rules above. */
export function dailyPoints(sets) {
  const byDay = new Map();
  for (const s of sets) {
    if (s.weight === null || s.weight === undefined) continue;
    if (s.reps === null || s.reps === undefined) continue;
    const day = toDayKey(new Date(s.completedAt));
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(s);
  }

  const out = [];
  for (const [day, rows] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // weight used on the most sets; ties go to the heavier
    const counts = new Map();
    for (const r of rows) counts.set(r.weight, (counts.get(r.weight) ?? 0) + 1);
    let best = null;
    for (const [w, n] of counts) {
      if (!best || n > best.n || (n === best.n && w > best.w)) best = { w, n };
    }
    const atWeight = rows.filter((r) => r.weight === best.w);
    const bestReps = Math.max(...atWeight.map((r) => r.reps));
    out.push({
      day,
      x: new Date(day + 'T12:00:00'),
      weight: best.w,
      reps: bestReps,
      sets: rows.length,
      setsAtWeight: best.n,
      toFailure: atWeight.some((r) => r.toFailure),
      // Transposed-entry detection: his example was 7 lb x 100 reps. Flag it,
      // do NOT silently swap. A chart that quietly rewrites your numbers is a
      // chart you can't trust, and the real fix is one tap away in the log.
      suspect: best.w < 20 && bestReps > 30,
    });
  }
  return out;
}

async function repRange(exerciseId) {
  // filter(), not where(): `exerciseId` is not an index on programExercises
  // (the indexes are id, programDayId and [programDayId+orderIndex]), and
  // where() on an unindexed field throws rather than falling back to a scan.
  // The table holds a couple of dozen rows, so a scan is free.
  const pes = await db.programExercises.filter((pe) => pe.exerciseId === exerciseId).toArray();
  if (!pes.length) return { low: 8, high: 12, sets: null };
  const pe = pes[pes.length - 1];
  return { low: pe.targetRepsLow, high: pe.targetRepsHigh, sets: pe.targetSets };
}

// ---------------------------------------------------------------------------
// The two charts
// ---------------------------------------------------------------------------

async function charts(exercise, refresh) {
  const all = await historyFor(exercise.id);
  const range = await repRange(exercise.id);

  const sideOptions = exercise.isUnilateral
    ? [{ value: 'both', label: 'Both' }, { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]
    : null;

  const sets = exercise.isUnilateral && sideView !== 'both'
    ? all.filter((s) => s.side === sideView)
    : all;

  const pts = dailyPoints(sets);
  const suspects = pts.filter((p) => p.suspect);

  if (!pts.length) {
    return [card(el('p', { class: 'muted' }, 'No weight-and-reps sets logged for this exercise.'))];
  }

  // Diamond on a weight increase, per the plotting notes.
  let prev = null;
  for (const p of pts) {
    p.increase = prev !== null && p.weight > prev;
    prev = p.weight;
  }

  // Rename detection, of a sort. Your notes say you sometimes renamed an
  // exercise in place rather than creating a new one, so one id can hold two
  // different movements and the line between them is meaningless. With a single
  // backup there is no way to prove it, so this flags the discontinuity and
  // says what it probably is instead of pretending the line is real.
  const breaks = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1].weight;
    const b = pts[i].weight;
    if (a > 0 && b > 0 && (b / a > 2.2 || a / b > 2.2)) {
      breaks.push({ from: pts[i - 1], to: pts[i] });
    }
  }

  const latest = pts[pts.length - 1];
  const first = pts[0];
  const best = pts.reduce((a, p) => (p.weight > a.weight ? p : a), pts[0]);

  // Double progression: ready to bump when the working sets hit the top of the
  // range. His rule is the first two sets, which we can only approximate from a
  // day point, so this reads the best set at the working weight and says so.
  const ready = latest.reps >= range.high;

  const head = card(
    el('div', { class: 'ex-head' },
      el('div', {},
        el('h2', { class: 'card-title' }, exercise.name),
        el('div', { class: 'list-sub' },
          [exercise.muscleGroup, range.sets ? `target ${range.sets} sets` : null,
            `${range.low}-${range.high} reps`].filter(Boolean).join(' · '))),
      ready ? el('span', { class: 'pill good' }, 'ready to bump') : null),
    el('div', { class: 'stat-row' },
      stat(r1(latest.weight) + ' lb', 'current'),
      stat(String(latest.reps), 'best reps'),
      stat((latest.weight - first.weight >= 0 ? '+' : '') + r1(latest.weight - first.weight), 'lb since start'),
      stat(String(pts.length), 'sessions')),
    sideOptions
      ? segmented(sideOptions, sideView, (v) => { sideView = v; refresh(); })
      : null);

  const cards = [head];

  if (suspects.length) {
    cards.push(card(
      el('h2', { class: 'card-title warn' }, `${suspects.length} point${suspects.length > 1 ? 's' : ''} look transposed`),
      el('p', { class: 'muted small' },
        'Weight and reps look swapped on '
        + suspects.map((p) => `${p.day} (${r1(p.weight)} lb × ${p.reps})`).join(', ')
        + '. I have left the data alone rather than guessing. Fix it in the workout log and the chart follows.'),
    ));
  }

  if (breaks.length) {
    cards.push(card(
      el('h2', { class: 'card-title warn' },
        `Possible rename${breaks.length > 1 ? 's' : ''} in this history`),
      el('p', { class: 'muted small' },
        'The working weight jumps by more than a factor of two at '
        + breaks.map((b) => `${b.from.day} (${r1(b.from.weight)} lb) → ${b.to.day} (${r1(b.to.weight)} lb)`).join(', ')
        + '. That usually means this exercise was renamed in place and the earlier points belong '
        + 'to a different movement. I cannot prove it from one backup, so the line is drawn as '
        + 'logged. If it was a rename, make a new exercise for the current one and the chart splits cleanly.'),
    ));
  }

  // --- weight over time: set count above each point ------------------------
  cards.push(card(
    el('h2', { class: 'card-title' }, 'Weight'),
    el('p', { class: 'muted small' }, 'Working weight each day. The number above each point is sets logged; a diamond is a weight increase.'),
    lineChart({
      points: pts.map((p) => ({
        x: p.x, y: p.weight,
        mark: p.increase ? 'diamond' : null,
        hollow: p.suspect,
        label: `${p.day} · ${r1(p.weight)} lb · ${p.sets} set${p.sets > 1 ? 's' : ''} · best ${p.reps} reps`,
      })),
      pointLabel: (p, i) => String(pts[i].sets),
      yLabel: 'lb',
    })));

  // --- reps over time: weight above each point, rep range as a band --------
  cards.push(card(
    el('h2', { class: 'card-title' }, 'Reps'),
    el('p', { class: 'muted small' },
      `Best set at the working weight. The band is your ${range.low}-${range.high} target; `
      + 'clearing the top of it is the signal to add weight.'),
    lineChart({
      points: pts.map((p) => ({
        x: p.x, y: p.reps,
        hollow: p.suspect,
        label: `${p.day} · ${p.reps} reps at ${r1(p.weight)} lb${p.toFailure ? ' · to failure' : ''}`,
      })),
      pointLabel: (p, i) => r1(pts[i].weight),
      bands: [{ from: range.low, to: range.high }],
      rules: [{ y: range.high, label: `bump at ${range.high}` }],
      integerY: true,
      yLabel: 'reps',
    })));

  cards.push(card(
    el('h2', { class: 'card-title' }, 'Heaviest day'),
    el('p', { class: 'muted small' },
      `${r1(best.weight)} lb × ${best.reps} on ${best.day}.`)));

  return cards;
}
