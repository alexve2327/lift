// exercise-form.js — the exercise editor, shared by the Library tab and the
// workout screen.
//
// It lives in its own module rather than in library.js because today.js now
// needs it too, and importing it from library.js would have made a cycle
// (library.js already imports the exercise picker from today.js). Circular ES
// module imports mostly work, right up until they don't.

import { db } from './db.js';
import {
  el, btn, sheet, confirmSheet, toast, field, textInput, segmented,
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
          await db.exercises.put({
            id: e.id ?? uuid(),
            name: name.value.trim(),
            muscleGroup: group.value.trim(),
            equipment: equip.value.trim(),
            trackingType: tracking,
            isUnilateral: unilateral,
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
