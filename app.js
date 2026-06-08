// Tiny Kitchen — single-page recipe finder.
// Loads recipes.json, renders search + tag filter + recipe list.
// Vanilla JS, no framework. State lives in URL hash so reloads keep filters.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  recipes: [],
  ideas: [],
  ingredients: [],
  tags: [],
  query: '',
  activeTags: new Set(),
  dairyFreeOnly: true,
  // 'all' | 'recipes' | 'ideas'
  contentType: 'all',
  openIds: new Set(),
};

const els = {
  search: $('#search'),
  dairyToggle: $('#dairyFreeOnly'),
  tagFilter: $('#tagFilter'),
  results: $('#results'),
  empty: $('#empty'),
  stats: $('#stats'),
  pickBtn: $('#pickForMe'),
};

// --- Load data -----------------------------------------------------------

async function load() {
  try {
    const res = await fetch('data/recipes.json', { cache: 'no-cache' });
    const data = await res.json();
    state.recipes = data.recipes;
    state.ideas = data.ideas || [];
    state.ingredients = data.ingredients;
    state.tags = data.tags;
    els.stats.textContent = `${data.recipeCount} recipes · ${data.ideaCount || 0} ideas · updated ${new Date(data.generated).toLocaleDateString()}`;
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

// Match an item (recipe or idea) against the current search query.
function matchesQuery(item, q) {
  if (!q) return true;
  const hay = [
    item.name,
    item.primaryIngredient || '',
    (item.secondaryIngredients || []).join(' '),
    (item.searchTerms || []).join(' '),
    item.ingredients || '',
    item.group || '',
  ]
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

function matchesFilters(item) {
  if (state.dairyFreeOnly && item.tags.includes('contains-dairy')) return false;
  for (const t of state.activeTags) if (!item.tags.includes(t)) return false;
  return true;
}

function corpus() {
  if (state.contentType === 'recipes') return state.recipes;
  if (state.contentType === 'ideas') return state.ideas;
  // 'all' — recipes first, then ideas
  return [...state.recipes, ...state.ideas];
}

function filterItems() {
  const q = state.query.trim().toLowerCase();
  return corpus().filter((item) => matchesQuery(item, q) && matchesFilters(item));
}

function countHiddenByFilters() {
  const q = state.query.trim().toLowerCase();
  return corpus().filter((item) => matchesQuery(item, q) && !matchesFilters(item)).length;
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

function ideaCard(idea) {
  const q = state.query.trim();
  const tagSpans = idea.tags
    .map((t) => `<span class="recipe-tag${t === 'contains-dairy' ? ' contains-dairy' : ''}">${escapeHtml(t)}</span>`)
    .join('');
  return `
    <article class="idea">
      <div class="idea-row">
        <span class="idea-badge" title="Idea — combinatorial, no recipe needed">💡</span>
        <div class="idea-body">
          <div class="idea-name">${highlight(idea.name, q)}</div>
          <div class="idea-meta">${escapeHtml(idea.group || idea.section)}</div>
        </div>
        <div class="recipe-tags idea-tags">${tagSpans}</div>
      </div>
    </article>
  `;
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

  // "Riff with" — show equivalence-class siblings of the recipe's primary ingredient.
  // These come pre-baked into r.searchTerms by the build script.
  const primaryLower = (r.primaryIngredient || '').toLowerCase();
  const riffOptions = (r.searchTerms || [])
    .filter((t) => t && !primaryLower.includes(t) && !t.includes(primaryLower))
    // Drop the literal secondary ingredients (those aren't "riffs," they're "also in")
    .filter((t) => !(r.secondaryIngredients || []).some((s) => s.toLowerCase().includes(t) || t.includes(s.toLowerCase())))
    .slice(0, 6);
  const riffHtml = riffOptions.length
    ? `<div class="riff-hint">💡 Riff: try <strong>${riffOptions.map(escapeHtml).join('</strong>, <strong>')}</strong></div>`
    : '';

  const details = isOpen
    ? `
    <div class="recipe-details">
      ${riffHtml}
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

function renderItem(item) {
  return item.type === 'idea' ? ideaCard(item) : recipeCard(item);
}

const PLATE_TEMPLATE_HTML = `
  <div class="plate-template">
    <div class="plate-title">Plate Template</div>
    <div class="plate-formula">Protein + Starch + Veg/Fruit + Fat-or-Extra</div>
    <div class="plate-sub">Pick one from each. Dinner solved. Not a creative project.</div>
  </div>
`;

// Group ideas by their section/group (e.g., "5pm Spiral Mode", "Breakfast / Eggs").
function groupIdeas(ideas) {
  const groups = new Map();
  for (const idea of ideas) {
    const key = idea.section === idea.group?.toLowerCase()
      ? capitalize(idea.section)
      : `${capitalize(idea.section)} / ${idea.group || ''}`.replace(/\s\/\s$/, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(idea);
  }
  return groups;
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function render() {
  const filtered = filterItems();
  const hidden = countHiddenByFilters();
  const hiddenNote = hidden > 0
    ? `<div class="hidden-note">${hidden} hidden by your filters. Toggle dairy-free off or clear tag chips to see ${hidden === 1 ? 'it' : 'them'}.</div>`
    : '';

  // Pin the plate template at the top when viewing Ideas-only, no search, no tag filters.
  const showPlate = state.contentType === 'ideas'
    && !state.query.trim()
    && state.activeTags.size === 0;

  if (filtered.length === 0) {
    els.results.innerHTML = hiddenNote;
    els.empty.hidden = hidden > 0;
  } else {
    els.empty.hidden = true;
    let html = hiddenNote;
    if (showPlate) html += PLATE_TEMPLATE_HTML;

    // When viewing Ideas-only (or All with no query), group ideas by section
    if (state.contentType === 'ideas' && !state.query.trim()) {
      const ideaItems = filtered.filter((x) => x.type === 'idea');
      const grouped = groupIdeas(ideaItems);
      for (const [groupName, items] of grouped) {
        html += `<h2 class="group-header">${escapeHtml(groupName)}</h2>`;
        html += items.map(renderItem).join('');
      }
    } else {
      html += filtered.map(renderItem).join('');
    }
    els.results.innerHTML = html;
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
  if (state.contentType !== 'all') params.set('type', state.contentType);
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
  const type = params.get('type');
  if (type === 'recipes' || type === 'ideas') {
    state.contentType = type;
    document.querySelectorAll('#contentTypeFilter .seg-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.type === type);
    });
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

// "Pick for me" — random item from the currently-filtered list.
els.pickBtn.addEventListener('click', () => {
  const pool = filterItems();
  if (pool.length === 0) {
    els.results.innerHTML = `<div class="hidden-note">Nothing to pick from with current filters. Clear something and try again.</div>`;
    return;
  }
  const winner = pool[Math.floor(Math.random() * pool.length)];
  // Open it if it's a recipe; just render its card pinned at top if it's an idea.
  if (winner.type === 'recipe') state.openIds.add(winner.id);
  els.results.innerHTML =
    `<div class="hidden-note">🎲 Picked for you: <strong>${escapeHtml(winner.name)}</strong>. <a href="#" id="seeAll">See all</a></div>` +
    renderItem(winner);
  document.getElementById('seeAll')?.addEventListener('click', (e) => {
    e.preventDefault();
    render();
  });
  // Scroll to results
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// Content-type segmented control
document.querySelectorAll('#contentTypeFilter .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#contentTypeFilter .seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.contentType = btn.dataset.type;
    syncHash();
    render();
  });
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
