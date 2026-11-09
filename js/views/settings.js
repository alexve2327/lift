// views/settings.js — the profile inputs, the backup, and the honest warnings.

import {
  db, getSettings, saveSettings, exportBackup, importBackup, dayTotals,
  bodyweightSeries, logBodyweight,
} from '../db.js';
import {
  el, screen, card, btn, field, numInput, textInput, segmented, toast,
  sheet, confirmSheet, stat,
} from '../ui.js';
import { toDayKey, fromDayKey, ageFrom, bmr, r0, r1 } from '../util.js';
import { lineChart, trend } from '../chart.js';

export async function render(refresh) {
  const s = await getSettings();
  const weights = await bodyweightSeries();
  const latest = weights[weights.length - 1] ?? null;

  const age = ageFrom(s.birthDate);
  const rmr = bmr({
    weightLb: latest?.weight, heightInches: s.heightInches, age, sex: s.sex,
  });
  const tdee = rmr && s.activityFactor ? rmr * s.activityFactor : null;

  const setsCount = await db.setEntries.count();
  const foodCount = await db.foodEntries.count();

  return screen('Settings', null,

    bodyweightCard(weights, latest, refresh),

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
          }, 'Replace everything');
        }, 'danger')),
    ];
  });
}

// ---------------------------------------------------------------------------
// Bodyweight: one field, one button, and a chart
// ---------------------------------------------------------------------------
// The old version hid logging behind a sheet with two fields, which for a
// number you type once a morning is three taps too many. The input is now on
// the card itself and defaults to today.

function bodyweightCard(weights, latest, refresh) {
  const input = numInput({
    placeholder: latest ? r1(latest.weight) : 'lb',
    class: 'big-in', 'aria-label': 'Bodyweight in pounds',
  });

  const save = async () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v) || v <= 0) return toast('Enter a weight');
    await logBodyweight(v);
    toast(weights.some((w) => w.dayKey === toDayKey()) ? "Today's weight updated" : 'Logged');
    refresh();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });

  const pts = weights.map((w) => ({ x: fromDayKey(w.dayKey), y: w.weight, dayKey: w.dayKey }));
  const tr = trend(pts);

  // 7-day moving average smooths out the day-to-day water noise that makes a
  // raw bodyweight line almost unreadable over a few weeks.
  const smooth = pts.map((p, i) => {
    const win = pts.slice(Math.max(0, i - 6), i + 1);
    return win.reduce((a, q) => a + q.y, 0) / win.length;
  });

  const change = pts.length > 1 ? pts[pts.length - 1].y - pts[0].y : null;

  return card(
    el('h2', { class: 'card-title' }, 'Bodyweight'),
    el('div', { class: 'stat-row' },
      stat(latest ? r1(latest.weight) : '—', 'lb'),
      stat(change === null ? '—' : (change >= 0 ? '+' : '') + r1(change), 'lb total'),
      stat(tr ? (tr.perWeek >= 0 ? '+' : '') + r1(tr.perWeek) : '—', 'lb/week')),
    el('div', { class: 'quick-row' },
      input,
      btn('Log today', save, 'primary')),
    pts.length >= 2
      ? el('div', { class: 'stack' },
          lineChart({
            points: pts.map((p, i) => ({
              x: p.x, y: p.y,
              label: `${p.dayKey} · ${r1(p.y)} lb` + (i >= 6 ? ` · 7-day avg ${r1(smooth[i])}` : ''),
            })),
            height: 200,
            yLabel: 'lb',
            rules: tr ? [{ y: tr.at(+pts[pts.length - 1].x), label: 'trend' }] : [],
          }),
          tr
            ? el('p', { class: 'trend-note' },
                'Trend: ', el('b', {}, `${tr.perWeek >= 0 ? '+' : ''}${r1(tr.perWeek)} lb/week`),
                ` over ${pts.length} weigh-ins. A single day means nothing here; the slope is the signal.`)
            : null)
      : el('p', { class: 'muted small' },
          'Log a few more days and a trend chart appears here. Weight swings a couple of pounds '
          + 'on water alone, so single readings are noise.'));
}
