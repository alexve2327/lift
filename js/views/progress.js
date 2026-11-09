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

import {
  db, historyFor, exerciseLibrary, splitExerciseHistory, swapWeightReps,
  sessionsForExercise, correctSet, removeSet,
} from '../db.js';
import {
  el, screen, card, btn, empty, sheet, confirmSheet, field, numInput,
  textInput, segmented, stat, toast,
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
    const atWeight = rows.filter((r) => r.weight === best.w)
      .sort((a, b) => a.setIndex - b.setIndex
        || +new Date(a.completedAt) - +new Date(b.completedAt));
    const bestReps = Math.max(...atWeight.map((r) => r.reps));
    const sideCounts = { left: 0, right: 0, none: 0 };
    for (const r of rows) sideCounts[r.side === 'left' ? 'left' : r.side === 'right' ? 'right' : 'none']++;
    out.push({
      day,
      x: new Date(day + 'T12:00:00'),
      weight: best.w,
      reps: bestReps,
      // Reps in the order you actually did them, at the working weight. The
      // bump rule is about your FIRST sets, so order is the whole point:
      // 8 then 12 is not the same session as 12 then 8.
      repsAtWeight: atWeight.map((r) => r.reps),
      sets: rows.length,
      sideCounts,
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

/** Targets come from the Exercise now, which is the one place you can edit them
 *  (including mid-workout). ProgramExercise keeps rest and ordering. */
function repRange(exercise) {
  return {
    low: exercise.targetRepsLow ?? 8,
    high: exercise.targetRepsHigh ?? 12,
    sets: exercise.targetSets ?? null,
    bumpAfter: Math.max(1, exercise.bumpAfterSets ?? 2),
  };
}

// ---------------------------------------------------------------------------
// The two charts
// ---------------------------------------------------------------------------

async function charts(exercise, refresh) {
  const all = await historyFor(exercise.id);
  const range = repRange(exercise);

  const sideOptions = exercise.isUnilateral
    ? [{ value: 'both', label: 'Both' }, { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]
    : null;

  const unsidedCount = exercise.isUnilateral ? all.filter((s) => !s.side).length : 0;
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

  // Double progression, done properly: ready when the FIRST `bumpAfter` sets at
  // the working weight all reach the top of the range. The previous version
  // compared the day's BEST set against the top, which fires on one good set
  // and is not the rule.
  const firstN = (latest.repsAtWeight ?? []).slice(0, range.bumpAfter);
  const ready = firstN.length >= range.bumpAfter && firstN.every((r) => r >= range.high);
  const hitting = firstN.filter((r) => r >= range.high).length;
  const bumpNote = ready
    ? `First ${range.bumpAfter} sets at ${r1(latest.weight)} lb hit ${range.high}. Add weight.`
    : `Bumps when the first ${range.bumpAfter} sets at the working weight reach ${range.high}. `
      + `Last session at ${r1(latest.weight)} lb: ${(latest.repsAtWeight ?? []).join(', ') || 'none'} `
      + `(${hitting} of ${range.bumpAfter}).`;

  const head = card(
    el('div', { class: 'ex-head' },
      el('div', {},
        el('h2', { class: 'card-title' }, exercise.name),
        el('div', { class: 'list-sub' },
          [exercise.muscleGroup, range.sets ? `target ${range.sets} sets` : null,
            `${range.low}-${range.high} reps`].filter(Boolean).join(' · '))),
      ready ? el('span', { class: 'pill good' }, 'ready to bump') : null),
    el('p', { class: 'muted small' }, bumpNote),
    el('div', { class: 'stat-row' },
      stat(r1(latest.weight) + ' lb', 'current'),
      stat(String(latest.reps), 'best reps'),
      stat((latest.weight - first.weight >= 0 ? '+' : '') + r1(latest.weight - first.weight), 'lb since start'),
      stat(String(pts.length), 'sessions')),
    sideOptions
      ? el('div', { class: 'stack' },
          segmented(sideOptions, sideView, (v) => { sideView = v; refresh(); }),
          unsidedCount
            ? el('span', { class: 'field-hint' },
                `${unsidedCount} older set${unsidedCount === 1 ? '' : 's'} were logged before `
                + 'per-side tracking was on, so they carry no side. They show under Both and are '
                + 'left out of Left and Right. Nothing was lost or changed.')
            : null)
      : null);

  const cards = [head];

  if (suspects.length) {
    const suspectDays = suspects.map((p) => p.day);
    const affected = sets.filter((s) =>
      suspectDays.includes(toDayKey(new Date(s.completedAt))) && s.weight < 20 && s.reps > 30);
    cards.push(card(
      el('h2', { class: 'card-title warn' },
        `${suspects.length} day${suspects.length > 1 ? 's' : ''} look transposed`),
      el('p', { class: 'muted small' },
        'Weight and reps look swapped on '
        + suspects.map((p) => `${p.day} (${r1(p.weight)} lb \u00d7 ${p.reps})`).join(', ')
        + `. ${affected.length} set${affected.length > 1 ? 's' : ''} affected. `
        + 'Nothing changes until you say so.'),
      btn(`Swap weight and reps on ${affected.length} set${affected.length > 1 ? 's' : ''}`, () => {
        confirmSheet('Swap weight and reps?',
          affected.map((s) => `${r1(s.weight)} lb \u00d7 ${s.reps} becomes ${s.reps} lb \u00d7 ${r1(s.weight)}`).join(';  '),
          async () => {
            const n = await swapWeightReps(affected.map((s) => s.id));
            toast(`${n} sets corrected`);
            refresh();
          }, 'Swap them', 'primary');
      }, 'block small'),
    ));
  }

  if (breaks.length) {
    cards.push(card(
      el('h2', { class: 'card-title warn' },
        `Possible rename${breaks.length > 1 ? 's' : ''} in this history`),
      el('p', { class: 'muted small' },
        'The working weight jumps by more than a factor of two at '
        + breaks.map((b) => `${b.from.day} (${r1(b.from.weight)} lb) → ${b.to.day} (${r1(b.to.weight)} lb)`).join(', ')
        + '. That usually means this exercise was renamed in place, so the earlier points belong '
        + 'to a different movement. I cannot prove that, so nothing changes until you decide.'),
      ...breaks.map((b) => {
        const moving = sets.filter((s) => toDayKey(new Date(s.completedAt)) <= b.from.day);
        return btn(`Split at ${b.from.day} (${moving.length} sets move)`,
          () => splitSheet(exercise, b, moving.length, refresh), 'block small');
      }),
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
        label: `${p.day} \u00b7 ${r1(p.weight)} lb \u00b7 `
          + (p.sideCounts.left && p.sideCounts.right
              ? `${p.sideCounts.left}L/${p.sideCounts.right}R`
              : `${p.sets} set${p.sets > 1 ? 's' : ''}`)
          + ` \u00b7 best ${p.reps} reps`,
      })),
      pointLabel: (p, i) => {
        const c = pts[i].sideCounts;
        // On a unilateral exercise viewed as Both, the raw row count double
        // counts: 4 sets per side is 8 rows. Show what you actually did.
        if (exercise.isUnilateral && sideView === 'both' && c.left && c.left === c.right) {
          return String(c.left);
        }
        return String(pts[i].sets);
      },
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
      `${r1(best.weight)} lb \u00d7 ${best.reps} on ${best.day}.`)));

  cards.push(await sessionList(exercise, refresh));

  return cards;
}

// ---------------------------------------------------------------------------
// Past sessions, and correcting them
// ---------------------------------------------------------------------------
// This is the piece that was missing. Until now there was no way to look at a
// finished workout at all, let alone fix a number in it, so a typo logged in
// October was permanent.

let showAllSessions = false;

async function sessionList(exercise, refresh) {
  const sessions = await sessionsForExercise(exercise.id);
  const shown = showAllSessions ? sessions : sessions.slice(0, 6);

  return card(
    el('h2', { class: 'card-title' }, 'Sessions'),
    el('p', { class: 'muted small' }, 'Tap any set to correct or delete it.'),
    el('div', { class: 'stack' }, shown.map((s) =>
      el('div', { class: 'session-block' },
        el('div', { class: 'session-head' },
          el('span', { class: 'list-title' }, s.dayKey),
          el('span', { class: 'list-sub' }, s.dayName)),
        el('ul', { class: 'set-list' }, s.sets.map((x) => pastSetRow(x, exercise, refresh)))))),
    sessions.length > 6
      ? btn(showAllSessions ? 'Show fewer' : `Show all ${sessions.length} sessions`,
          () => { showAllSessions = !showAllSessions; refresh(); }, 'block small')
      : null);
}

function pastSetRow(s, exercise, refresh) {
  const kind = exercise.trackingType ?? 'weight_reps';
  const detail = kind === 'duration' ? `${s.durationSec}s`
    : kind === 'bodyweight_reps' ? `${s.reps} reps`
    : `${r1(s.weight)} lb \u00d7 ${s.reps}`;
  return el('li', { class: 'set-row tappable', onclick: () => pastSetSheet(s, exercise, refresh) },
    el('span', { class: 'set-num' }, String(s.setIndex)),
    s.side ? el('span', { class: 'tag side' }, s.side === 'left' ? 'L' : 'R') : null,
    el('span', { class: 'set-detail' }, detail),
    s.toFailure ? el('span', { class: 'tag fail' }, 'failure') : null,
    s.editedAt ? el('span', { class: 'tag edited' }, 'edited') : null,
    el('span', { class: 'chev' }, '\u203a'));
}

function pastSetSheet(s, exercise, refresh) {
  const kind = exercise.trackingType ?? 'weight_reps';
  sheet(`${toDayKey(new Date(s.completedAt))} \u00b7 set ${s.setIndex}`, (close) => {
    const w = numInput({ value: s.weight ?? '' });
    const r = numInput({ value: s.reps ?? '' });
    const d = numInput({ value: s.durationSec ?? '' });
    let fail = s.toFailure;
    const f = el('button', {
      type: 'button', class: 'fail-btn wide' + (fail ? ' on' : ''),
      onclick: () => { fail = !fail; f.classList.toggle('on', fail); },
    }, 'To failure');

    return [
      el('p', { class: 'muted small' },
        'Corrections are allowed and are marked. The row keeps an edited tag afterwards, so a '
        + 'fixed number never passes as something you logged at the time.'),
      kind === 'weight_reps' ? field('Weight (lb)', w) : null,
      kind === 'duration' ? field('Seconds', d) : field('Reps', r),
      el('div', { class: 'stack' }, f),
      kind === 'weight_reps'
        ? btn('Swap these two', () => { const a = w.value; w.value = r.value; r.value = a; }, 'block small')
        : null,
      el('div', { class: 'sheet-actions' },
        btn('Delete', () => {
          close();
          confirmSheet('Delete this set?',
            `${toDayKey(new Date(s.completedAt))}, set ${s.setIndex}. This removes it from your history.`,
            async () => { await removeSet(s.id); toast('Set deleted'); refresh(); }, 'Delete');
        }, 'danger'),
        btn('Save', async () => {
          await correctSet(s.id, {
            weight: w.value === '' ? null : parseFloat(w.value),
            reps: r.value === '' ? null : parseInt(r.value, 10),
            durationSec: d.value === '' ? null : parseInt(d.value, 10),
            toFailure: fail,
          });
          close(); toast('Corrected'); refresh();
        }, 'primary')),
    ];
  });
}

function splitSheet(exercise, brk, movingCount, refresh) {
  sheet('Split history', (close) => {
    const name = textInput({ placeholder: 'What was it before?' });
    return [
      el('p', { class: 'muted small' },
        `"${exercise.name}" jumps from ${r1(brk.from.weight)} lb on ${brk.from.day} to `
        + `${r1(brk.to.weight)} lb on ${brk.to.day}.`),
      el('p', { class: 'muted small' },
        `Splitting moves the ${movingCount} sets on or before ${brk.from.day} to a new exercise you `
        + `name below. "${exercise.name}" keeps its recent sets, because the name describes what you `
        + 'do now. The older one is archived, so it stays out of pickers but keeps its charts.'),
      field('Name for the older movement', name,
        'Whatever it actually was. If you cannot remember, '
        + `"${exercise.name} (before ${brk.to.day})" works.`),
      el('div', { class: 'sheet-actions' },
        btn('Cancel', close),
        btn('Split', async () => {
          const n = name.value.trim();
          if (!n) return toast('Name the older movement');
          const res = await splitExerciseHistory({
            exerciseId: exercise.id, throughDayKey: brk.from.day, newName: n,
          });
          close();
          toast(`${res.moved} sets moved to "${n}"`);
          refresh();
        }, 'primary')),
    ];
  });
}
