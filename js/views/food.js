// views/food.js — the nutrition tab, rebuilt around meals.
//
// The old version went unused for a reason: it made you log ground beef, then
// rice, then sweet potato, then oil, then broth, then yogurt, every single day,
// for a bowl you eat eight days in a row. Six screens for one dinner.
//
// Now the unit of logging is a MEAL. One tap logs the whole bowl. Under the
// hood it still writes one entry per ingredient (see logMeal in db.js), so the
// day you use 8 oz of beef instead of 6.5 you edit that one number rather than
// rebuilding the meal. The convenience is in the UI; the data stays granular.

import {
  db, dayTotals, foodLibrary, logFood, editFoodEntry, findFoodByBarcode,
  mealLibrary, mealWithItems, mealTotals, saveMeal, deleteMeal, logMeal,
  deleteMealLog, groupEntries, mealGroups, duplicateMeal,
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
const openGroups = new Set();

export async function render(refresh) {
  const { entries, totals } = await dayTotals(viewDay);
  const { meals: logged, loose } = groupEntries(entries);
  const groups = await mealGroups();

  const nav = el('div', { class: 'day-nav' },
    el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous day',
      onclick: () => { viewDay = shiftDayKey(viewDay, -1); refresh(); } }, '‹'),
    el('span', { class: 'day-label' }, fmtDayLabel(viewDay)),
    el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next day',
      disabled: viewDay >= toDayKey(),
      onclick: () => { viewDay = shiftDayKey(viewDay, 1); refresh(); } }, '›'));

  return screen('Food', nav,

    // Totals are recomputed from the entries on every render. There is no
    // stored daily total that can drift out of sync with the log.
    el('div', { class: 'stat-row' },
      stat(r0(totals.kcal).toLocaleString(), 'kcal'),
      stat(r0(totals.protein) + 'g', 'protein', 'accent'),
      stat(r0(totals.carbs) + 'g', 'carbs'),
      stat(r0(totals.fat) + 'g', 'fat')),

    (logged.length || loose.length)
      ? card(
          el('h2', { class: 'card-title' }, 'Logged'),
          el('div', { class: 'stack' },
            logged.map((g) => mealGroup(g, refresh)),
            loose.length ? el('ul', { class: 'list' }, loose.map((e) => entryRow(e, refresh))) : null))
      : empty('Nothing logged for this day.'),

    card(
      el('h2', { class: 'card-title' }, 'Your meals'),
      el('p', { class: 'muted small' }, 'One tap logs every ingredient. Edit any of them after.'),
      groups.length
        ? el('ul', { class: 'list' }, groups.flatMap((g) => [
            mealRow(g.base, refresh, false),
            ...g.variants.map((v) => mealRow(v, refresh, true)),
          ]))
        : el('p', { class: 'muted' }, 'No meals yet. Build one below.')),

    el('div', { class: 'stack' },
      btn('New meal', () => mealBuilder(null, refresh), 'primary block'),
      btn('Log a single food', () => searchSheet(refresh), 'block'),
      btn('Quick add (one-off)', () => quickAddSheet(refresh), 'block')));
}

// ---------------------------------------------------------------------------
// Logged meals in the day view: collapsed by default, expand to edit
// ---------------------------------------------------------------------------

function mealGroup(g, refresh) {
  const open = openGroups.has(g.mealLogId);
  const node = el('div', { class: 'meal-group' + (open ? ' open' : '') },
    el('button', {
      class: 'meal-head', type: 'button',
      'aria-expanded': String(open),
      onclick: () => {
        if (open) openGroups.delete(g.mealLogId); else openGroups.add(g.mealLogId);
        refresh();
      },
    },
      el('span', { class: 'meal-caret' }, '›'),
      el('span', { class: 'list-title' }, g.name,
        g.entries.some((e) => e.editedAt) ? el('span', { class: 'tag edited' }, 'edited') : null),
      el('span', { class: 'meal-kcal' }, r0(g.totals.kcal))));

  if (open) {
    node.append(el('div', { class: 'meal-items' },
      el('ul', { class: 'list' }, g.entries.map((e) => entryRow(e, refresh, true))),
      el('div', { class: 'stack' },
        el('p', { class: 'muted small' },
          `${r0(g.totals.protein)}P · ${r0(g.totals.carbs)}C · ${r0(g.totals.fat)}F`),
        btn('Remove this meal', () => confirmSheet('Remove meal?',
          `Deletes all ${g.entries.length} ingredient entries from this day.`,
          async () => { await deleteMealLog(g.mealLogId); refresh(); },
          'Remove'), 'danger small block'))));
  }
  return node;
}

function entryRow(e, refresh, inMeal = false) {
  const kcal = e.kcalPerServing * e.servings;
  return el('li', { class: 'list-row' },
    el('div', {},
      el('div', { class: 'list-title' },
        e.nameSnapshot,
        !inMeal && e.editedAt ? el('span', { class: 'tag edited' }, 'edited') : null),
      el('div', { class: 'list-sub' },
        `${r1(e.servings)} × ${e.servingUnitSnapshot}`
        + (!inMeal && e.mealSlot ? ` · ${e.mealSlot}` : ''))),
    el('div', { class: 'entry-right' },
      el('span', { class: 'entry-kcal' }, r0(kcal)),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Edit entry',
        onclick: () => entrySheet(e, refresh) }, '⋯')));
}

/** Editing one logged ingredient. This is the "my beef was different today"
 *  path, and it is one sheet with one number in it. */
function entrySheet(e, refresh) {
  sheet(e.nameSnapshot, (close) => {
    const servings = numInput({ value: e.servings, class: 'big-in' });
    const preview = el('div', { class: 'muted small' });
    const update = () => {
      const n = parseFloat(servings.value) || 0;
      preview.textContent = `${r0(e.kcalPerServing * n)} kcal · ${r1(e.proteinPerServing * n)}P `
        + `${r1(e.carbsPerServing * n)}C ${r1(e.fatPerServing * n)}F`;
    };
    servings.addEventListener('input', update);
    update();

    return [
      el('p', { class: 'muted small' },
        `Recorded at ${r0(e.kcalPerServing)} kcal per ${e.servingUnitSnapshot}. Those numbers are `
        + 'frozen: correcting this food in your library will not change what you already logged.'),
      field(`Servings (${e.servingUnitSnapshot})`, servings),
      preview,
      el('div', { class: 'sheet-actions' },
        btn('Delete', () => {
          close();
          confirmSheet('Delete entry?', 'This removes it from the day.',
            async () => { await db.foodEntries.delete(e.id); refresh(); }, 'Delete');
        }, 'danger'),
        btn('Save', async () => {
          const n = parseFloat(servings.value);
          if (!Number.isFinite(n) || n <= 0) return toast('How many servings?');
          await editFoodEntry(e.id, { servings: n });
          close(); refresh();
        }, 'primary')),
    ];
  });
}

// ---------------------------------------------------------------------------
// The meal library
// ---------------------------------------------------------------------------

function mealRow(m, refresh, isVariant = false) {
  return el('li', {
    class: 'list-row tappable' + (isVariant ? ' variant' : ''),
    onclick: () => logMealSheet(m, refresh),
  },
    el('div', {},
      el('div', { class: 'list-title' },
        isVariant ? el('span', { class: 'variant-mark' }, '\u21b3') : null,
        m.name),
      // Live totals, not the stored note. The note describes the recipe it was
      // written for; these describe the recipe as it is right now.
      el('div', { class: 'list-sub' },
        m.totals
          ? `${r0(m.totals.kcal)} kcal \u00b7 ${r0(m.totals.protein)}P `
            + `${r0(m.totals.carbs)}C ${r0(m.totals.fat)}F \u00b7 ${m.itemCount} ingredients`
          : (m.notes || `logged ${m.useCount ?? 0}\u00d7`))),
    el('div', { class: 'entry-right' },
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Edit meal',
        onclick: (ev) => { ev.stopPropagation(); mealBuilder(m.id, refresh); } }, '⋯'),
      el('span', { class: 'add-mark' }, '+')));
}

function logMealSheet(meal, refresh) {
  sheet(meal.name, async (close) => {
    const full = await mealWithItems(meal.id);
    const t = mealTotals(full);

    const scale = numInput({ value: '1', class: 'big-in' });
    let slot = guessSlot();
    const seg = el('div', {});
    const drawSeg = () => seg.replaceChildren(
      segmented(MEALS, slot, (v) => { slot = slot === v ? null : v; drawSeg(); }));
    drawSeg();

    const preview = el('div', { class: 'muted small' });
    const update = () => {
      const n = parseFloat(scale.value) || 0;
      preview.textContent = `${r0(t.kcal * n)} kcal · ${r1(t.protein * n)}P `
        + `${r1(t.carbs * n)}C ${r1(t.fat * n)}F`;
    };
    scale.addEventListener('input', update);
    update();

    return [
      el('ul', { class: 'list' }, full.items.map((i) =>
        el('li', { class: 'list-row' },
          el('div', { class: 'list-title' }, i.food.name),
          el('div', { class: 'list-sub' }, `${r1(i.servings)} × ${i.food.servingUnit}`)))),
      field('Portions', scale, 'Half a bowl is 0.5. Each ingredient scales with it.'),
      preview,
      el('div', { class: 'stack' }, seg),
      el('div', { class: 'sheet-actions' },
        btn('Cancel', close),
        btn('Log meal', async () => {
          const n = parseFloat(scale.value);
          if (!Number.isFinite(n) || n <= 0) return toast('How many portions?');
          await logMeal({ meal: full, scale: n, mealSlot: slot, at: dayDate() });
          close(); toast('Logged'); refresh();
        }, 'primary')),
    ];
  });
}

function guessSlot() {
  const h = new Date().getHours();
  if (h < 10) return 'breakfast';
  if (h < 15) return 'lunch';
  if (h < 21) return 'dinner';
  return 'snack';
}

// ---------------------------------------------------------------------------
// Meal builder
// ---------------------------------------------------------------------------

function mealBuilder(mealId, refresh) {
  sheet(mealId ? 'Edit meal' : 'New meal', async (close) => {
    const existing = mealId ? await mealWithItems(mealId) : null;
    const name = textInput({ value: existing?.name ?? '', placeholder: 'Dinner Bowl' });
    const notes = textInput({ value: existing?.notes ?? '', placeholder: 'Note (optional)' });

    let items = existing ? existing.items.map((i) => ({ foodId: i.food.id, food: i.food, servings: i.servings })) : [];
    const list = el('div', { class: 'stack' });
    const totalsLine = el('p', { class: 'muted small' });

    const redraw = () => {
      const t = items.reduce((a, i) => ({
        kcal: a.kcal + i.food.kcal * i.servings,
        protein: a.protein + i.food.protein * i.servings,
        carbs: a.carbs + i.food.carbs * i.servings,
        fat: a.fat + i.food.fat * i.servings,
      }), { kcal: 0, protein: 0, carbs: 0, fat: 0 });
      totalsLine.textContent = items.length
        ? `${r0(t.kcal)} kcal · ${r1(t.protein)}P ${r1(t.carbs)}C ${r1(t.fat)}F`
        : 'Add ingredients to see totals.';

      list.replaceChildren(...items.map((i, n) => {
        const amt = numInput({ value: i.servings });
        amt.addEventListener('input', () => {
          const v = parseFloat(amt.value);
          if (Number.isFinite(v)) { items[n].servings = v; redraw(); }
        });
        return el('div', { class: 'ingredient-row' },
          el('button', {
            class: 'ing-name swap', type: 'button',
            onclick: () => pickFood((f) => { items[n] = { foodId: f.id, food: f, servings: items[n].servings }; redraw(); },
              `Replace ${i.food.name}`),
          },
            i.food.name,
            el('div', { class: 'ing-macros' },
              `${r0(i.food.kcal)} kcal / ${i.food.servingUnit} \u00b7 tap to swap`)),
          amt,
          el('span', { class: 'ing-macros' }, i.food.servingUnit),
          el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove ingredient',
            onclick: () => { items.splice(n, 1); redraw(); } }, '×'));
      }));
    };
    redraw();

    const pickFood = async (onPick, title = 'Add ingredient') => {
      const foods = await foodLibrary({ includeQuickAdds: true });
      sheet(title, (closePick) => {
        const search = textInput({ placeholder: 'Search foods', class: 'search' });
        const out = el('ul', { class: 'list' });
        const draw = () => {
          const q = search.value.trim().toLowerCase();
          const hits = foods.filter((f) => !q || f.name.toLowerCase().includes(q)
            || (f.brand ?? '').toLowerCase().includes(q));
          out.replaceChildren(...hits.slice(0, 40).map((f) =>
            el('li', {},
              el('button', { class: 'pick-row', type: 'button',
                onclick: () => { closePick(); onPick(f); } },
                el('span', { class: 'list-title' }, f.name),
                el('span', { class: 'list-sub' },
                  `${r0(f.kcal)} kcal per ${f.servingQty} ${f.servingUnit}`)))));
          if (!hits.length) {
            out.append(el('li', { class: 'pad' },
              btn(`Create "${search.value.trim()}"`, () => {
                closePick();
                foodFormSheet(null, null, (food) => onPick(food),
                  { presetName: search.value.trim() });
              }, 'primary block')));
          }
        };
        search.addEventListener('input', draw);
        draw();
        return [search, out];
      });
    };

    return [
      field('Meal name', name),
      field('Note', notes),
      el('div', { class: 'stack' },
        el('span', { class: 'field-label' }, 'Ingredients'),
        list,
        btn('Add ingredient',
          () => pickFood((f) => { items.push({ foodId: f.id, food: f, servings: 1 }); redraw(); }),
          'block small'),
        totalsLine),
      existing
        ? el('div', { class: 'stack' },
            btn('Save as a variant', () => {
              close();
              variantSheet(existing, refresh);
            }, 'block small'),
            el('span', { class: 'field-hint' },
              'Copies this recipe so you can swap a component. The bowl with fideo instead of '
              + 'rice is a variant, not a new meal, and it lists under this one.'))
        : null,
      el('div', { class: 'sheet-actions' },
        existing
          ? btn('Delete', () => {
              close();
              confirmSheet('Delete meal?',
                'Days you already logged keep their entries and their numbers. Only the recipe goes. '
                + 'Any variants stay, as meals of their own.',
                async () => { await deleteMeal(mealId); refresh(); }, 'Delete meal');
            }, 'danger')
          : btn('Cancel', close),
        btn('Save', async () => {
          if (!name.value.trim()) return toast('Name it');
          if (!items.length) return toast('Add at least one ingredient');
          await saveMeal({
            id: mealId ?? undefined,
            name: name.value.trim(),
            notes: notes.value.trim(),
            items: items.map((i) => ({ foodId: i.foodId, servings: i.servings })),
          });
          close(); toast('Meal saved'); refresh();
        }, 'primary')),
    ];
  });
}

// ---------------------------------------------------------------------------
// Single foods: still here, now the secondary path
// ---------------------------------------------------------------------------

function searchSheet(refresh) {
  sheet('Log a food', (close) => {
    const search = textInput({ placeholder: 'Name or brand', class: 'search' });
    const list = el('ul', { class: 'list' });
    const draw = async () => {
      const q = search.value.trim().toLowerCase();
      const all = await foodLibrary({ includeQuickAdds: true });
      const hits = all.filter((f) => !q || f.name.toLowerCase().includes(q)
        || (f.brand ?? '').toLowerCase().includes(q));
      list.replaceChildren(...hits.slice(0, 40).map((f) =>
        el('li', {},
          el('button', { class: 'pick-row', type: 'button',
            onclick: () => { close(); logSheet(f, refresh); } },
            el('span', { class: 'list-title' }, f.name),
            el('span', { class: 'list-sub' },
              `${r0(f.kcal)} kcal per ${f.servingQty} ${f.servingUnit}`)))));
      list.append(el('li', { class: 'pad' },
        btn('New food', () => { close(); foodFormSheet(null, refresh); }, 'block small')));
    };
    search.addEventListener('input', draw);
    draw();
    return [search, list];
  });
}

function logSheet(food, refresh) {
  sheet(food.name, (close) => {
    const servings = numInput({ value: '1', class: 'big-in' });
    let meal = guessSlot();
    const seg = el('div', {});
    const drawSeg = () => seg.replaceChildren(
      segmented(MEALS, meal, (v) => { meal = meal === v ? null : v; drawSeg(); }));
    drawSeg();

    const preview = el('div', { class: 'muted small' });
    const update = () => {
      const n = parseFloat(servings.value) || 0;
      preview.textContent = `${r0(food.kcal * n)} kcal · ${r1(food.protein * n)}P `
        + `${r1(food.carbs * n)}C ${r1(food.fat * n)}F`;
    };
    servings.addEventListener('input', update);
    update();

    return [
      field(`Servings (${food.servingQty} ${food.servingUnit} each)`, servings),
      preview,
      el('div', { class: 'stack' }, seg),
      el('div', { class: 'sheet-actions' },
        btn('Cancel', close),
        btn('Log it', async () => {
          const n = parseFloat(servings.value);
          if (!Number.isFinite(n) || n <= 0) return toast('How many servings?');
          await logFood({ food, servings: n, mealSlot: meal, at: dayDate() });
          close(); toast('Logged'); refresh();
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

export function foodFormSheet(existing, refresh, onSaved, { presetName = '' } = {}) {
  sheet(existing ? 'Edit food' : 'New food', (close) => {
    const f = existing ?? {};
    const name = textInput({ value: f.name ?? presetName, placeholder: 'Ground Beef 96/4 (raw)' });
    const brand = textInput({ value: f.brand ?? '', placeholder: 'Brand (optional)' });
    const qty = numInput({ value: f.servingQty ?? 1 });
    const unit = textInput({ value: f.servingUnit ?? 'serving', placeholder: 'oz, cup, slice' });
    const grams = numInput({ value: f.servingGrams ?? '', placeholder: 'optional' });
    const kcal = numInput({ value: f.kcal ?? '' });
    const protein = numInput({ value: f.protein ?? '' });
    const carbs = numInput({ value: f.carbs ?? '' });
    const fat = numInput({ value: f.fat ?? '' });

    return [
      el('p', { class: 'muted small' },
        'Enter the numbers exactly as printed on the label, per serving. Storing what the box '
        + 'says keeps your data checkable against the box.'),
      field('Name', name),
      field('Brand', brand),
      el('div', { class: 'grid-2' }, field('Serving size', qty), field('Unit', unit)),
      field('Grams per serving', grams, 'Optional. Lets the app convert "1 slice" to grams later.'),
      el('div', { class: 'grid-2' }, field('Calories', kcal), field('Protein (g)', protein)),
      el('div', { class: 'grid-2' }, field('Carbs (g)', carbs), field('Fat (g)', fat)),
      el('div', { class: 'sheet-actions' },
        btn('Cancel', close),
        btn('Save', async () => {
          const num = (i, d = 0) => { const v = parseFloat(i.value); return Number.isFinite(v) ? v : d; };
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
          if (onSaved) onSaved(record); else refresh?.();
        }, 'primary')),
    ];
  });
}

/** One-off food: logged with real numbers, kept out of the searchable library
 *  so it does not clutter the things you actually eat. */
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
        'For something you ate once. Logged with real numbers but kept out of your meal list.'),
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
          await logFood({ food, servings: 1, mealSlot: guessSlot(), at: dayDate() });
          close(); toast('Logged'); refresh();
        }, 'primary')),
    ];
  });
}

// Scanning still has an obvious home here. It is not a new entity and not a new
// relationship: it is a faster way to fill in the food form above, which is why
// `barcode` and `source` already exist on Food.
export async function lookupBarcode(code) {
  const mine = await findFoodByBarcode(code);
  return mine ? { food: mine, from: 'library' } : { food: null, from: 'none' };
}

/** Name the copy, then open it for editing. The swap is one tap from there:
 *  tap the ingredient you want to change. */
function variantSheet(base, refresh) {
  sheet('Save as a variant', (close) => {
    const name = textInput({
      value: `${base.name} (variant)`,
      placeholder: 'Dinner Bowl with fideo',
    });
    return [
      el('p', { class: 'muted small' },
        `Copies every ingredient from "${base.name}". Open the copy and tap any ingredient `
        + 'to swap it for something else, keeping the amount.'),
      field('Name', name),
      el('div', { class: 'sheet-actions' },
        btn('Cancel', close),
        btn('Create', async () => {
          const n = name.value.trim();
          if (!n) return toast('Name it');
          const id = await duplicateMeal(base.id, n);
          close();
          toast('Variant created');
          refresh();
          mealBuilder(id, refresh);
        }, 'primary')),
    ];
  });
}
