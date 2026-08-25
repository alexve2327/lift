// db.js — the storage layer. Every other file talks to IndexedDB through here.
//
// Two things to understand before reading the schema:
//
//  1. IndexedDB indexes are declared UP FRONT, per version. You cannot add one
//     later without bumping the version. That is why version()/upgrade() exist
//     at the bottom, and why it matters even with one user: the database
//     already lives on your phone, so code and stored data will disagree
//     unless you migrate deliberately.
//
//  2. IndexedDB keys can only be number, string, Date, ArrayBuffer, or arrays
//     of those. BOOLEANS ARE NOT VALID KEYS. That is why isArchived, toFailure
//     and isQuickAdd are stored but not indexed, and are filtered in JS below.
//     Fine here: those tables hold hundreds of rows, not millions.

import Dexie from '../lib/dexie.mjs';
import { uuid, toDayKey } from './util.js';

export const db = new Dexie('LiftAndIntake');

// Index string syntax:
//   'id, name'   -> 'id' is the primary key, 'name' is an index
//   '&dayKey'    -> unique index
//   '[a+b]'      -> compound index
// Only list a field here if you QUERY or SORT by it. Every index costs write
// time and disk. Fields you merely read back are stored regardless.

db.version(1).stores({
  // --- definitions: safe to edit, they never rewrite history ---------------
  exercises:        'id, name, muscleGroup',
  programs:         'id',
  programDays:      'id, programId, [programId+orderIndex]',
  programExercises: 'id, programDayId, [programDayId+orderIndex]',
  foods:            'id, name, barcode, useCount',

  // --- history: editable, but a change leaves a visible mark ---------------
  sessions:         'id, startedAt, dayKey, programDayId',
  setEntries:       'id, sessionId, exerciseId, [sessionId+exerciseId], [exerciseId+completedAt]',
  foodEntries:      'id, dayKey, foodId',
  bodyweightEntries:'id, &dayKey',
  settings:         'key',
});

// [exerciseId+completedAt] is the important index. It turns "every squat set
// ever, in date order" into one indexed range scan instead of a full table
// scan plus a sort. At 3 sets x 6 exercises x 5 days a week you cross 5,000
// rows in about a year; without the index the chart gets slower every month.
//
// barcode is deliberately NOT unique. A unique index throws on a duplicate
// scan, turning a harmless situation into a crash. We look up first and merge.
// When a food has no barcode, leave the property UNDEFINED rather than null:
// IndexedDB omits undefined values from an index, which is what we want, and
// null is not a valid key anyway.

export const DEFAULT_SETTINGS = {
  key: 'app',
  defaultRestSec: 120,
  heightInches: null,
  birthDate: null,      // "1994-03-08"; age is computed, never stored
  sex: null,            // only an input to the BMR equation
  activityFactor: null,
  schemaVersion: 1,
};

export async function getSettings() {
  return (await db.settings.get('app')) ?? { ...DEFAULT_SETTINGS };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  await db.settings.put({ ...current, ...patch, key: 'app' });
}

export async function initDb() {
  await db.open();
  if (!(await db.settings.get('app'))) {
    await db.settings.put({ ...DEFAULT_SETTINGS });
  }
  if ((await db.exercises.count()) === 0) await seedExercises();

  // Ask Safari not to evict this database. WebKit grants persistence on
  // heuristics that favour Home Screen web apps, so this is far likelier to
  // succeed once installed than on a first visit in Safari. Not a guarantee,
  // which is exactly why exportBackup() exists.
  try {
    if (navigator.storage?.persist) {
      const ok = await navigator.storage.persist();
      console.log('[db] persistent storage:', ok ? 'granted' : 'denied');
    }
  } catch { /* Safari throws here in some private-browsing contexts */ }

  return db;
}

// ---------------------------------------------------------------------------
// WRITES THAT ENFORCE RULE TWO: history is written once, never rewritten
// ---------------------------------------------------------------------------

/** Log a food. Note what this does NOT do: store a pointer and look the macros
 *  up later. It copies them, PER SERVING, at this moment. Editing the Food
 *  tomorrow leaves this row untouched. Per serving rather than pre-multiplied
 *  so you can still correct `servings` on an old row. */
export async function logFood({ food, servings, mealSlot = null, at = new Date() }) {
  const entry = {
    id: uuid(),
    foodId: food.id ?? null,
    loggedAt: at,
    dayKey: toDayKey(at),
    mealSlot,
    servings,
    nameSnapshot: food.name,
    servingUnitSnapshot: food.servingUnit ?? 'serving',
    kcalPerServing: food.kcal,
    proteinPerServing: food.protein,
    carbsPerServing: food.carbs,
    fatPerServing: food.fat,
    editedAt: null,
  };
  await db.transaction('rw', db.foodEntries, db.foods, async () => {
    await db.foodEntries.add(entry);
    if (food.id) {
      await db.foods.update(food.id, { useCount: (food.useCount ?? 0) + 1 });
    }
  });
  return entry;
}

/** Log a set. Every set here is a working set (no warmup flag by design), so
 *  volume and PR math need no filter clause. Weight is always pounds. */
export async function logSet(fields) {
  const entry = {
    id: uuid(),
    weight: null, reps: null, durationSec: null,
    toFailure: false, restSecActual: null,
    completedAt: new Date(), editedAt: null,
    ...fields,
  };
  await db.setEntries.add(entry);
  return entry;
}

export async function editSet(id, patch) {
  await db.setEntries.update(id, { ...patch, editedAt: new Date() });
}

export async function editFoodEntry(id, patch) {
  await db.foodEntries.update(id, { ...patch, editedAt: new Date() });
}

// ---------------------------------------------------------------------------
// SESSIONS
// ---------------------------------------------------------------------------

export async function startSession({ programDay = null, at = new Date() } = {}) {
  const session = {
    id: uuid(),
    programDayId: programDay?.id ?? null,
    // The day's name as it read this morning. Rename "Push A" to "Push Heavy"
    // next month and March's sessions still say what you actually did.
    dayNameSnapshot: programDay?.name ?? 'Freestyle',
    startedAt: at,
    dayKey: toDayKey(at),
    endedAt: null,
    bodyweight: null,
    notes: '',
    editedAt: null,
  };
  await db.sessions.add(session);
  return session;
}

export async function activeSession() {
  const open = await db.sessions.filter(s => s.endedAt === null).toArray();
  return open.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null;
}

export async function endSession(id) {
  await db.sessions.update(id, { endedAt: new Date() });
}

/** Deleting a program must never delete training history. Sessions keep their
 *  name snapshot and drop the dangling pointer. */
export async function deleteProgram(programId) {
  const days = await db.programDays.where('programId').equals(programId).toArray();
  const dayIds = days.map(d => d.id);
  await db.transaction('rw', db.programs, db.programDays, db.programExercises, db.sessions, async () => {
    await db.programExercises.where('programDayId').anyOf(dayIds).delete();
    await db.programDays.where('programId').equals(programId).delete();
    await db.programs.delete(programId);
    await db.sessions.where('programDayId').anyOf(dayIds).modify({ programDayId: null });
  });
}

// ---------------------------------------------------------------------------
// READS THE UI ACTUALLY NEEDS
// ---------------------------------------------------------------------------

/** Every set of one exercise, oldest first. The progress chart's source.
 *  Rides the [exerciseId+completedAt] compound index. */
export function historyFor(exerciseId) {
  return db.setEntries
    .where('[exerciseId+completedAt]')
    .between([exerciseId, Dexie.minKey], [exerciseId, Dexie.maxKey])
    .toArray();
}

export function setsForSession(sessionId) {
  return db.setEntries.where('sessionId').equals(sessionId).toArray();
}

/** One day's food plus its totals. Totals are computed, never stored. */
export async function dayTotals(dayKey = toDayKey()) {
  const entries = await db.foodEntries.where('dayKey').equals(dayKey).toArray();
  entries.sort((a, b) => a.loggedAt - b.loggedAt);
  const totals = entries.reduce((a, e) => ({
    kcal:    a.kcal    + e.kcalPerServing    * e.servings,
    protein: a.protein + e.proteinPerServing * e.servings,
    carbs:   a.carbs   + e.carbsPerServing   * e.servings,
    fat:     a.fat     + e.fatPerServing     * e.servings,
  }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  return { entries, totals };
}

/** The scan hook: check your own library before touching any network. */
export function findFoodByBarcode(barcode) {
  return db.foods.where('barcode').equals(barcode).first();
}

/** Staples first. useCount is what stops you searching for the same fifteen
 *  foods every day. Boolean filtering happens here because IndexedDB can't. */
export async function foodLibrary({ includeQuickAdds = false } = {}) {
  const all = await db.foods.orderBy('useCount').reverse().toArray();
  return all.filter(f => !f.isArchived && (includeQuickAdds || !f.isQuickAdd));
}

export async function exerciseLibrary() {
  const all = await db.exercises.orderBy('name').toArray();
  return all.filter(e => !e.isArchived);
}

export async function programWithDays(programId) {
  const program = await db.programs.get(programId);
  if (!program) return null;
  const days = await db.programDays
    .where('[programId+orderIndex]')
    .between([programId, Dexie.minKey], [programId, Dexie.maxKey])
    .toArray();
  for (const d of days) {
    d.exercises = await db.programExercises
      .where('[programDayId+orderIndex]')
      .between([d.id, Dexie.minKey], [d.id, Dexie.maxKey])
      .toArray();
  }
  return { ...program, days };
}

export async function activeProgram() {
  const all = await db.programs.toArray();
  const active = all.find(p => p.isActive);
  return active ? programWithDays(active.id) : null;
}

/** Last time you did this exercise, for the "last time: 185 x 8" hint that
 *  makes the logging screen actually useful. */
export async function lastPerformance(exerciseId, excludeSessionId = null) {
  const sets = await historyFor(exerciseId);
  const prior = sets.filter(s => s.sessionId !== excludeSessionId);
  if (!prior.length) return null;
  const lastSessionId = prior[prior.length - 1].sessionId;
  return prior.filter(s => s.sessionId === lastSessionId);
}

// ---------------------------------------------------------------------------
// BACKUP — build this on day one, not day ninety
// ---------------------------------------------------------------------------
// Safari's storage guarantees are heuristic. A year of logs living in exactly
// one place on one phone is not a plan.

export async function exportBackup() {
  const dump = {
    app: 'LiftAndIntake',
    exportedAt: new Date().toISOString(),
    schemaVersion: 1,
    data: {},
  };
  for (const t of db.tables) dump.data[t.name] = await t.toArray();
  return new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
}

export async function importBackup(json) {
  const dump = JSON.parse(json);
  if (dump.app !== 'LiftAndIntake') throw new Error('Not a backup from this app.');
  await db.transaction('rw', db.tables, async () => {
    for (const t of db.tables) {
      const rows = dump.data[t.name];
      if (!rows) continue;
      await t.clear();
      // Dates survive JSON as strings; revive the ones we sort and index on.
      for (const row of rows) {
        for (const k of ['startedAt', 'endedAt', 'completedAt', 'loggedAt', 'editedAt', 'createdAt']) {
          if (typeof row[k] === 'string') row[k] = new Date(row[k]);
        }
      }
      await t.bulkAdd(rows);
    }
  });
}

// ---------------------------------------------------------------------------
// SEED — enough exercises that the app is usable in the first thirty seconds
// ---------------------------------------------------------------------------

async function seedExercises() {
  const mk = (name, muscleGroup, equipment, trackingType = 'weight_reps') => ({
    id: uuid(), name, muscleGroup, equipment, trackingType,
    notes: '', isArchived: false,
  });
  await db.exercises.bulkAdd([
    mk('Barbell Back Squat', 'Legs', 'Barbell'),
    mk('Barbell Bench Press', 'Chest', 'Barbell'),
    mk('Conventional Deadlift', 'Back', 'Barbell'),
    mk('Overhead Press', 'Shoulders', 'Barbell'),
    mk('Barbell Row', 'Back', 'Barbell'),
    mk('Romanian Deadlift', 'Legs', 'Barbell'),
    mk('Incline Dumbbell Press', 'Chest', 'Dumbbell'),
    mk('Lat Pulldown', 'Back', 'Cable'),
    mk('Seated Cable Row', 'Back', 'Cable'),
    mk('Leg Press', 'Legs', 'Machine'),
    mk('Leg Curl', 'Legs', 'Machine'),
    mk('Dumbbell Lateral Raise', 'Shoulders', 'Dumbbell'),
    mk('Cable Tricep Pushdown', 'Arms', 'Cable'),
    mk('Dumbbell Curl', 'Arms', 'Dumbbell'),
    mk('Pull-Up', 'Back', 'Bodyweight', 'bodyweight_reps'),
    mk('Dip', 'Chest', 'Bodyweight', 'bodyweight_reps'),
    mk('Plank', 'Core', 'Bodyweight', 'duration'),
    mk('Hanging Leg Raise', 'Core', 'Bodyweight', 'bodyweight_reps'),
  ]);
}
