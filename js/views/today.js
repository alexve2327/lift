// views/today.js — the workout screen. This is the one you use with sweaty
// hands and thirty seconds of patience, so every decision here is about
// reducing taps: the set form is pre-filled from your last set, the rest timer
// starts itself, and the exercise picker remembers what you actually do.

import {
  db, activeSession, startSession, endSession, setsForSession, logSet, editSet,
  activeProgram, exerciseLibrary, lastPerformance, getSettings,
} from '../db.js';
import {
  el, screen, card, btn, empty, sheet, confirmSheet, toast, field,
  numInput, textInput, segmented, stat,
} from '../ui.js';
import { uuid, fmtDuration, fmtClock, r1, e1rm } from '../util.js';
import { exerciseSheet } from '../exercise-form.js';
import * as timer from '../timer.js';

export async function render(refresh) {
  const session = await activeSession();
  return session ? liveSession(session, refresh) : startScreen(refresh);
}

// ---------------------------------------------------------------------------
// Not training yet
// ---------------------------------------------------------------------------

async function startScreen(refresh) {
  const program = await activeProgram();
  const recent = await db.sessions
    .filter(s => s.endedAt !== null).toArray();
  recent.sort((a, b) => b.startedAt - a.startedAt);

  const begin = async (day) => {
    await startSession({ programDay: day });
    timer.unlockAudio();
    refresh();
  };

  const dayButtons = program?.days?.length
    ? card(
        el('h2', { class: 'card-title' }, program.name),
        el('div', { class: 'day-grid' },
          program.days.map(d =>
            el('button', { class: 'day-btn', type: 'button', onclick: () => begin(d) },
              el('span', { class: 'day-name' }, d.name),
              el('span', { class: 'day-meta' },
                `${d.exercises.length} exercise${d.exercises.length === 1 ? '' : 's'}`)))))
    : card(
        el('h2', { class: 'card-title' }, 'No active program'),
        el('p', { class: 'muted' },
          'Build one in Library, or just start a freestyle session and log as you go.'));

  return screen('Train', null,
    dayButtons,
    el('div', { class: 'stack' },
      btn('Start freestyle workout', () => begin(null), 'primary block')),
    recent.length ? card(
      el('h2', { class: 'card-title' }, 'Recent'),
      el('ul', { class: 'list' },
        recent.slice(0, 5).map(s =>
          el('li', { class: 'list-row' },
            el('div', {},
              el('div', { class: 'list-title' }, s.dayNameSnapshot),
              el('div', { class: 'list-sub' },
                s.startedAt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }))),
            el('div', { class: 'list-sub' }, fmtDuration(s.endedAt - s.startedAt)))))) : null);
}

// ---------------------------------------------------------------------------
// Training right now
// ---------------------------------------------------------------------------

async function liveSession(session, refresh) {
  const settings = await getSettings();
  const sets = await setsForSession(session.id);
  const exercises = await db.exercises.toArray();
  const byId = Object.fromEntries(exercises.map(e => [e.id, e]));

  // Which exercises are in play: everything already logged, plus everything the
  // program day prescribes, in program order, without duplicates.
  const planned = session.programDayId
    ? await db.programExercises.where('programDayId').equals(session.programDayId).toArray()
    : [];
  planned.sort((a, b) => a.orderIndex - b.orderIndex);

  const order = [];
  for (const pe of planned) if (!order.includes(pe.exerciseId)) order.push(pe.exerciseId);
  for (const s of sets) if (!order.includes(s.exerciseId)) order.push(s.exerciseId);
  const extra = session.adHoc ?? [];
  for (const id of extra) if (!order.includes(id)) order.push(id);

  const plannedFor = Object.fromEntries(planned.map(pe => [pe.exerciseId, pe]));

  const totalVolume = sets.reduce((a, s) => a + (s.weight ?? 0) * (s.reps ?? 0), 0);

  const addExercise = async () => {
    const lib = await exerciseLibrary();
    sheet('Add exercise', (close) => exercisePicker(lib, async (exercise) => {
      close();
      const s = await db.sessions.get(session.id);
      await db.sessions.update(session.id, {
        adHoc: [...(s.adHoc ?? []), exercise.id],
      });
      refresh();
    }));
  };

  const finish = () => {
    if (!sets.length) {
      confirmSheet('Discard workout?', 'Nothing was logged, so there is nothing to keep.', async () => {
        await db.sessions.delete(session.id);
        timer.stop();
        refresh();
      }, 'Discard');
      return;
    }
    confirmSheet('Finish workout?', `${sets.length} sets, ${r1(totalVolume).toLocaleString()} lb of volume.`, async () => {
      await endSession(session.id);
      timer.stop();
      toast('Workout saved');
      refresh();
    }, 'Finish', 'primary');
  };

  const blocks = [];
  for (const exId of order) {
    const ex = byId[exId];
    if (!ex) continue;
    blocks.push(await exerciseBlock({
      exercise: ex,
      programExercise: plannedFor[exId],
      sets: sets.filter(s => s.exerciseId === exId).sort((a, b) => a.setIndex - b.setIndex),
      session, settings, refresh,
    }));
  }

  return screen(session.dayNameSnapshot,
    btn('Finish', finish, 'primary small'),
    el('div', { class: 'stat-row' },
      stat(fmtDuration(Date.now() - session.startedAt), 'elapsed'),
      stat(String(sets.length), 'sets'),
      stat(r1(totalVolume).toLocaleString(), 'lb volume')),
    blocks.length ? el('div', { class: 'stack' }, blocks)
      : empty('No exercises yet.', 'Add one', addExercise),
    blocks.length ? el('div', { class: 'stack' },
      btn('Add exercise', addExercise, 'block')) : null);
}

// ---------------------------------------------------------------------------
// One exercise inside a session
// ---------------------------------------------------------------------------

async function exerciseBlock({ exercise, programExercise, sets, session, settings, refresh }) {
  const prior = await lastPerformance(exercise.id, session.id);
  const restTarget = programExercise?.targetRestSec ?? settings.defaultRestSec;
  const kind = exercise.trackingType ?? 'weight_reps';

  // Pre-fill from the most recent set of this exercise in this session, else
  // from last time. You almost always repeat the previous set, so the fastest
  // correct default is "what you just did".
  const unilateral = !!exercise.isUnilateral;
  // Default to whichever side you have done fewer of, so alternating L/R
  // costs no taps at all.
  const countL = sets.filter((s) => s.side === 'left').length;
  const countR = sets.filter((s) => s.side === 'right').length;
  let side = unilateral ? (countL <= countR ? 'left' : 'right') : null;

  // Seed from the last set on the SAME side, so a left-side prefill never
  // quietly carries over your right-side numbers.
  const sameSide = unilateral ? sets.filter((s) => s.side === side) : sets;
  const priorSame = unilateral && prior ? prior.filter((s) => s.side === side) : prior;
  const seed = sameSide[sameSide.length - 1] ?? priorSame?.[priorSame.length - 1] ?? {};

  const weightIn = numInput({ value: seed.weight ?? '', placeholder: 'lb', class: 'set-in' });
  const repsIn   = numInput({ value: seed.reps ?? '', placeholder: 'reps', class: 'set-in' });
  const durIn    = numInput({ value: seed.durationSec ?? '', placeholder: 'sec', class: 'set-in' });
  let failure = false;

  const sideBtn = el('button', {
    type: 'button', class: 'side-btn on', 'aria-label': 'Side',
    onclick: () => {
      side = side === 'left' ? 'right' : 'left';
      sideBtn.textContent = side === 'left' ? 'L' : 'R';
    },
  }, side === 'left' ? 'L' : 'R');

  const failBtn = el('button', {
    type: 'button', class: 'fail-btn', 'aria-pressed': 'false',
    onclick: () => {
      failure = !failure;
      failBtn.classList.toggle('on', failure);
      failBtn.setAttribute('aria-pressed', String(failure));
    },
  }, 'F');

  const submit = async () => {
    const weight = kind === 'weight_reps' ? parseFloat(weightIn.value) : null;
    const reps   = kind === 'duration' ? null : parseInt(repsIn.value, 10);
    const durationSec = kind === 'duration' ? parseInt(durIn.value, 10) : null;

    if (kind === 'weight_reps' && (!Number.isFinite(weight) || !Number.isFinite(reps))) {
      return toast('Weight and reps, please');
    }
    if (kind === 'bodyweight_reps' && !Number.isFinite(reps)) return toast('Reps, please');
    if (kind === 'duration' && !Number.isFinite(durationSec)) return toast('Seconds, please');

    // If a rest timer was running, this set closes it out and we record what
    // the rest ACTUALLY was, not what it was supposed to be.
    const restActual = timer.stop();

    await logSet({
      sessionId: session.id,
      exerciseId: exercise.id,
      setIndex: (unilateral ? sets.filter((s) => s.side === side).length : sets.length) + 1,
      weight: Number.isFinite(weight) ? weight : null,
      reps: Number.isFinite(reps) ? reps : null,
      durationSec: Number.isFinite(durationSec) ? durationSec : null,
      toFailure: failure,
      restSecActual: restActual,
      side: unilateral ? side : null,
    });

    timer.unlockAudio();
    timer.start(restTarget, exercise.name);
    refresh();
  };

  const target = programExercise
    ? `${programExercise.targetSets} × ${programExercise.targetRepsLow}-${programExercise.targetRepsHigh}`
    : null;

  const fmtSet = (s) => (kind === 'duration' ? `${s.durationSec}s`
    : kind === 'bodyweight_reps' ? `${s.reps}` : `${r1(s.weight)}×${s.reps}`);
  const priorLabel = prior?.length
    ? (unilateral
        ? 'Last: L ' + (prior.filter((s) => s.side === 'left').map(fmtSet).join(', ') || '--')
          + '  ·  R ' + (prior.filter((s) => s.side === 'right').map(fmtSet).join(', ') || '--')
        : 'Last: ' + prior.map(fmtSet).join(', '))
    : 'First time logging this';

  return card(
    el('div', { class: 'ex-head' },
      el('div', {},
        // Tapping the name edits the exercise in place. Going to Library,
        // finding it, editing it and coming back was four screens to fix a
        // typo or flip the unilateral switch mid-workout.
        el('button', {
          class: 'card-title editable', type: 'button',
          onclick: () => exerciseSheet(exercise, refresh, { allowArchive: false }),
        }, exercise.name, el('span', { class: 'chev' }, '\u270e')),
        el('div', { class: 'list-sub' }, priorLabel)),
      target ? el('span', { class: 'pill' }, target) : null),

    sets.length ? el('ul', { class: 'set-list' },
      sets.map(s => setRow(s, kind, refresh))) : null,

    el('div', { class: 'set-form' },
      el('span', { class: 'set-num' },
        String((unilateral ? Math.max(countL, countR) : sets.length) + 1)),
      unilateral ? sideBtn : null,
      kind === 'weight_reps' ? weightIn : null,
      kind === 'duration' ? durIn : repsIn,
      failBtn,
      btn('Log', submit, 'primary')),

    el('div', { class: 'rest-hint' }, `Rest ${fmtClock(restTarget)} after each set`));
}

function setRow(s, kind, refresh) {
  const detail = kind === 'duration' ? `${s.durationSec}s`
    : kind === 'bodyweight_reps' ? `${s.reps} reps`
    : `${r1(s.weight)} lb × ${s.reps}`;
  const est = kind === 'weight_reps' ? e1rm(s.weight, s.reps) : null;

  return el('li', { class: 'set-row' },
    el('span', { class: 'set-num' }, String(s.setIndex)),
    s.side ? el('span', { class: 'tag side' }, s.side === 'left' ? 'L' : 'R') : null,
    el('span', { class: 'set-detail' }, detail),
    s.toFailure ? el('span', { class: 'tag fail' }, 'failure') : null,
    est ? el('span', { class: 'set-est' }, `e1RM ${r1(est)}`) : null,
    s.editedAt ? el('span', { class: 'tag edited' }, 'edited') : null,
    el('button', {
      class: 'icon-btn', type: 'button', 'aria-label': 'Edit set',
      onclick: () => editSheet(s, kind, refresh),
    }, '⋯'));
}

// Editing stays allowed, and leaves a mark. That is the compromise that keeps
// history trustworthy without making it read-only.
function editSheet(s, kind, refresh) {
  sheet('Edit set ' + s.setIndex, (close) => {
    const w = numInput({ value: s.weight ?? '' });
    const r = numInput({ value: s.reps ?? '' });
    const d = numInput({ value: s.durationSec ?? '' });
    let fail = s.toFailure;
    const f = el('button', {
      type: 'button', class: 'fail-btn' + (fail ? ' on' : ''),
      onclick: () => { fail = !fail; f.classList.toggle('on', fail); },
    }, 'To failure');

    return [
      kind === 'weight_reps' ? field('Weight (lb)', w) : null,
      kind === 'duration' ? field('Seconds', d) : field('Reps', r),
      el('div', { class: 'stack' }, f),
      el('div', { class: 'sheet-actions' },
        btn('Delete', () => {
          close();
          confirmSheet('Delete set?', 'This removes it from your history.', async () => {
            await db.setEntries.delete(s.id);
            refresh();
          }, 'Delete');
        }, 'danger'),
        btn('Save', async () => {
          await editSet(s.id, {
            weight: w.value === '' ? null : parseFloat(w.value),
            reps: r.value === '' ? null : parseInt(r.value, 10),
            durationSec: d.value === '' ? null : parseInt(d.value, 10),
            toFailure: fail,
          });
          close();
          toast('Set updated, marked as edited');
          refresh();
        }, 'primary')),
    ];
  });
}

// ---------------------------------------------------------------------------
// Exercise picker, shared with the program builder
// ---------------------------------------------------------------------------

export function exercisePicker(library, onPick) {
  const list = el('ul', { class: 'list' });
  const search = textInput({ placeholder: 'Search exercises', class: 'search' });

  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const hits = library.filter(e =>
      !q || e.name.toLowerCase().includes(q) || (e.muscleGroup ?? '').toLowerCase().includes(q));
    list.replaceChildren(...hits.map(e =>
      el('li', {},
        el('button', { class: 'pick-row', type: 'button', onclick: () => onPick(e) },
          el('span', { class: 'list-title' }, e.name),
          el('span', { class: 'list-sub' }, [e.muscleGroup, e.equipment].filter(Boolean).join(' · '))))));
    if (!hits.length) {
      list.append(el('li', { class: 'muted pad' },
        el('button', { class: 'btn primary block', type: 'button', onclick: async () => {
          const name = search.value.trim();
          if (!name) return;
          const ex = { id: uuid(), name, muscleGroup: '', equipment: '',
                       trackingType: 'weight_reps', notes: '', isArchived: false };
          await db.exercises.add(ex);
          onPick(ex);
        } }, `Create "${search.value.trim()}"`)));
    }
  };

  search.addEventListener('input', draw);
  draw();
  return [search, list];
}
