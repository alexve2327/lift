// views/settings.js — the profile inputs, the backup, and the honest warnings.

import {
  db, getSettings, saveSettings, exportBackup, importBackup, dayTotals,
} from '../db.js';
import {
  el, screen, card, btn, field, numInput, textInput, segmented, toast,
  sheet, confirmSheet, stat,
} from '../ui.js';
import { uuid, toDayKey, ageFrom, bmr, r0, r1 } from '../util.js';

export async function render(refresh) {
  const s = await getSettings();
  const weights = await db.bodyweightEntries.toArray();
  weights.sort((a, b) => a.dayKey.localeCompare(b.dayKey));
  const latest = weights[weights.length - 1] ?? null;

  const age = ageFrom(s.birthDate);
  const rmr = bmr({
    weightLb: latest?.weight, heightInches: s.heightInches, age, sex: s.sex,
  });
  const tdee = rmr && s.activityFactor ? rmr * s.activityFactor : null;

  const setsCount = await db.setEntries.count();
  const foodCount = await db.foodEntries.count();

  return screen('Settings', null,

    card(
      el('h2', { class: 'card-title' }, 'Bodyweight'),
      el('div', { class: 'stat-row' },
        stat(latest ? `${r1(latest.weight)}` : '—', 'lb'),
        stat(latest ? latest.dayKey : 'no entries', 'last weigh-in')),
      btn('Log weight', () => weightSheet(refresh), 'primary block')),

    card(
      el('h2', { class: 'card-title' }, 'Profile'),
      el('p', { class: 'muted small' },
        'These feed the calorie estimate below. Nothing else in the app reads them, '
        + 'so leave them blank if you would rather not.'),
      profileForm(s, refresh)),

    // The estimate is shown, not enforced. You said no targets, so there is no
    // goal to hit and no ring to close: this is a reference number.
    card(
      el('h2', { class: 'card-title' }, 'Calorie estimate'),
      rmr
        ? el('div', {},
            el('div', { class: 'stat-row' },
              stat(r0(rmr).toLocaleString(), 'kcal at rest'),
              tdee ? stat(r0(tdee).toLocaleString(), 'kcal maintenance') : null),
            el('p', { class: 'muted small' },
              'Mifflin-St Jeor. This is a population regression with real scatter on any '
              + 'individual, so treat it as a starting point to calibrate against your own '
              + 'logged intake and weight trend, not a number to obey.'))
        : el('p', { class: 'muted' },
            'Log a bodyweight and fill in height, birth date, and sex to see an estimate.')),

    card(
      el('h2', { class: 'card-title' }, 'Rest timer'),
      restForm(s, refresh)),

    // Build the backup on day one, not day ninety. Safari's storage guarantees
    // are heuristic, and a year of logs in exactly one place on one phone is
    // not a plan.
    card(
      el('h2', { class: 'card-title' }, 'Backup'),
      el('div', { class: 'stat-row' },
        stat(String(setsCount), 'sets logged'),
        stat(String(foodCount), 'food entries')),
      el('p', { class: 'muted small' },
        'Everything lives in this phone\'s browser storage. iOS usually keeps data for an '
        + 'installed Home Screen app, but "usually" is not a guarantee. Export now and then, '
        + 'and save the file to Files or iCloud Drive.'),
      btn('Export backup', downloadBackup, 'primary block'),
      btn('Restore from backup', () => restoreSheet(refresh), 'block')),

    el('p', { class: 'muted small pad' },
      'Lift & Intake · local-first · no account, no server, no analytics'));
}

function profileForm(s, refresh) {
  const height = numInput({ value: s.heightInches ?? '', placeholder: 'inches' });
  const birth = el('input', { type: 'date', value: s.birthDate ?? '' });
  let sex = s.sex;
  const seg = el('div', {});
  const draw = () => seg.replaceChildren(segmented(
    [{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }],
    sex, (v) => { sex = sex === v ? null : v; draw(); }));
  draw();

  let activity = s.activityFactor;
  const actSeg = el('div', {});
  const drawAct = () => actSeg.replaceChildren(segmented([
    { value: 1.2, label: 'Sedentary' },
    { value: 1.375, label: 'Light' },
    { value: 1.55, label: 'Moderate' },
    { value: 1.725, label: 'Heavy' },
  ], activity, (v) => { activity = activity === v ? null : v; drawAct(); }));
  drawAct();

  return el('div', { class: 'stack' },
    field('Height', height, 'Changes roughly never, so it lives here rather than on every weigh-in.'),
    field('Birth date', birth, 'Stored as a date. Age is computed on demand, because a stored age silently goes wrong once a year.'),
    el('div', { class: 'stack' }, el('span', { class: 'field-label' }, 'Sex'), seg,
      el('span', { class: 'field-hint' }, 'Only an input to the BMR equation.')),
    el('div', { class: 'stack' }, el('span', { class: 'field-label' }, 'Activity'), actSeg,
      el('span', { class: 'field-hint' }, 'The crude part of the estimate. Worth calibrating against your own data later.')),
    btn('Save profile', async () => {
      await saveSettings({
        heightInches: height.value === '' ? null : parseFloat(height.value),
        birthDate: birth.value || null,
        sex, activityFactor: activity,
      });
      toast('Saved');
      refresh();
    }, 'primary block'));
}

function restForm(s, refresh) {
  const rest = numInput({ value: s.defaultRestSec });
  return el('div', { class: 'stack' },
    field('Default rest (seconds)', rest,
      'Used when a program exercise does not set its own. Per-exercise rest is set in the program builder.'),
    btn('Save', async () => {
      const v = parseInt(rest.value, 10);
      await saveSettings({ defaultRestSec: Number.isFinite(v) ? v : 120 });
      toast('Saved');
      refresh();
    }, 'block'));
}

function weightSheet(refresh) {
  sheet('Log bodyweight', (close) => {
    const w = numInput({ placeholder: 'lb', class: 'big-in' });
    const day = el('input', { type: 'date', value: toDayKey() });
    return [
      field('Weight (lb)', w),
      field('Date', day, 'One entry per day. Logging the same day again replaces it.'),
      el('div', { class: 'sheet-actions' },
        btn('Cancel', close),
        btn('Save', async () => {
          const v = parseFloat(w.value);
          if (!Number.isFinite(v)) return toast('Enter a weight');
          const key = day.value || toDayKey();
          const existing = await db.bodyweightEntries.where('dayKey').equals(key).first();
          if (existing) {
            await db.bodyweightEntries.update(existing.id, { weight: v, loggedAt: new Date() });
          } else {
            await db.bodyweightEntries.add({ id: uuid(), dayKey: key, weight: v, loggedAt: new Date() });
          }
          close(); toast('Logged'); refresh();
        }, 'primary')),
    ];
  });
}

async function downloadBackup() {
  const blob = await exportBackup();
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: `lift-backup-${toDayKey()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Backup exported');
}

function restoreSheet(refresh) {
  sheet('Restore from backup', (close) => {
    const input = el('input', { type: 'file', accept: 'application/json,.json' });
    return [
      el('p', { class: 'muted small' },
        'This replaces everything currently in the app with the contents of the file. '
        + 'Export a fresh backup first if you are not sure.'),
      field('Backup file', input),
      el('div', { class: 'sheet-actions' },
        btn('Cancel', close),
        btn('Restore', () => {
          const file = input.files?.[0];
          if (!file) return toast('Pick a file');
          close();
          confirmSheet('Replace all data?', 'Everything currently stored will be overwritten.', async () => {
            try {
              await importBackup(await file.text());
              toast('Restored');
              refresh();
            } catch (err) {
              toast('Could not read that file');
              console.error(err);
            }
          });
        }, 'danger')),
    ];
  });
}
