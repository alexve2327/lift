// views/food.js — the nutrition tab.
//
// The design premise: you eat roughly the same fifteen things. So the default
// screen is not a search box, it is your staples sorted by how often you
// actually log them (useCount), one tap from being logged again. Searching is
// the fallback, not the primary path.

import {
  db, dayTotals, foodLibrary, logFood, editFoodEntry, findFoodByBarcode,
} from '../db.js';
import {
  el, screen, card, btn, empty, sheet, confirmSheet, toast, field,
  numInput, textInput, segmented, stat,
} from '../ui.js';
import { uuid, toDayKey, shiftDayKey, fmtDayLabel, r0, r1 } from '../util.js';

const MEALS = [
  { value: 'breakfast', label: 'Breakfast' },
  { value: 'lunch', label: 'Lunch' },
  { value: 'dinner', label: 'Dinner' },
  { value: 'snack', label: 'Snack' },
];

let viewDay = toDayKey();

export async function render(refresh) {
  const { entries, totals } = await dayTotals(viewDay);
  const library = await foodLibrary();

  const nav = el('div', { class: 'day-nav' },
    el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous day',
      onclick: () => { viewDay = shiftDayKey(viewDay, -1); refresh(); } }, '‹'),
    el('span', { class: 'day-label' }, fmtDayLabel(viewDay)),
    el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next day',
      disabled: viewDay >= toDayKey(),
      onclick: () => { viewDay = shiftDayKey(viewDay, 1); refresh(); } }, '›'));

  return screen('Food', nav,

    // Totals are computed from the entries every render, never stored. There
    // is no cached daily total to fall out of sync with the log.
    el('div', { class: 'stat-row' },
      stat(r0(totals.kcal).toLocaleString(), 'kcal'),
      stat(r0(totals.protein) + 'g', 'protein', 'accent'),
      stat(r0(totals.carbs) + 'g', 'carbs'),
      stat(r0(totals.fat) + 'g', 'fat')),

    entries.length
      ? card(
          el('h2', { class: 'card-title' }, 'Logged'),
          el('ul', { class: 'list' }, entries.map(e => entryRow(e, refresh))))
      : empty('Nothing logged for this day.'),

    card(
      el('h2', { class: 'card-title' }, 'Your staples'),
      el('p', { class: 'muted small' },
        'Ordered by how often you log them. One tap to add.'),
      library.length
        ? el('ul', { class: 'list' }, library.slice(0, 12).map(f => staple(f, refresh)))
        : el('p', { class: 'muted' }, 'Nothing saved yet. Add a food below.')),

    el('div', { class: 'stack' },
      btn('Search foods', () => searchSheet(library, refresh), 'block'),
      btn('New food', () => foodFormSheet(null, refresh), 'primary block'),
      btn('Quick add (one-off)', () => quickAddSheet(refresh), 'block')));
}

function staple(food, refresh) {
  return el('li', { class: 'list-row tappable', onclick: () => logSheet(food, refresh) },
    el('div', {},
      el('div', { class: 'list-title' }, food.name),
      el('div', { class: 'list-sub' },
        `${r0(food.kcal)} kcal · ${r0(food.protein)}P ${r0(food.carbs)}C ${r0(food.fat)}F `
        + `per ${food.servingQty} ${food.servingUnit}`)),
    el('span', { class: 'add-mark' }, '+'));
}

function entryRow(e, refresh) {
  const kcal = e.kcalPerServing * e.servings;
  return el('li', { class: 'list-row' },
    el('div', {},
      el('div', { class: 'list-title' },
        e.nameSnapshot,
        e.editedAt ? el('span', { class: 'tag edited' }, 'edited') : null),
      el('div', { class: 'list-sub' },
        `${r1(e.servings)} × ${e.servingUnitSnapshot}`
        + (e.mealSlot ? ` · ${e.mealSlot}` : ''))),
    el('div', { class: 'entry-right' },
      el('span', { class: 'entry-kcal' }, r0(kcal)),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Edit entry',
        onclick: () => entrySheet(e, refresh) }, '⋯')));
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logSheet(food, refresh) {
  sheet(food.name, (close) => {
    const servings = numInput({ value: '1', class: 'big-in' });
    let meal = null;
    const seg = el('div', {});
    const drawSeg = () => seg.replaceChildren(
      segmented(MEALS, meal, (v) => { meal = meal === v ? null : v; drawSeg(); }));
    drawSeg();

    const preview = el('div', { class: 'muted small' });
    const updatePreview = () => {
      const n = parseFloat(servings.value) || 0;
      preview.textContent =
        `${r0(food.kcal * n)} kcal · ${r1(food.protein * n)}P `
        + `${r1(food.carbs * n)}C ${r1(food.fat * n)}F`;
    };
    servings.addEventListener('input', updatePreview);
    updatePreview();

    return [
      field(`Servings (${food.servingQty} ${food.servingUnit} each)`, servings),
      preview,
      el('div', { class: 'stack' }, seg),
      el('div', { class: 'sheet-actions' },
        btn('Cancel', close),
        btn('Log it', async () => {
          const n = parseFloat(servings.value);
          if (!Number.isFinite(n) || n <= 0) return toast('How many servings?');
          // logFood copies the macros onto the entry right now. Editing this
          // food tomorrow will not touch what you just recorded.
          await logFood({ food, servings: n, mealSlot: meal, at: dayDate() });
          close();
          toast('Logged');
          refresh();
        }, 'primary')),
    ];
  });
}

/** When browsing a past day, log into THAT day rather than silently into today. */
function dayDate() {
  if (viewDay === toDayKey()) return new Date();
  const [y, m, d] = viewDay.split('-').map(Number);
  const now = new Date();
  return new Date(y, m - 1, d, now.getHours(), now.getMinutes());
}

function entrySheet(e, refresh) {
  sheet(e.nameSnapshot, (close) => {
    const servings = numInput({ value: e.servings });
    return [
      el('p', { class: 'muted small' },
        `Recorded at ${r0(e.kcalPerServing)} kcal per ${e.servingUnitSnapshot}. `
        + 'Those numbers are frozen: correcting the food in your library will not change this entry.'),
      field('Servings', servings),
      el('div', { class: 'sheet-actions' },
        btn('Delete', () => {
          close();
          confirmSheet('Delete entry?', 'This removes it from the day.', async () => {
            await db.foodEntries.delete(e.id);
            refresh();
          });
        }, 'danger'),
        btn('Save', async () => {
          const n = parseFloat(servings.value);
          if (!Number.isFinite(n) || n <= 0) return toast('How many servings?');
          await editFoodEntry(e.id, { servings: n });
          close();
          refresh();
        }, 'primary')),
    ];
  });
}

// ---------------------------------------------------------------------------
// Library management
// ---------------------------------------------------------------------------

function searchSheet(library, refresh) {
  sheet('Search foods', (close) => {
    const search = textInput({ placeholder: 'Name or brand', class: 'search' });
    const list = el('ul', { class: 'list' });
    const draw = async () => {
      const q = search.value.trim().toLowerCase();
      const all = await foodLibrary({ includeQuickAdds: true });
      const hits = all.filter(f =>
        !q || f.name.toLowerCase().includes(q) || (f.brand ?? '').toLowerCase().includes(q));
      list.replaceChildren(...hits.slice(0, 40).map(f =>
        el('li', {},
          el('button', { class: 'pick-row', type: 'button',
            onclick: () => { close(); logSheet(f, refresh); } },
            el('span', { class: 'list-title' }, f.name),
            el('span', { class: 'list-sub' },
              `${r0(f.kcal)} kcal per ${f.servingQty} ${f.servingUnit}`)))));
    };
    search.addEventListener('input', draw);
    draw();
    return [search, list];
  });
}

export function foodFormSheet(existing, refresh, onSaved) {
  sheet(existing ? 'Edit food' : 'New food', (close) => {
    const f = existing ?? {};
    const name = textInput({ value: f.name ?? '', placeholder: 'Fairlife Core Power' });
    const brand = textInput({ value: f.brand ?? '', placeholder: 'Brand (optional)' });
    const qty = numInput({ value: f.servingQty ?? 1 });
    const unit = textInput({ value: f.servingUnit ?? 'container', placeholder: 'container, g, slice' });
    const grams = numInput({ value: f.servingGrams ?? '', placeholder: 'optional' });
    const kcal = numInput({ value: f.kcal ?? '' });
    const protein = numInput({ value: f.protein ?? '' });
    const carbs = numInput({ value: f.carbs ?? '' });
    const fat = numInput({ value: f.fat ?? '' });

    return [
      el('p', { class: 'muted small' },
        'Enter the numbers exactly as printed on the label, per serving. '
        + 'Storing what the box says keeps your data checkable against the box.'),
      field('Name', name),
      field('Brand', brand),
      el('div', { class: 'grid-2' },
        field('Serving size', qty),
        field('Unit', unit)),
      field('Grams per serving', grams, 'Optional. Lets the app convert "1 slice" to grams later.'),
      el('div', { class: 'grid-2' },
        field('Calories', kcal),
        field('Protein (g)', protein)),
      el('div', { class: 'grid-2' },
        field('Carbs (g)', carbs),
        field('Fat (g)', fat)),
      el('div', { class: 'sheet-actions' },
        btn('Cancel', close),
        btn('Save', async () => {
          const num = (input, fallback = 0) => {
            const v = parseFloat(input.value);
            return Number.isFinite(v) ? v : fallback;
          };
          if (!name.value.trim()) return toast('Name it');
          const record = {
            id: f.id ?? uuid(),
            name: name.value.trim(),
            brand: brand.value.trim() || null,
            // Deliberately undefined, not null, when absent: IndexedDB omits
            // undefined values from an index, and null is not a valid key.
            barcode: f.barcode ?? undefined,
            servingQty: num(qty, 1),
            servingUnit: unit.value.trim() || 'serving',
            servingGrams: grams.value === '' ? null : num(grams),
            kcal: num(kcal), protein: num(protein), carbs: num(carbs), fat: num(fat),
            fiber: null, sugar: null, sodium: null,
            source: f.source ?? 'manual',
            useCount: f.useCount ?? 0,
            isQuickAdd: false,
            isArchived: false,
          };
          await db.foods.put(record);
          close();
          toast(existing ? 'Food updated' : 'Food saved');
          onSaved ? onSaved(record) : refresh();
        }, 'primary')),
    ];
  });
}

/** One-off food: logged, but kept out of the searchable library so it does not
 *  clutter the fifteen things you actually eat. Promotable later. */
function quickAddSheet(refresh) {
  sheet('Quick add', (close) => {
    const name = textInput({ placeholder: 'What was it?' });
    const kcal = numInput({ placeholder: 'kcal' });
    const protein = numInput({ placeholder: 'protein (g)' });
    const carbs = numInput({ placeholder: 'carbs (g)' });
    const fat = numInput({ placeholder: 'fat (g)' });
    let keep = false;
    const keepBtn = el('button', { type: 'button', class: 'fail-btn wide',
      onclick: () => { keep = !keep; keepBtn.classList.toggle('on', keep); } },
      'Also save to my library');

    return [
      el('p', { class: 'muted small' },
        'For something you ate once. It gets logged with real numbers but stays out of your staples list.'),
      field('Name', name),
      el('div', { class: 'grid-2' }, field('Calories', kcal), field('Protein (g)', protein)),
      el('div', { class: 'grid-2' }, field('Carbs (g)', carbs), field('Fat (g)', fat)),
      el('div', { class: 'stack' }, keepBtn),
      el('div', { class: 'sheet-actions' },
        btn('Cancel', close),
        btn('Log it', async () => {
          const num = (i) => { const v = parseFloat(i.value); return Number.isFinite(v) ? v : 0; };
          if (!name.value.trim()) return toast('Name it');
          const food = {
            id: uuid(), name: name.value.trim(), brand: null, barcode: undefined,
            servingQty: 1, servingUnit: 'serving', servingGrams: null,
            kcal: num(kcal), protein: num(protein), carbs: num(carbs), fat: num(fat),
            fiber: null, sugar: null, sodium: null,
            source: 'manual', useCount: 0,
            isQuickAdd: !keep, isArchived: false,
          };
          await db.foods.add(food);
          await logFood({ food, servings: 1, at: dayDate() });
          close();
          toast('Logged');
          refresh();
        }, 'primary')),
    ];
  });
}

// Kept here so the barcode work has an obvious home later. Scanning is not a
// new entity and not a new relationship: it is an alternative way to fill in
// the form above, which is why `barcode` and `source` already exist on Food.
export async function lookupBarcode(code) {
  const mine = await findFoodByBarcode(code);
  if (mine) return { food: mine, from: 'library' };
  return { food: null, from: 'none' };
}
