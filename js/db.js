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
import { seedMealPrep } from './seed.js';

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

// --- version 2: meals, and per-side tracking -------------------------------
//
// This is the migration machinery from the original comment, used for real.
// Only tables whose INDEXES change need listing; `side` on setEntries and
// `isUnilateral` on exercises are plain fields, so they need no entry here and
// no backfill (undefined reads as "not unilateral" / "no side").
db.version(2).stores({
  meals:       'id, name, useCount',
  mealItems:   'id, mealId, [mealId+orderIndex]',
  foodEntries: 'id, dayKey, foodId, mealLogId',
}).upgrade(async (tx) => {
  await tx.table('settings').toCollection().modify((s) => { s.schemaVersion = 2; });
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
  schemaVersion: 2,
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
  // Idempotent and name-matched, so it fills in the meal prep recipes once
  // and never fights an edit you make afterwards.
  if ((await db.meals.count()) === 0) await seedMealPrep();

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
  await repairMealLinks();
}

/** Restoring a backup replaces `foods` wholesale. A backup taken before meals
 *  existed (schemaVersion 1) has no meals section, so the meal recipes survive
 *  the import while the foods they point at are deleted out from under them,
 *  leaving recipes with silently missing ingredients.
 *
 *  So: drop item rows whose food is gone, delete any meal left empty, then
 *  re-run the name-matched seed to put the meal prep recipes back. A v1 restore
 *  therefore gives you your logged history plus intact recipes, rather than a
 *  meal list that looks fine and quietly totals zero. */
export async function repairMealLinks() {
  const foodIds = new Set((await db.foods.toArray()).map((f) => f.id));
  const items = await db.mealItems.toArray();
  const orphans = items.filter((i) => !foodIds.has(i.foodId));
  if (orphans.length) {
    await db.mealItems.bulkDelete(orphans.map((i) => i.id));
  }
  const left = await db.mealItems.toArray();
  const stillUsed = new Set(left.map((i) => i.mealId));
  const empties = (await db.meals.toArray()).filter((m) => !stillUsed.has(m.id));
  if (empties.length) await db.meals.bulkDelete(empties.map((m) => m.id));
  await seedMealPrep();
  return { prunedItems: orphans.length, removedMeals: empties.length };
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

// ---------------------------------------------------------------------------
// MEALS (schema v2)
// ---------------------------------------------------------------------------
// A Meal is a named recipe: a list of Foods with per-serving amounts. Logging
// one does NOT create a single lumped entry. It creates one FoodEntry per
// ingredient, all sharing a mealLogId, so:
//
//   - the day view can collapse them under the meal name,
//   - "my beef was 8 oz today" is editing one row, not rebuilding a total,
//   - rule two still holds: every row snapshots its own macros at log time.
//
// A lumped entry would have been simpler to display and impossible to correct.

export async function mealLibrary() {
  const all = await db.meals.orderBy('useCount').reverse().toArray();
  return all.filter((m) => !m.isArchived);
}

export async function mealWithItems(mealId) {
  const meal = await db.meals.get(mealId);
  if (!meal) return null;
  const items = await db.mealItems
    .where('[mealId+orderIndex]')
    .between([mealId, Dexie.minKey], [mealId, Dexie.maxKey])
    .toArray();
  const foods = await db.foods.bulkGet(items.map((i) => i.foodId));
  return {
    ...meal,
    items: items.map((i, n) => ({ ...i, food: foods[n] ?? null })).filter((i) => i.food),
  };
}

/** Totals for a meal as currently defined. Computed, never stored: edit an
 *  ingredient and the meal's numbers follow, while logged history does not. */
export function mealTotals(meal) {
  return meal.items.reduce((a, i) => ({
    kcal:    a.kcal    + i.food.kcal    * i.servings,
    protein: a.protein + i.food.protein * i.servings,
    carbs:   a.carbs   + i.food.carbs   * i.servings,
    fat:     a.fat     + i.food.fat     * i.servings,
  }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
}

export async function saveMeal({ id, name, notes = '', items }) {
  const mealId = id ?? uuid();
  await db.transaction('rw', db.meals, db.mealItems, async () => {
    const existing = id ? await db.meals.get(id) : null;
    await db.meals.put({
      id: mealId, name, notes,
      useCount: existing?.useCount ?? 0,
      isArchived: false,
      createdAt: existing?.createdAt ?? new Date(),
    });
    await db.mealItems.where('mealId').equals(mealId).delete();
    await db.mealItems.bulkAdd(items.map((it, n) => ({
      id: uuid(), mealId, foodId: it.foodId, servings: it.servings, orderIndex: n,
    })));
  });
  return mealId;
}

export async function deleteMeal(mealId) {
  // Logged history survives: entries keep mealNameSnapshot and their own macros,
  // and just lose the pointer. Same rule as deleting a program.
  await db.transaction('rw', db.meals, db.mealItems, db.foodEntries, async () => {
    await db.mealItems.where('mealId').equals(mealId).delete();
    await db.meals.delete(mealId);
    // mealId is not indexed on foodEntries (we query by mealLogId, not mealId),
    // so this is a filter scan rather than a where(). Fine at this table size.
    await db.foodEntries.filter((e) => e.mealId === mealId).modify({ mealId: null });
  });
}

/** Log a whole meal: one FoodEntry per ingredient, grouped by mealLogId. */
export async function logMeal({ meal, scale = 1, mealSlot = null, at = new Date() }) {
  const mealLogId = uuid();
  const rows = meal.items.map((i, n) => ({
    id: uuid(),
    // Recipe order, kept on the entry. Every row in a meal shares one
    // timestamp, so without this the day view lists them in whatever order
    // IndexedDB hands back, which is by uuid and therefore random.
    itemIndex: n,
    foodId: i.food.id,
    loggedAt: at,
    dayKey: toDayKey(at),
    mealSlot,
    servings: i.servings * scale,
    nameSnapshot: i.food.name,
    servingUnitSnapshot: i.food.servingUnit ?? 'serving',
    kcalPerServing: i.food.kcal,
    proteinPerServing: i.food.protein,
    carbsPerServing: i.food.carbs,
    fatPerServing: i.food.fat,
    editedAt: null,
    mealLogId,
    mealId: meal.id,
    mealNameSnapshot: meal.name,
  }));
  await db.transaction('rw', db.foodEntries, db.foods, db.meals, async () => {
    await db.foodEntries.bulkAdd(rows);
    for (const i of meal.items) {
      await db.foods.update(i.food.id, { useCount: (i.food.useCount ?? 0) + 1 });
    }
    const m = await db.meals.get(meal.id);
    if (m) await db.meals.update(meal.id, { useCount: (m.useCount ?? 0) + 1 });
  });
  return mealLogId;
}

export async function deleteMealLog(mealLogId) {
  await db.foodEntries.where('mealLogId').equals(mealLogId).delete();
}

/** Group a day's entries: meal groups first, then loose entries. */
export function groupEntries(entries) {
  const groups = new Map();
  const loose = [];
  for (const e of entries) {
    if (!e.mealLogId) { loose.push(e); continue; }
    if (!groups.has(e.mealLogId)) {
      groups.set(e.mealLogId, {
        mealLogId: e.mealLogId,
        name: e.mealNameSnapshot ?? 'Meal',
        mealSlot: e.mealSlot,
        loggedAt: e.loggedAt,
        entries: [],
      });
    }
    groups.get(e.mealLogId).entries.push(e);
  }
  for (const g of groups.values()) {
    g.entries.sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0));
  }
  const sum = (rows) => rows.reduce((a, e) => ({
    kcal:    a.kcal    + e.kcalPerServing    * e.servings,
    protein: a.protein + e.proteinPerServing * e.servings,
    carbs:   a.carbs   + e.carbsPerServing   * e.servings,
    fat:     a.fat     + e.fatPerServing     * e.servings,
  }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  const meals = [...groups.values()].map((g) => ({ ...g, totals: sum(g.entries) }));
  return { meals, loose };
}

// ---------------------------------------------------------------------------
// BODYWEIGHT
// ---------------------------------------------------------------------------

export async function bodyweightSeries() {
  const rows = await db.bodyweightEntries.toArray();
  rows.sort((a, b) => a.dayKey.localeCompare(b.dayKey));
  return rows;
}

export async function logBodyweight(weight, dayKey = toDayKey()) {
  const existing = await db.bodyweightEntries.where('dayKey').equals(dayKey).first();
  if (existing) {
    await db.bodyweightEntries.update(existing.id, { weight, loggedAt: new Date() });
    return existing.id;
  }
  const id = uuid();
  await db.bodyweightEntries.add({ id, dayKey, weight, loggedAt: new Date() });
  return id;
}
