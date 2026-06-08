// Tiny Kitchen — single-page recipe finder.
// Loads recipes.json, renders search + tag filter + recipe list.
// Vanilla JS, no framework. State lives in URL hash so reloads keep filters.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  recipes: [],
  ingredients: [],
  tags: [],
  query: '',
  activeTags: new Set(),
  dairyFreeOnly: true,
  openIds: new Set(),
};

const els = {
  search: $('#search'),
  dairyToggle: $('#dairyFreeOnly'),
  tagFilter: $('#tagFilter'),
  results: $('#results'),
  empty: $('#empty'),
  stats: $('#stats'),
};

// --- Load data -----------------------------------------------------------

async function load() {
  try {
    const res = await fetch('data/recipes.json', { cache: 'no-cache' });
    const data = await res.json();
    state.recipes = data.recipes;
    state.ingredients = data.ingredients;
    state.tags = data.tags;
    els.stats.textContent = `${data.recipeCount} recipes · ${data.ingredientCount} ingredients · updated ${new Date(data.generated).toLocaleDateString()}`;
    renderTagChips();
    restoreFromHash();
    render();
  } catch (err) {
    els.results.innerHTML = `<div class="empty">Couldn't load recipes. Try refreshing.<br><small>${err.message}</small></div>`;
  }
}

// --- Tag chips -----------------------------------------------------------

// Sort tags by frequency (most-used first), then alpha.
function sortedTags() {
  const counts = new Map();
  for (const r of state.recipes) {
    for (const t of r.tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return state.tags
    .slice()
    .sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || a.localeCompare(b));
}

function renderTagChips() {
  els.tagFilter.innerHTML = '';
  for (const tag of sortedTags()) {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.classList.toggle('active', state.activeTags.has(tag));
    if (tag === 'contains-dairy') btn.classList.add('contains-dairy');
    btn.textContent = tag;
    btn.addEventListener('click', () => {
      if (state.activeTags.has(tag)) state.activeTags.delete(tag);
      else state.activeTags.add(tag);
      btn.classList.toggle('active');
      syncHash();
      render();
    });
    els.tagFilter.appendChild(btn);
  }
}

// --- Filtering -----------------------------------------------------------

function filterRecipes() {
  const q = state.query.trim().toLowerCase();
  return state.recipes.filter((r) => {
    // Dairy-free only: hide recipes tagged contains-dairy
    if (state.dairyFreeOnly && r.tags.includes('contains-dairy')) return false;

    // Tag filter: recipe must have ALL active tags
    for (const t of state.activeTags) if (!r.tags.includes(t)) return false;

    // Search query: match against name, primary ingredient, secondary ingredients, raw ingredients string
    if (q) {
      const hay = [
        r.name,
        r.primaryIngredient || '',
        (r.secondaryIngredients || []).join(' '),
        r.ingredients || '',
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// --- Rendering -----------------------------------------------------------

function highlight(text, q) {
  if (!q) return escapeHtml(text);
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q.toLowerCase());
  if (idx < 0) return escapeHtml(text);
  return (
    escapeHtml(text.slice(0, idx)) +
    '<mark>' +
    escapeHtml(text.slice(idx, idx + q.length)) +
    '</mark>' +
    escapeHtml(text.slice(idx + q.length))
  );
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function recipeCard(r) {
  const q = state.query.trim();
  const isOpen = state.openIds.has(r.id);
  const tagSpans = r.tags
    .map((t) => `<span class="recipe-tag${t === 'contains-dairy' ? ' contains-dairy' : ''}">${escapeHtml(t)}</span>`)
    .join('');

  const ingredientChain = [r.primaryIngredient, ...(r.secondaryIngredients || [])]
    .filter(Boolean)
    .join(', ');

  const details = isOpen
    ? `
    <div class="recipe-details">
      <dl>
        ${r.ingredients ? `<dt>ingredients</dt><dd>${escapeHtml(r.ingredients)}</dd>` : ''}
        ${r.method ? `<dt>method</dt><dd>${escapeHtml(r.method)}</dd>` : ''}
        ${r.makes ? `<dt>makes</dt><dd>${escapeHtml(r.makes)}</dd>` : ''}
        ${r.age ? `<dt>age</dt><dd>${escapeHtml(r.age)}</dd>` : ''}
        ${r.storage ? `<dt>storage</dt><dd>${escapeHtml(r.storage)}</dd>` : ''}
        ${r.spiceItUp ? `<dt>spice it up</dt><dd>${escapeHtml(r.spiceItUp)}</dd>` : ''}
        ${r.serveWith ? `<dt>serve with</dt><dd>${escapeHtml(r.serveWith)}</dd>` : ''}
        ${r.familyTip ? `<dt>family tip</dt><dd>${escapeHtml(r.familyTip)}</dd>` : ''}
        ${r.notes ? `<dt>notes</dt><dd>${escapeHtml(r.notes)}</dd>` : ''}
        ${r.source ? `<dt>source</dt><dd>${escapeHtml(r.source)}</dd>` : ''}
      </dl>
      ${
        r.extras && r.extras.length
          ? `<div class="ingredient-links"><span>also:</span> ${r.extras.map(escapeHtml).join('<br>')}</div>`
          : ''
      }
    </div>
  `
    : '';

  return `
    <article class="recipe${isOpen ? ' open' : ''}" data-id="${r.id}">
      <button class="recipe-header" type="button" aria-expanded="${isOpen}">
        <div class="recipe-title">
          <span>${highlight(r.name, q)}</span>
          <span class="caret">›</span>
        </div>
        <div class="recipe-meta">${highlight(ingredientChain, q)}</div>
        <div class="recipe-tags">${tagSpans}</div>
      </button>
      ${details}
    </article>
  `;
}

function render() {
  const filtered = filterRecipes();
  if (filtered.length === 0) {
    els.results.innerHTML = '';
    els.empty.hidden = false;
  } else {
    els.empty.hidden = true;
    els.results.innerHTML = filtered.map(recipeCard).join('');
    // Wire up header clicks
    $$('.recipe-header').forEach((btn) => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.recipe');
        const id = card.dataset.id;
        if (state.openIds.has(id)) state.openIds.delete(id);
        else state.openIds.add(id);
        render();
      });
    });
  }
}

// --- URL hash sync -------------------------------------------------------

function syncHash() {
  const params = new URLSearchParams();
  if (state.query) params.set('q', state.query);
  if (state.activeTags.size) params.set('tags', Array.from(state.activeTags).join(','));
  if (!state.dairyFreeOnly) params.set('dairy', 'all');
  const hash = params.toString();
  history.replaceState(null, '', hash ? `#${hash}` : window.location.pathname);
}

function restoreFromHash() {
  const hash = window.location.hash.slice(1);
  if (!hash) return;
  const params = new URLSearchParams(hash);
  const q = params.get('q');
  if (q) {
    state.query = q;
    els.search.value = q;
  }
  const tags = params.get('tags');
  if (tags) {
    for (const t of tags.split(',')) if (t) state.activeTags.add(t);
    renderTagChips();
  }
  if (params.get('dairy') === 'all') {
    state.dairyFreeOnly = false;
    els.dairyToggle.checked = false;
  }
}

// --- Event wiring --------------------------------------------------------

els.search.addEventListener('input', (e) => {
  state.query = e.target.value;
  syncHash();
  render();
});

els.dairyToggle.addEventListener('change', (e) => {
  state.dairyFreeOnly = e.target.checked;
  syncHash();
  render();
});

// --- Service worker registration (offline support) -----------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('service-worker.js')
      .catch((err) => console.warn('SW registration failed:', err));
  });
}

// --- Go ------------------------------------------------------------------

load();
