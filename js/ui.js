// ui.js — the entire rendering layer. This is what React would have given you,
// in about ninety lines, minus the build step.
//
// The model is deliberately dumb: a view builds a DOM tree from data and
// returns it, and any change re-runs the whole view. For a logging app whose
// biggest screen is maybe forty rows, "re-render everything" is faster than
// the machinery required to avoid it, and it removes an entire category of
// stale-UI bug. Optimise when you can measure a problem, not before.

/** Hyperscript. el('div', {class:'x'}, 'text', el('b', {}, 'bold'))
 *  Props starting with 'on' become event listeners. Everything else becomes
 *  an attribute, except style/dataset/value which need special handling. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign(node.style, v);
    } else if (k === 'dataset') {
      Object.assign(node.dataset, v);
    } else if (k === 'value' || k === 'checked' || k === 'disabled') {
      node[k] = v;
    } else if (k === 'html') {
      node.innerHTML = v;
    } else {
      node.setAttribute(k, v === true ? '' : v);
    }
  }
  add(node, children);
  return node;
}

function add(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const clear = (node) => { while (node.firstChild) node.firstChild.remove(); };

/** Screen scaffolding used by every view. */
export const screen = (title, actions, ...body) =>
  el('div', { class: 'screen' },
    el('header', { class: 'screen-head' },
      el('h1', {}, title),
      actions ? el('div', { class: 'head-actions' }, actions) : null),
    ...body);

export const card = (...children) => el('section', { class: 'card' }, ...children);

export const row = (...children) => el('div', { class: 'row' }, ...children);

export const btn = (label, onclick, kind = '') =>
  el('button', { class: `btn ${kind}`.trim(), type: 'button', onclick }, label);

export const empty = (text, actionLabel, onAction) =>
  el('div', { class: 'empty' },
    el('p', {}, text),
    actionLabel ? btn(actionLabel, onAction, 'primary') : null);

export function field(label, input, hint) {
  return el('label', { class: 'field' },
    el('span', { class: 'field-label' }, label),
    input,
    hint ? el('span', { class: 'field-hint' }, hint) : null);
}

/** Numeric input tuned for phones. inputmode='decimal' brings up the number
 *  pad without the strict validation of type=number, which on iOS rejects
 *  a partially typed value and makes the field feel broken mid-entry. */
export const numInput = (props = {}) =>
  el('input', {
    type: 'text', inputmode: 'decimal', autocomplete: 'off',
    autocorrect: 'off', spellcheck: 'false', ...props,
  });

export const textInput = (props = {}) =>
  el('input', { type: 'text', autocomplete: 'off', ...props });

/** Modal sheet. Returns a close function. Slides up from the bottom because
 *  that is where a thumb is. */
export function sheet(title, buildBody) {
  const backdrop = el('div', { class: 'backdrop' });
  const close = () => { backdrop.remove(); document.body.classList.remove('locked'); };
  const panel = el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
    el('div', { class: 'sheet-head' },
      el('h2', {}, title),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, '×')),
    el('div', { class: 'sheet-body' }, buildBody(close)));
  backdrop.append(panel);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.body.append(backdrop);
  document.body.classList.add('locked');
  // Focus the first field so the keyboard opens without a second tap.
  requestAnimationFrame(() => panel.querySelector('input, select, textarea')?.focus());
  return close;
}

export function confirmSheet(title, message, onConfirm) {
  sheet(title, (close) => [
    el('p', { class: 'muted' }, message),
    el('div', { class: 'sheet-actions' },
      btn('Cancel', close),
      btn('Delete', () => { close(); onConfirm(); }, 'danger')),
  ]);
}

let toastTimer;
export function toast(message) {
  document.querySelector('.toast')?.remove();
  const t = el('div', { class: 'toast', role: 'status' }, message);
  document.body.append(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2200);
}

/** Segmented control. Used for meal slots and program day pickers. */
export function segmented(options, value, onChange) {
  return el('div', { class: 'segmented', role: 'tablist' },
    options.map(o =>
      el('button', {
        type: 'button', role: 'tab',
        class: 'seg' + (o.value === value ? ' on' : ''),
        'aria-selected': o.value === value ? 'true' : 'false',
        onclick: () => onChange(o.value),
      }, o.label)));
}

export const stat = (value, label, tone = '') =>
  el('div', { class: `stat ${tone}`.trim() },
    el('div', { class: 'stat-value' }, value),
    el('div', { class: 'stat-label' }, label));
