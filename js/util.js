// util.js — small pure helpers. No DOM, no database. Everything here is
// testable in isolation, which is why the date logic lives here and not
// scattered through the views.

/** UUID primary keys, not auto-incrementing integers. Auto-increment is simpler
 *  until you restore a backup or add a second device, at which point every id
 *  collides. crypto.randomUUID() is built in and costs nothing today. */
export const uuid = () => crypto.randomUUID();

/** Local-date day key, e.g. "2026-08-25".
 *
 *  Do NOT use date.toISOString().slice(0,10). toISOString converts to UTC, so
 *  a meal logged at 8pm in Indiana lands on TOMORROW's key and the day's totals
 *  silently split in two. The bug only fires in the evening, which is why it
 *  survives weeks of testing. */
export function toDayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Parse a day key back to a local Date at midnight.
 *  new Date("2026-08-25") parses as UTC midnight; this does not. */
export function fromDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function shiftDayKey(key, days) {
  const d = fromDayKey(key);
  d.setDate(d.getDate() + days);
  return toDayKey(d);
}

/** Age computed on demand, never stored. A stored age is a field that silently
 *  becomes wrong once a year. */
export function ageFrom(birthDate, now = new Date()) {
  if (!birthDate) return null;
  const b = fromDayKey(birthDate);
  let age = now.getFullYear() - b.getFullYear();
  const before =
    now.getMonth() < b.getMonth() ||
    (now.getMonth() === b.getMonth() && now.getDate() < b.getDate());
  return before ? age - 1 : age;
}

/** Mifflin-St Jeor, imperial form. Returns resting metabolic rate in kcal/day.
 *  This is a population regression with real scatter on any individual, so it
 *  is a starting point to calibrate against your own logged data, not a number
 *  to obey. Returns null when inputs are missing rather than guessing. */
export function bmr({ weightLb, heightInches, age, sex }) {
  if (!weightLb || !heightInches || age == null || !sex) return null;
  const s = sex === 'male' ? 5 : -161;
  return 4.536 * weightLb + 15.88 * heightInches - 5 * age + s;
}

export function fmtDayLabel(key) {
  const today = toDayKey();
  if (key === today) return 'Today';
  if (key === shiftDayKey(today, -1)) return 'Yesterday';
  return fromDayKey(key).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

export function fmtClock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtDuration(ms) {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`;
  if (totalMin < 60) return `${totalMin} min`;
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

/** Round for display only. Never round before storing. */
export const r0 = (n) => Math.round(n);
export const r1 = (n) => Math.round(n * 10) / 10;

/** Estimated one-rep max, Epley formula. Used for progress charts.
 *  Meaningless above about 12 reps, so we cap it rather than print nonsense. */
export function e1rm(weight, reps) {
  if (!weight || !reps || reps > 12) return null;
  return weight * (1 + reps / 30);
}
