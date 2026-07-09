// Tiny Kitchen v2 — "the instrument."
// One persistent meal context (Breakfast / Main / Snack), four rooms:
//   🥣 Browse  — cascade: short list of bases → tap → riffs + boosters
//   🎲 Deal    — one card at a time, yes/no, scoped to the meal
//   📖 Recipes — the old searchable recipe list; search returns ideas first
//   ⚙️ Setup   — Coach-style connection to the private data repo (fine-grained PAT)
//
// Data: remote markdown (menu.md + ingredients.md) fetched from GitHub and parsed
// client-side via parser.js when connected; bundled data/tiny.json otherwise.
// Served-it history lives only in localStorage on this device.

/* global TKParser */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// --- Persistence ----------------------------------------------------------

const LS = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (_) {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* full/blocked */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch (_) { /* noop */ }
  },
};

const KEYS = {
  tab: 'tk_tab',
  meal: 'tk_meal', // { meal, date } — manual pick only sticks for the day
  remote: 'tk_remote', // { owner, repo, branch, token }
  cache: 'tk_cache', // { menuMd, recipesMd, fetchedAt }
  served: 'tk_served', // [ { riff, baseId, ts } ] newest-first, capped
};

// --- State ----------------------------------------------------------------

const state = {
  data: null, // { meals, boosters, recipes, ingredients, recipeTags }
  source: null, // 'remote' | 'remote-cache' | 'local'
  fetchedAt: null,
  meal: defaultMeal(),
  tab: LS.get(KEYS.tab, 'browse'),
  openBaseId: null,
  deal: null, // { meal, order: [baseId], idx, accepted }
  q: '',
  activeTags: new Set(),
  dairyFreeOnly: true,
  openIds: new Set(),
  setupStatus: null, // { ok, message }
};

function defaultMeal() {
  const saved = LS.get(KEYS.meal, null);
  const today = new Date().toDateString();
  if (saved && saved.date === today) return saved.meal;
  // Zeroth decision made for you: mornings mean breakfast.
  return new Date().getHours() < 11 ? 'breakfast' : 'main';
}

// --- Served-it history ----------------------------------------------------

function servedList() {
  return LS.get(KEYS.served, []);
}

function riffServedAt(riffText) {
  const hit = servedList().find((s) => s.riff === riffText);
  return hit ? hit.ts : null;
}

function baseServedAt(baseId) {
  const hit = servedList().find((s) => s.baseId === baseId);
  return hit ? hit.ts : null;
}

function toggleServed(riffText, baseId) {
  let list = servedList();
  const today = new Date().toDateString();
  const idx = list.findIndex((s) => s.riff === riffText && new Date(s.ts).toDateString() === today);
  if (idx >= 0) list.splice(idx, 1); // tap again same day = undo
  else list.unshift({ riff: riffText, baseId, ts: Date.now() });
  LS.set(KEYS.served, list.slice(0, 200));
}

function agoLabel(ts) {
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return new Date(ts).toLocaleDateString(undefined, { weekday: 'short' });
  return null; // older than a week: don't clutter
}

// --- Data loading ---------------------------------------------------------

const REMOTE_PATHS = {
  menu: ['menu.md', 'kid/menu.md'],
  recipes: ['ingredients.md', 'kid/ingredients.md'],
};

async function fetchRemoteFile(cfg, candidates) {
  for (const path of candidates) {
    const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${path}?ref=${encodeURIComponent(cfg.branch || 'main')}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github.raw+json',
      },
    });
    if (res.ok) return res.text();
    if (res.status !== 404) {
      const detail = res.status === 401 ? 'token rejected (401)' : `HTTP ${res.status}`;
      throw new Error(`${cfg.owner}/${cfg.repo}/${path}: ${detail}`);
    }
  }
  return null; // none of the candidate paths exist
}

function parseIntoData(menuMd, recipesMd) {
  const menu = TKParser.parseMenu(menuMd || '');
  const rec = TKParser.parseRecipes(recipesMd || '');
  return {
    meals: menu.meals,
    boosters: menu.boosters,
    recipes: rec.recipes,
    ingredients: rec.ingredients,
    recipeTags: rec.tags,
  };
}

async function refreshFromRemote(cfg, { silent } = {}) {
  const menuMd = await fetchRemoteFile(cfg, REMOTE_PATHS.menu);
  if (menuMd === null) throw new Error('menu.md not found in that repo (tried root and kid/)');
  const recipesMd = (await fetchRemoteFile(cfg, REMOTE_PATHS.recipes)) || '';
  LS.set(KEYS.cache, { menuMd, recipesMd, fetchedAt: Date.now() });
  state.data = parseIntoData(menuMd, recipesMd);
  state.source = 'remote';
  state.fetchedAt = Date.now();
  if (!silent) render();
  return state.data;
}

async function load() {
  const cfg = LS.get(KEYS.remote, null);

  if (cfg && cfg.token) {
    // Cached copy first (instant + offline), refresh in the background.
    const cache = LS.get(KEYS.cache, null);
    if (cache && cache.menuMd) {
      state.data = parseIntoData(cache.menuMd, cache.recipesMd);
      state.source = 'remote-cache';
      state.fetchedAt = cache.fetchedAt;
      render();
      refreshFromRemote(cfg, { silent: true }).then(render).catch(() => { /* offline — cache stands */ });
      return;
    }
    try {
      await refreshFromRemote(cfg);
      return;
    } catch (err) {
      state.setupStatus = { ok: false, message: `Couldn't reach your kitchen: ${err.message}` };
      // fall through to local bundle if present
    }
  }

  try {
    const res = await fetch('data/tiny.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('no local bundle');
    state.data = await res.json();
    state.source = 'local';
    state.fetchedAt = Date.parse(state.data.generated) || null;
    render();
  } catch (_) {
    // Public shell with no connection yet — send her to Setup.
    state.data = null;
    state.tab = 'setup';
    render();
  }
}

// --- Utilities --------------------------------------------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function currentMeal() {
  if (!state.data) return null;
  return state.data.meals.find((m) => m.key === state.meal) || null;
}

function boosterById(id) {
  return (state.data.boosters || []).find((b) => b.id === id);
}

const ironDot = '<span class="iron-dot" title="iron">●</span>';

// --- Shared: riff rows + booster chips (used by Browse and Deal) -----------

function riffRowsHtml(base) {
  return base.riffs
    .map((riff) => {
      const ts = riffServedAt(riff.text);
      const ago = ts ? agoLabel(ts) : null;
      const iron = riff.tags.includes('iron') ? ' ' + ironDot : '';
      const freezer = riff.tags.includes('freezer') ? ' <span class="mini-tag">❄️</span>' : '';
      return `
        <div class="riff-row">
          <div class="riff-text">${escapeHtml(riff.text)}${iron}${freezer}</div>
          <button class="served-btn${ago ? ' served' : ''}" type="button"
                  data-riff="${escapeHtml(riff.text)}" data-base="${base.id}"
                  title="Mark as served">
            ${ago ? `✓ ${ago}` : '✓'}
          </button>
        </div>`;
    })
    .join('');
}

function boosterChipsHtml(base) {
  if (!base.boosterIds || base.boosterIds.length === 0) return '';
  const chips = base.boosterIds
    .map((id) => {
      const b = boosterById(id);
      if (!b) return '';
      const short = b.name.split(' (')[0];
      const iron = b.tags.includes('iron') ? ' ' + ironDot : '';
      return `<span class="booster-chip" title="${escapeHtml(b.note || b.name)}">+ ${escapeHtml(short)}${iron}</span>`;
    })
    .join('');
  return `<div class="booster-row"><span class="booster-label">boost it:</span>${chips}</div>`;
}

function wireServedButtons(container) {
  container.querySelectorAll('.served-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleServed(btn.dataset.riff, btn.dataset.base);
      render();
    });
  });
}

// --- Browse (the cascade) ---------------------------------------------------

function renderBrowse(el) {
  const meal = currentMeal();
  if (!meal) { el.innerHTML = emptyDataHtml(); return; }

  const note = meal.note ? `<p class="meal-note">${escapeHtml(meal.note)}</p>` : '';
  const rows = meal.bases
    .map((base) => {
      const open = state.openBaseId === base.id;
      const iron = base.tags.includes('iron') ? ' ' + ironDot : '';
      const freezer = base.tags.includes('freezer') ? ' <span class="mini-tag">❄️</span>' : '';
      const details = open
        ? `<div class="base-details">
             ${base.note ? `<p class="base-note">${escapeHtml(base.note)}</p>` : ''}
             ${riffRowsHtml(base)}
             ${boosterChipsHtml(base)}
           </div>`
        : '';
      return `
        <article class="base${open ? ' open' : ''}" data-base="${base.id}">
          <button class="base-header" type="button" aria-expanded="${open}">
            <span class="base-emoji">${base.emoji || '🍽️'}</span>
            <span class="base-name">${escapeHtml(base.name)}${iron}${freezer}</span>
            <span class="base-count">${base.riffs.length}</span>
            <span class="caret">›</span>
          </button>
          ${details}
        </article>`;
    })
    .join('');

  el.innerHTML = note + `<div class="base-list">${rows}</div>`;

  el.querySelectorAll('.base-header').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.base').dataset.base;
      state.openBaseId = state.openBaseId === id ? null : id;
      render();
    });
  });
  wireServedButtons(el);
}

// --- Deal (one card at a time) ----------------------------------------------

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newDeck() {
  const meal = currentMeal();
  if (!meal) return null;
  const fresh = [];
  const recent = [];
  const cutoff = Date.now() - 20 * 3600 * 1000; // served in last ~day goes to the back
  for (const base of shuffled(meal.bases)) {
    const ts = baseServedAt(base.id);
    (ts && ts > cutoff ? recent : fresh).push(base.id);
  }
  return { meal: state.meal, order: [...fresh, ...recent], idx: 0, accepted: false, looped: false };
}

function renderDeal(el) {
  const meal = currentMeal();
  if (!meal) { el.innerHTML = emptyDataHtml(); return; }

  if (!state.deal || state.deal.meal !== state.meal) state.deal = newDeck();
  const deal = state.deal;
  const base = meal.bases.find((b) => b.id === deal.order[deal.idx]);
  if (!base) { state.deal = newDeck(); return renderDeal(el); }

  const iron = base.tags.includes('iron') ? ' ' + ironDot : '';
  const loopNote = deal.looped && deal.idx === 0
    ? `<p class="deal-loop-note">That was the whole deck — going around again.</p>` : '';

  if (!deal.accepted) {
    el.innerHTML = `
      ${loopNote}
      <div class="deal-card">
        <div class="deal-emoji">${base.emoji || '🍽️'}</div>
        <div class="deal-name">${escapeHtml(base.name)}${iron}</div>
        <div class="deal-sub">${base.riffs.length} ways to run it</div>
        <div class="deal-actions">
          <button class="deal-no" type="button">Not today</button>
          <button class="deal-yes" type="button">Yes, that</button>
        </div>
      </div>`;
    el.querySelector('.deal-no').addEventListener('click', () => {
      deal.idx += 1;
      if (deal.idx >= deal.order.length) { deal.idx = 0; deal.looped = true; }
      render();
    });
    el.querySelector('.deal-yes').addEventListener('click', () => {
      deal.accepted = true;
      render();
    });
  } else {
    el.innerHTML = `
      <div class="deal-card accepted">
        <div class="deal-emoji small">${base.emoji || '🍽️'}</div>
        <div class="deal-name">${escapeHtml(base.name)}${iron}</div>
        ${base.note ? `<p class="base-note">${escapeHtml(base.note)}</p>` : ''}
        <div class="deal-riffs">${riffRowsHtml(base)}</div>
        ${boosterChipsHtml(base)}
        <button class="deal-again" type="button">↺ Actually, deal again</button>
      </div>`;
    el.querySelector('.deal-again').addEventListener('click', () => {
      deal.accepted = false;
      deal.idx += 1;
      if (deal.idx >= deal.order.length) { deal.idx = 0; deal.looped = true; }
      render();
    });
    wireServedButtons(el);
  }
}

// --- Recipes room (search: ideas first, recipes after) ----------------------

function renderTagChips() {
  const holder = $('#tagFilter');
  holder.innerHTML = '';
  const tags = (state.data && state.data.recipeTags) || [];
  for (const tag of tags) {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.classList.toggle('active', state.activeTags.has(tag));
    if (tag === 'contains-dairy') btn.classList.add('contains-dairy');
    btn.textContent = tag;
    btn.addEventListener('click', () => {
      if (state.activeTags.has(tag)) state.activeTags.delete(tag);
      else state.activeTags.add(tag);
      render();
    });
    holder.appendChild(btn);
  }
}

function ideaMatches(q) {
  // Search bases + riffs across ALL meals — "chicken" should surface moves
  // wherever they live. Equivalence classes widen the net.
  if (!q || !state.data) return [];
  const terms = TKParser.expandQueryTerms(q);
  const hits = [];
  for (const meal of state.data.meals) {
    for (const base of meal.bases) {
      const baseHay = base.name.toLowerCase();
      const baseHit = terms.some((t) => baseHay.includes(t));
      for (const riff of base.riffs) {
        const riffHay = riff.text.toLowerCase();
        if (baseHit || terms.some((t) => riffHay.includes(t))) {
          hits.push({ meal, base, riff });
        }
      }
    }
  }
  return hits.slice(0, 24);
}

function recipeMatches(q) {
  const recipes = (state.data && state.data.recipes) || [];
  const terms = q ? TKParser.expandQueryTerms(q) : [];
  return recipes.filter((r) => {
    if (state.dairyFreeOnly && r.tags.includes('contains-dairy')) return false;
    for (const t of state.activeTags) if (!r.tags.includes(t)) return false;
    if (!q) return true;
    const hay = [
      r.name,
      r.primaryIngredient || '',
      (r.secondaryIngredients || []).join(' '),
      (r.searchTerms || []).join(' '),
      r.ingredients || '',
    ].join(' ').toLowerCase();
    return terms.some((t) => hay.includes(t)) || hay.includes(q);
  });
}

function recipeCard(r) {
  const isOpen = state.openIds.has(r.id);
  const tagSpans = r.tags
    .map((t) => `<span class="recipe-tag${t === 'contains-dairy' ? ' contains-dairy' : ''}">${escapeHtml(t)}</span>`)
    .join('');
  const ingredientChain = [r.primaryIngredient, ...(r.secondaryIngredients || [])].filter(Boolean).join(', ');
  const details = isOpen
    ? `<div class="recipe-details">
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
        ${r.extras && r.extras.length ? `<div class="ingredient-links"><span>also:</span> ${r.extras.map(escapeHtml).join('<br>')}</div>` : ''}
      </div>`
    : '';
  return `
    <article class="recipe${isOpen ? ' open' : ''}" data-id="${r.id}">
      <button class="recipe-header" type="button" aria-expanded="${isOpen}">
        <div class="recipe-title"><span>${escapeHtml(r.name)}</span><span class="caret">›</span></div>
        <div class="recipe-meta">${escapeHtml(ingredientChain)}</div>
        <div class="recipe-tags">${tagSpans}</div>
      </button>
      ${details}
    </article>`;
}

function renderRecipes() {
  const results = $('#results');
  const empty = $('#empty');
  if (!state.data) { results.innerHTML = emptyDataHtml(); empty.hidden = true; return; }

  const q = state.q.trim().toLowerCase();
  const ideas = q ? ideaMatches(q) : [];
  const recipes = recipeMatches(q);

  let html = '';
  if (ideas.length) {
    html += `<h2 class="group-header">Ideas — no recipe needed</h2>`;
    html += ideas
      .map(
        ({ meal, base, riff }) => `
        <article class="idea">
          <div class="idea-row">
            <span class="idea-badge">${base.emoji || '💡'}</span>
            <div class="idea-body">
              <div class="idea-name">${escapeHtml(riff.text)}</div>
              <div class="idea-meta">${escapeHtml(meal.name)} · ${escapeHtml(base.name)}</div>
            </div>
          </div>
        </article>`
      )
      .join('');
  }
  if (recipes.length) {
    if (q || ideas.length) html += `<h2 class="group-header">Recipes</h2>`;
    html += recipes.map(recipeCard).join('');
  }

  results.innerHTML = html;
  empty.hidden = Boolean(html);

  results.querySelectorAll('.recipe-header').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.recipe').dataset.id;
      if (state.openIds.has(id)) state.openIds.delete(id);
      else state.openIds.add(id);
      render();
    });
  });
}

// --- Setup room -------------------------------------------------------------

function sourceLine() {
  if (!state.data) return 'No data connected yet.';
  const when = state.fetchedAt ? new Date(state.fetchedAt).toLocaleString() : '?';
  if (state.source === 'local') return `Using the bundled local data (built ${when}).`;
  const cfg = LS.get(KEYS.remote, {});
  const stale = state.source === 'remote-cache' ? ' (cached copy — will refresh when online)' : '';
  return `Connected to ${cfg.owner}/${cfg.repo}@${cfg.branch || 'main'} · fetched ${when}${stale}.`;
}

function renderSetup(el) {
  const cfg = LS.get(KEYS.remote, { owner: 'opoo-em', repo: 'tiny-kitchen-private', branch: 'main', token: '' });
  const status = state.setupStatus;
  el.innerHTML = `
    <div class="setup-card">
      <h2 class="setup-title">Data repo connection</h2>
      <p class="setup-blurb">
        Everything personal lives in your private repo. This app reads it with a
        fine-grained token that only works on that one repo — read-only, stored
        only on this phone.
      </p>
      <label class="setup-label">GitHub username (owner)
        <input id="su-owner" type="text" value="${escapeHtml(cfg.owner || '')}" autocapitalize="off" autocorrect="off" spellcheck="false" />
      </label>
      <label class="setup-label">Private data repo name
        <input id="su-repo" type="text" value="${escapeHtml(cfg.repo || '')}" autocapitalize="off" autocorrect="off" spellcheck="false" />
      </label>
      <label class="setup-label">Branch
        <input id="su-branch" type="text" value="${escapeHtml(cfg.branch || 'main')}" autocapitalize="off" autocorrect="off" spellcheck="false" />
      </label>
      <label class="setup-label">Fine-grained personal access token
        <input id="su-token" type="password" value="${escapeHtml(cfg.token || '')}" autocomplete="off" />
      </label>
      <button id="su-save" class="setup-save" type="button">Save &amp; test connection</button>
      ${status ? `<p class="setup-status ${status.ok ? 'ok' : 'err'}">${escapeHtml(status.message)}</p>` : ''}
      <p class="setup-source">${escapeHtml(sourceLine())}</p>
      <div class="setup-row">
        <button id="su-refresh" class="setup-minor" type="button">↻ Refresh data now</button>
        <button id="su-forget" class="setup-minor danger" type="button">Forget connection</button>
      </div>
      <details class="setup-help">
        <summary>How do I get a token?</summary>
        <ol>
          <li>GitHub → Settings → Developer settings → Personal access tokens → <strong>Fine-grained tokens</strong> → Generate new token.</li>
          <li>Name it “tiny kitchen”. Expiration: 1 year.</li>
          <li>Repository access: <strong>Only select repositories</strong> → pick your private data repo.</li>
          <li>Permissions → Repository → <strong>Contents: Read-only</strong>. Nothing else.</li>
          <li>Generate, copy, paste it here. Done.</li>
        </ol>
      </details>
    </div>`;

  el.querySelector('#su-save').addEventListener('click', async () => {
    const next = {
      owner: el.querySelector('#su-owner').value.trim(),
      repo: el.querySelector('#su-repo').value.trim(),
      branch: el.querySelector('#su-branch').value.trim() || 'main',
      token: el.querySelector('#su-token').value.trim(),
    };
    if (!next.owner || !next.repo || !next.token) {
      state.setupStatus = { ok: false, message: 'Owner, repo, and token are all required.' };
      render();
      return;
    }
    LS.set(KEYS.remote, next);
    state.setupStatus = { ok: true, message: 'Testing…' };
    render();
    try {
      const data = await refreshFromRemote(next, { silent: true });
      const bases = data.meals.reduce((n, m) => n + m.bases.length, 0);
      state.setupStatus = {
        ok: true,
        message: `Connected! ${data.meals.length} meals, ${bases} bases, ${data.recipes.length} recipes.`,
      };
    } catch (err) {
      state.setupStatus = { ok: false, message: `Connection failed: ${err.message}` };
    }
    render();
  });

  el.querySelector('#su-refresh').addEventListener('click', async () => {
    const c = LS.get(KEYS.remote, null);
    if (!c || !c.token) {
      state.setupStatus = { ok: false, message: 'No connection saved yet.' };
      render();
      return;
    }
    try {
      await refreshFromRemote(c, { silent: true });
      state.setupStatus = { ok: true, message: 'Refreshed.' };
    } catch (err) {
      state.setupStatus = { ok: false, message: `Refresh failed: ${err.message}` };
    }
    render();
  });

  el.querySelector('#su-forget').addEventListener('click', () => {
    LS.remove(KEYS.remote);
    LS.remove(KEYS.cache);
    state.setupStatus = { ok: true, message: 'Connection forgotten. Token removed from this phone.' };
    state.source = null;
    load();
  });
}

// --- Shell rendering --------------------------------------------------------

function emptyDataHtml() {
  return `<div class="empty">
    <div style="font-size:2rem;margin-bottom:0.4rem;">🔌</div>
    No data yet.<br/><small>Head to ⚙️ Setup to connect your kitchen.</small>
  </div>`;
}

function render() {
  // Meal pills — hidden in rooms where meal context is irrelevant.
  const mealAware = state.tab === 'browse' || state.tab === 'deal';
  $('#mealPills').style.display = mealAware ? '' : 'none';
  $$('.meal-pill').forEach((b) => b.classList.toggle('active', b.dataset.meal === state.meal));

  // Tabs
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));

  // Views
  const views = { browse: '#view-browse', deal: '#view-deal', recipes: '#view-recipes', setup: '#view-setup' };
  for (const [tab, sel] of Object.entries(views)) $(sel).hidden = tab !== state.tab;

  if (state.tab === 'browse') renderBrowse($('#view-browse'));
  else if (state.tab === 'deal') renderDeal($('#view-deal'));
  else if (state.tab === 'recipes') { renderTagChips(); renderRecipes(); }
  else if (state.tab === 'setup') renderSetup($('#view-setup'));
}

// --- Event wiring -----------------------------------------------------------

$('#mealPills').addEventListener('click', (e) => {
  const btn = e.target.closest('.meal-pill');
  if (!btn) return;
  state.meal = btn.dataset.meal;
  state.openBaseId = null;
  LS.set(KEYS.meal, { meal: state.meal, date: new Date().toDateString() });
  render();
});

$('#tabbar').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  state.tab = btn.dataset.tab;
  LS.set(KEYS.tab, state.tab);
  render();
});

$('#search').addEventListener('input', (e) => {
  state.q = e.target.value;
  render();
});

$('#dairyFreeOnly').addEventListener('change', (e) => {
  state.dairyFreeOnly = e.target.checked;
  render();
});

// --- Service worker ----------------------------------------------------------

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch((err) => console.warn('SW registration failed:', err));
  });
}

// --- Go -----------------------------------------------------------------------

render(); // paint shell immediately
load();
