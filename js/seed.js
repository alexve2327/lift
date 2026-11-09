// seed.js — the meal prep recipes, preloaded.
//
// Per-serving macros are DERIVED from the per-bowl table in the recipe doc, not
// retyped from a label. The derivation is just division: the doc says 6.5 oz of
// 96/4 beef is 195 kcal and 39 g protein, so one ounce is 30 kcal and 6 g.
//
// Every meal below has been checked to reconcile to the totals the doc states
// (732 / 64 / 92 / 14.2 for the dinner bowl, and so on) and the four of them sum
// to the stated 2,386 kcal and 189 g protein day. If you edit an ingredient,
// that reconciliation is what you are changing.
//
// Units are chosen so the number you type matches the number you measure: beef
// in ounces, rice in eighth-cups (because 3/8 cup is what one bowl takes),
// bread in slices. A serving you cannot measure is a serving you will guess.

import { db } from './db.js';
import { uuid } from './util.js';

const FOODS = [
  // name,                            brand,        qty, unit,         kcal,     protein, carbs,   fat
  ['Ground Beef 96/4 (raw)',          null,           1, 'oz',         30,       6,       0,       1],
  ['Basmati Rice (dry)',              null,           1, '1/8 cup',    80,       1.67,    17.67,   0],
  ['Sweet Potato (raw)',              null,           1, 'oz',         24.33,    0.5,     5.67,    0],
  ['Avocado Oil',                     null,           1, 'tsp',        40,       0,       0,       4.56],
  ['Beef Broth (unsalted)',           null,           1, 'cup',        9.6,      1.6,     0,       0],
  ['Chobani Plain Greek Yogurt',      'Chobani',      1, '1/2 cup',    95,       16,      5,       2],
  ['Whole Grain Bread',               null,           1, 'slice',      100,      4,       18,      1.5],
  ['Egg (fried)',                     null,           1, 'large egg',  70,       6,       0.5,     5],
  ['Sesame Oil',                      null,           1, 'tsp',        40,       0,       0,       4.5],
  ['Ultra Thin Roast Beef',           'Hillshire',    1, 'slice',      10,       1.75,    0.25,    0.25],
  ['Colby Jack',                      'Sargento',     1, 'slice',      70,       4.33,    0.33,    6],
  ['Avocado',                         null,           1, 'whole',      240,      3,       13,      22],
  ['Chobani 20g Protein Yogurt',      'Chobani',      1, 'cup',        130,      20,      7,       3],
  ['Premier Protein Powder',          'Premier',      1, 'scoop',      160,      30,      4,       3],
  ['2% Milk',                         null,           1, 'cup',        122,      8,       11.67,   4.8],
  ['Fruit (banana, pear or peach)',   null,           1, 'piece',      88,       1.2,     22,      0.3],
];

const RECIPES = [
  ['Dinner Bowl (Arabic Beef)',
    'Slow cooker beef, Arabic rice, roasted sweet potato, tzatziki. 732 kcal, 64 g protein.', [
    ['Ground Beef 96/4 (raw)', 6.5],
    ['Basmati Rice (dry)', 3],
    ['Sweet Potato (raw)', 6],
    ['Avocado Oil', 1.25],
    ['Beef Broth (unsalted)', 0.625],
    ['Chobani Plain Greek Yogurt', 1],
  ]],
  ['Lunch Sandwich',
    'Roast beef, colby jack, fried eggs, avocado on whole grain. 910 kcal, 50 g protein.', [
    ['Whole Grain Bread', 2],
    ['Egg (fried)', 2],
    ['Sesame Oil', 1],
    ['Ultra Thin Roast Beef', 8],
    ['Colby Jack', 3],
    ['Avocado', 1],
  ]],
  ['Breakfast Yogurt',
    'One Chobani protein cup. 130 kcal, 20 g protein.', [
    ['Chobani 20g Protein Yogurt', 1],
  ]],
  ['Pre-Gym Shake',
    'Protein powder, 2% milk, one piece of fruit. 614 kcal, 55 g protein.', [
    ['Premier Protein Powder', 1],
    ['2% Milk', 3],
    ['Fruit (banana, pear or peach)', 1],
  ]],
];

/** Idempotent: matches on name, so running it twice does not duplicate
 *  anything, and it will not clobber a food you have since edited. */
export async function seedMealPrep() {
  const existingFoods = await db.foods.toArray();
  const byName = new Map(existingFoods.map((f) => [f.name.toLowerCase(), f]));

  const foodIds = new Map();
  const newFoods = [];
  for (const [name, brand, qty, unit, kcal, protein, carbs, fat] of FOODS) {
    const hit = byName.get(name.toLowerCase());
    if (hit) { foodIds.set(name, hit.id); continue; }
    const id = uuid();
    foodIds.set(name, id);
    newFoods.push({
      id, name, brand, barcode: undefined,
      servingQty: qty, servingUnit: unit, servingGrams: null,
      kcal, protein, carbs, fat,
      fiber: null, sugar: null, sodium: null,
      source: 'manual', useCount: 0, isQuickAdd: false, isArchived: false,
    });
  }
  if (newFoods.length) await db.foods.bulkAdd(newFoods);

  const existingMeals = await db.meals.toArray();
  const mealNames = new Set(existingMeals.map((m) => m.name.toLowerCase()));

  for (const [name, notes, items] of RECIPES) {
    if (mealNames.has(name.toLowerCase())) continue;
    const mealId = uuid();
    await db.meals.add({
      id: mealId, name, notes, useCount: 0, isArchived: false, createdAt: new Date(),
    });
    await db.mealItems.bulkAdd(items.map(([foodName, servings], n) => ({
      id: uuid(), mealId, foodId: foodIds.get(foodName), servings, orderIndex: n,
    })));
  }

  return { foods: newFoods.length, meals: RECIPES.length };
}
