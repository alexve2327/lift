// views/library.js — the definitions half of the app: exercises and programs.
//
// Everything here is safe to edit, because nothing here is history. Renaming
// an exercise updates how past sets are labelled (same movement, better name);
// renaming a program day does not touch past sessions, because those snapshot
// the name at the time. That asymmetry is deliberate: if you actually changed
// the movement, create a new exercise instead of renaming the old one.

import {
  db, exerciseLibrary, programWithDays, deleteProgram, foodLibrary,
} from '../db.js';
import {
  el, screen, card, btn, empty, sheet, confirmSheet, toast, field,
  numInput, textInput, segmented,
} from '../ui.js';
import { uuid, r0 } from '../util.js';
import { exercisePicker } from './today.js';
import { exerciseSheet, TRACKING } from '../exercise-form.js';
import { foodFormSheet } from './food.js';

let tab = 'exercises';
let openProgramId = null;

const TABS = [
  { value: 'exercises', label: 'Exercises' },
  { value: 'programs', label: 'Programs' },
  { value: 'foods', label: 'Foods' },
];

export async function render(refresh) {
  if (tab === 'programs' && openProgramId) return programDetail(openProgramId, refresh);

  const body =
    tab === 'exercises' ? await exercisesTab(refresh)
    : tab === 'programs' ? await programsTab(refresh)
    : await foodsTab(refresh);

  return screen('Library', null,
    segmented(TABS, tab, (v) => { tab = v; openProgramId = null; refresh(); }),
    body);
}

// ---------------------------------------------------------------------------
// Exercises
// ---------------------------------------------------------------------------

async function exercisesTab(refresh) {
  const all = await exerciseLibrary();
  const byGroup = {};
  for (const e of all) (byGroup[e.muscleGroup || 'Other'] ??= []).push(e);

  return el('div', { class: 'stack' },
    Object.entries(byGroup).sort().map(([group, list]) =>
      card(
        el('h2', { class: 'card-title' }, group),
        el('ul', { class: 'list' },
          list.map(e =>
            el('li', { class: 'list-row tappable', onclick: () => exerciseSheet(e, refresh) },
              el('div', {},
                el('div', { class: 'list-title' }, e.name),
                el('div', { class: 'list-sub' },
                  [e.equipment, TRACKING[e.trackingType], e.isUnilateral ? 'per side' : null]
                    .filter(Boolean).join(' · '))),
              el('span', { class: 'chev' }, '›')))))),
    btn('New exercise', () => exerciseSheet(null, refresh), 'primary block'));
}


// ---------------------------------------------------------------------------
// Programs
// ---------------------------------------------------------------------------

async function programsTab(refresh) {
  const programs = await db.programs.toArray();

  return el('div', { class: 'stack' },
    programs.length
      ? card(el('ul', { class: 'list' }, programs.map(p =>
          el('li', { class: 'list-row tappable', onclick: () => { openProgramId = p.id; refresh(); } },
            el('div', {},
              el('div', { class: 'list-title' }, p.name,
                p.isActive ? el('span', { class: 'tag active' }, 'active') : null),
              el('div', { class: 'list-sub' }, p.description || 'No description')),
            el('span', { class: 'chev' }, '›')))))
      : empty('No programs yet. Build your split here and the Train tab will offer it as a starting point.'),
    btn('New program', () => programSheet(null, refresh), 'primary block'));
}

function programSheet(existing, refresh) {
  sheet(existing ? 'Edit program' : 'New program', (close) => {
    const p = existing ?? {};
    const name = textInput({ value: p.name ?? '', placeholder: 'PPL 6-day' });
    const desc = textInput({ value: p.description ?? '', placeholder: 'Progression notes (optional)' });
    return [
      field('Name', name),
      field('Description', desc),
      el('div', { class: 'sheet-actions' },
        btn('Cancel', close),
        btn('Save', async () => {
          if (!name.value.trim()) return toast('Name it');
          const id = p.id ?? uuid();
          await db.programs.put({
            id, name: name.value.trim(), description: desc.value.trim(),
            isActive: p.isActive ?? false, createdAt: p.createdAt ?? new Date(),
          });
          close();
          openProgramId = id;
          refresh();
        }, 'primary')),
    ];
  });
}

async function programDetail(programId, refresh) {
  const program = await programWithDays(programId);
  if (!program) { openProgramId = null; return render(refresh); }
  const exercises = await db.exercises.toArray();
  const byId = Object.fromEntries(exercises.map(e => [e.id, e]));

  const setActive = async () => {
    // Exactly one active program drives the Train tab's "what's today" list.
    await db.transaction('rw', db.programs, async () => {
      const all = await db.programs.toArray();
      for (const p of all) await db.programs.update(p.id, { isActive: p.id === programId });
    });
    toast('Set as active program');
    refresh();
  };

  const addDay = async () => {
    await db.programDays.add({
      id: uuid(), programId,
      name: `Day ${program.days.length + 1}`,
      // Position in the rotation, not a weekday. A 6-day split on a 7-day
      // calendar drifts, so ordering by position is what lets the app say
      // "next up" instead of guessing at Tuesdays.
      orderIndex: program.days.length,
    });
    refresh();
  };

  return screen(program.name,
    el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back',
      onclick: () => { openProgramId = null; refresh(); } }, '‹'),

    el('div', { class: 'stack' },
      program.isActive
        ? el('p', { class: 'muted small' }, 'This is your active program.')
        : btn('Make this my active program', setActive, 'block')),

    program.days.map(day => dayCard(day, byId, refresh)),

    el('div', { class: 'stack' },
      btn('Add day', addDay, 'primary block'),
      btn('Edit program details', () => programSheet(program, refresh), 'block'),
      btn('Delete program', () => confirmSheet('Delete program?',
        'Your training history is kept. Past sessions keep the day name they were recorded with and just lose the link.',
        async () => { await deleteProgram(programId); openProgramId = null; refresh(); },
        'Delete program'), 'danger block')));
}

function dayCard(day, byId, refresh) {
  const addExercise = async () => {
    const lib = await exerciseLibrary();
    sheet(`Add to ${day.name}`, (close) => exercisePicker(lib, async (exercise) => {
      await db.programExercises.add({
        id: uuid(),
        programDayId: day.id,
        exerciseId: exercise.id,
        orderIndex: day.exercises.length,
        targetSets: 3,
        targetRepsLow: 8,
        targetRepsHigh: 12,
        targetRestSec: 120,
        notes: '',
      });
      close(); refresh();
    }));
  };

  return card(
    el('div', { class: 'ex-head' },
      el('h2', { class: 'card-title editable', onclick: () => renameDay(day, refresh) },
        day.name, el('span', { class: 'chev' }, '✎')),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Delete day',
        onclick: () => confirmSheet('Delete day?', `Removes ${day.name} from this program.`,
          async () => {
            await db.programExercises.where('programDayId').equals(day.id).delete();
            await db.programDays.delete(day.id);
            await db.sessions.where('programDayId').equals(day.id).modify({ programDayId: null });
            refresh();
          }, 'Delete day') }, '×')),

    day.exercises.length
      ? el('ul', { class: 'list' }, day.exercises.map(pe =>
          el('li', { class: 'list-row tappable', onclick: () => targetSheet(pe, refresh) },
            el('div', {},
              el('div', { class: 'list-title' }, byId[pe.exerciseId]?.name ?? 'Unknown'),
              el('div', { class: 'list-sub' },
                `rest ${pe.targetRestSec}s \u00b7 targets on the exercise`
                + (pe.notes ? ` · ${pe.notes}` : ''))),
            el('span', { class: 'chev' }, '›'))))
      : el('p', { class: 'muted small' }, 'No exercises yet.'),

    btn('Add exercise', addExercise, 'block small'));
}

function renameDay(day, refresh) {
  sheet('Rename day', (close) => {
    const name = textInput({ value: day.name });
    return [
      field('Name', name, 'Renaming this does not change past workouts, which keep the name they were recorded under.'),
      el('div', { class: 'sheet-actions' },
        btn('Cancel', close),
        btn('Save', async () => {
          await db.programDays.update(day.id, { name: name.value.trim() || day.name });
          close(); refresh();
        }, 'primary')),
    ];
  });
}

// Targets live on the pairing of day and exercise, not on the exercise itself.
// Squat on Leg A can be 5×5 while squat on Leg B is 3×12.
function targetSheet(pe, refresh) {
  sheet('Targets', (close) => {
    const sets = numInput({ value: pe.targetSets });
    const low = numInput({ value: pe.targetRepsLow });
    const high = numInput({ value: pe.targetRepsHigh });
    const rest = numInput({ value: pe.targetRestSec });
    const notes = textInput({ value: pe.notes ?? '', placeholder: 'last set to failure' });
    const n = (i, d) => { const v = parseInt(i.value, 10); return Number.isFinite(v) ? v : d; };

    return [
      el('div', { class: 'grid-2' },
        field('Sets', sets),
        field('Rest (seconds)', rest, 'Preloads the timer for this exercise')),
      el('div', { class: 'grid-2' },
        field('Reps from', low),
        field('Reps to', high)),
      field('Notes', notes),
      el('div', { class: 'sheet-actions' },
        btn('Remove', () => {
          close();
          confirmSheet('Remove exercise?', 'Only from this program day. Your logged sets are untouched.',
            async () => { await db.programExercises.delete(pe.id); refresh(); }, 'Remove');
        }, 'danger'),
        btn('Save', async () => {
          await db.programExercises.update(pe.id, {
            targetSets: n(sets, 3), targetRepsLow: n(low, 8),
            targetRepsHigh: n(high, 12), targetRestSec: n(rest, 120),
            notes: notes.value.trim(),
          });
          close(); refresh();
        }, 'primary')),
    ];
  });
}

// ---------------------------------------------------------------------------
// Foods
// ---------------------------------------------------------------------------

async function foodsTab(refresh) {
  const foods = await foodLibrary({ includeQuickAdds: true });
  return el('div', { class: 'stack' },
    foods.length
      ? card(el('ul', { class: 'list' }, foods.map(f =>
          el('li', { class: 'list-row tappable', onclick: () => foodFormSheet(f, refresh) },
            el('div', {},
              el('div', { class: 'list-title' }, f.name,
                f.isQuickAdd ? el('span', { class: 'tag' }, 'one-off') : null),
              el('div', { class: 'list-sub' },
                `${r0(f.kcal)} kcal · ${r0(f.protein)}P ${r0(f.carbs)}C ${r0(f.fat)}F `
                + `· logged ${f.useCount}×`)),
            el('span', { class: 'chev' }, '›')))))
      : empty('No foods saved yet.'),
    btn('New food', () => foodFormSheet(null, refresh), 'primary block'));
}
