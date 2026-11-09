// exercise-form.js — the exercise editor, shared by the Library tab and the
// workout screen.
//
// It lives in its own module rather than in library.js because today.js now
// needs it too, and importing it from library.js would have made a cycle
// (library.js already imports the exercise picker from today.js). Circular ES
// module imports mostly work, right up until they don't.

import { db } from './db.js';
import {
  el, btn, sheet, confirmSheet, toast, field, textInput, numInput, segmented,
} from './ui.js';
import { uuid } from './util.js';

export const TRACKING = {
  weight_reps: 'weight × reps',
  bodyweight_reps: 'bodyweight reps',
  duration: 'time',
  distance: 'distance',
};

/**
 * @param existing  the exercise to edit, or null to create one
 * @param onDone    called after save/archive
 * @param opts.allowArchive  false inside a live workout: archiving a movement
 *                           you are mid-way through logging is never what you
 *                           meant, and the sets would be left pointing at a
 *                           hidden exercise.
 */
export function exerciseSheet(existing, onDone, { allowArchive = true } = {}) {
  sheet(existing ? 'Edit exercise' : 'New exercise', (close) => {
    const e = existing ?? {};
    const name = textInput({ value: e.name ?? '', placeholder: 'Barbell Back Squat' });
    const group = textInput({ value: e.muscleGroup ?? '', placeholder: 'Legs' });
    const equip = textInput({ value: e.equipment ?? '', placeholder: 'Barbell' });
    const notes = el('textarea', { rows: 2, placeholder: 'Setup cues, pin heights, seat position' },
      e.notes ?? '');

    let tracking = e.trackingType ?? 'weight_reps';
    const trackSeg = el('div', {});
    const drawTrack = () => trackSeg.replaceChildren(segmented(
      Object.entries(TRACKING).map(([value, label]) => ({ value, label })),
      tracking, (v) => { tracking = v; drawTrack(); }));
    drawTrack();

    // Unilateral: one arm or leg at a time. Turning it on makes the set form
    // ask which side, and the progress charts can then separate them, which is
    // the whole point — a left/right imbalance is invisible in a merged line.
    // Targets live here now, not in the program builder, because this is the
    // screen you can actually reach mid-workout. The rep range is also what
    // decides compound vs isolation: a range topping out at 10 is a compound.
    const tSets = numInput({ value: e.targetSets ?? 3 });
    const tLow  = numInput({ value: e.targetRepsLow ?? 8 });
    const tHigh = numInput({ value: e.targetRepsHigh ?? 12 });
    const tBump = numInput({ value: e.bumpAfterSets ?? 2 });

    const ruleLine = el('span', { class: 'field-hint' });
    const updateRule = () => {
      const hi = parseInt(tHigh.value, 10);
      const n = parseInt(tBump.value, 10);
      ruleLine.textContent = Number.isFinite(hi) && Number.isFinite(n)
        ? `Progress will say "ready to bump" once your first ${n} set${n === 1 ? '' : 's'} `
          + `at the working weight hit ${hi} reps.`
        : 'Set a rep range and a set count.';
    };
    for (const i of [tHigh, tBump]) i.addEventListener('input', updateRule);
    updateRule();

    const presets = el('div', { class: 'stack' },
      segmented([
        { value: 'compound', label: 'Compound 8-10' },
        { value: 'iso', label: 'Isolation 10-12' },
      ], (parseInt(tHigh.value, 10) === 10 ? 'compound'
         : parseInt(tHigh.value, 10) === 12 ? 'iso' : null),
      (v) => {
        tLow.value = v === 'compound' ? 8 : 10;
        tHigh.value = v === 'compound' ? 10 : 12;
        updateRule();
      }));

    let unilateral = !!e.isUnilateral;
    const uniBtn = el('button', {
      type: 'button', class: 'fail-btn wide' + (unilateral ? ' on' : ''),
      'aria-pressed': String(unilateral),
      onclick: () => {
        unilateral = !unilateral;
        uniBtn.classList.toggle('on', unilateral);
        uniBtn.setAttribute('aria-pressed', String(unilateral));
      },
    }, 'One side at a time');

    return [
      field('Name', name),
      el('div', { class: 'grid-2' }, field('Muscle group', group), field('Equipment', equip)),
      el('div', { class: 'stack' },
        el('span', { class: 'field-label' }, 'Tracked as'), trackSeg,
        el('span', { class: 'field-hint' },
          'Not everything is weight times reps. Planks and pull-ups need different fields.')),
      el('div', { class: 'stack' },
        el('span', { class: 'field-label' }, 'Unilateral'), uniBtn,
        el('span', { class: 'field-hint' },
          'For single-arm rows, split squats, one-leg curls. Each set records which side, '
          + 'and Progress can chart left and right separately.')),
      el('div', { class: 'stack' },
        el('span', { class: 'field-label' }, 'Targets'),
        presets,
        el('div', { class: 'grid-2' },
          field('Sets', tSets),
          field('Bump after', tBump, 'sets at the top')),
        el('div', { class: 'grid-2' },
          field('Reps from', tLow),
          field('Reps to', tHigh)),
        ruleLine),
      field('Notes', notes),
      el('div', { class: 'sheet-actions' },
        existing && allowArchive
          ? btn('Archive', () => {
              close();
              confirmSheet('Archive exercise?',
                'It disappears from pickers. Your past sets keep it, because deleting it outright would orphan them.',
                async () => { await db.exercises.update(existing.id, { isArchived: true }); onDone(); },
                'Archive');
            }, 'danger')
          : btn('Cancel', close),
        btn('Save', async () => {
          if (!name.value.trim()) return toast('Name it');
          const num = (i, d) => { const v = parseInt(i.value, 10); return Number.isFinite(v) ? v : d; };
          const low = num(tLow, 8);
          const high = Math.max(num(tHigh, 12), low);
          await db.exercises.put({
            ...e,
            id: e.id ?? uuid(),
            name: name.value.trim(),
            muscleGroup: group.value.trim(),
            equipment: equip.value.trim(),
            trackingType: tracking,
            isUnilateral: unilateral,
            targetSets: num(tSets, 3),
            targetRepsLow: low,
            targetRepsHigh: high,
            bumpAfterSets: Math.max(1, num(tBump, 2)),
            notes: notes.value,
            isArchived: false,
          });
          close();
          toast(existing ? 'Exercise updated' : 'Exercise saved');
          onDone();
        }, 'primary')),
    ];
  });
}
