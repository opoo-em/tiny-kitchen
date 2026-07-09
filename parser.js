// Tiny Kitchen — shared markdown parser.
// Used by scripts/build.js (node) AND by the app itself (browser) when fetching
// menu.md / ingredients.md live from the private data repo. One parser, two rooms —
// keep it dependency-free and side-effect-free.
//
// parseMenu(md)    → { meals: [{ key, name, note, bases: [...] }], boosters: [...] }
// parseRecipes(md) → { recipes: [...], ingredients: [...], tags: [...] }

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TKParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const slugify = (s) =>
    String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  const extractTags = (line) => {
    const tags = [];
    const re = /\[([^\]]+)\]/g;
    let m;
    while ((m = re.exec(line))) tags.push(m[1].trim().toLowerCase());
    return tags;
  };
  const stripTags = (line) => line.replace(/\[[^\]]+\]/g, '').trim();

  // Emoji extraction — guarded so an old regex engine degrades to "no emoji"
  // instead of a crash.
  let EMOJI_RE = null;
  try {
    EMOJI_RE = new RegExp('\\p{Extended_Pictographic}[\\uFE0F\\u200D]*', 'gu');
  } catch (_) { /* no emoji support; names keep their emoji inline */ }

  function splitEmoji(name) {
    if (!EMOJI_RE) return { name: name.trim(), emoji: '' };
    const found = name.match(EMOJI_RE) || [];
    const clean = name.replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').trim();
    return { name: clean, emoji: found.join('') };
  }

  // --- Ingredient equivalence classes -------------------------------------
  // Substitutable ingredients: matching ANY member makes every member searchable.
  const EQUIVALENCE_CLASSES = [
    ['beef', 'turkey', 'chicken', 'pork', 'ground meat'],
    ['salmon', 'cod', 'tilapia', 'halibut', 'fish'],
    ['spinach', 'kale', 'chard', 'beet greens', 'leafy greens'],
    ['peanut butter', 'almond butter', 'sunflower butter', 'cashew butter', 'tahini', 'nut butter', 'seed butter'],
    ['chickpeas', 'white beans', 'black beans', 'kidney beans', 'pinto beans', 'cannellini', 'navy beans'],
    ['lemon', 'lime', 'orange', 'citrus'],
    ['strawberries', 'blueberries', 'raspberries', 'blackberries', 'mixed berries', 'berries'],
    ['rigatoni', 'penne', 'fusilli', 'shells', 'macaroni', 'pasta'],
    ['soy milk', 'oat milk', 'almond milk', 'cashew milk', 'non-dairy milk'],
    ['parmesan', 'pecorino', 'asiago', 'grana padano', 'hard cheese'],
    ['raisins', 'cranberries', 'cherries', 'apricots', 'dates', 'dried fruit'],
    ['sweet potato', 'butternut squash', 'pumpkin', 'carrot'],
    ['onion', 'shallot', 'leek', 'yellow onion', 'white onion', 'sweet onion'],
    ['tofu', 'firm tofu', 'silken tofu', 'extra-firm tofu'],
    ['white rice', 'brown rice', 'long-grain rice', 'short-grain rice', 'rice'],
  ];

  function expandWithEquivalents(terms) {
    const out = new Set();
    const lower = terms.map((t) => (t || '').toLowerCase());
    for (const t of lower) if (t) out.add(t);
    for (const cls of EQUIVALENCE_CLASSES) {
      if (cls.some((member) => lower.some((t) => t.includes(member)))) {
        for (const member of cls) out.add(member);
      }
    }
    return Array.from(out);
  }

  // Expand a search query into equivalence siblings: "ground turkey" also
  // matches things filed under beef, etc.
  function expandQueryTerms(q) {
    const query = (q || '').toLowerCase().trim();
    if (!query) return [];
    const out = new Set([query]);
    for (const cls of EQUIVALENCE_CLASSES) {
      if (cls.some((member) => query.includes(member) || member.includes(query))) {
        for (const member of cls) out.add(member);
      }
    }
    return Array.from(out);
  }

  // --- Menu parser ---------------------------------------------------------
  // ## Breakfast | Main | Snacks  → meals
  // ## Boosters                    → global booster pool
  // ## Break glass                 → the emergency screen (goldens + rescues)
  // anything else (Reference, …)   → ignored
  // ### Base 🍳 [tags]             → base
  //   > boosters: a, b, c          → explicit booster attachments
  //   > any other text             → note on the base (or meal, if before bases)
  //   - riff text [tags]           → riff
  // Riff/base tags the app understands: [iron] [freezer] [confirmed] [test]

  const MEAL_KEYS = {
    breakfast: 'breakfast',
    main: 'main',
    snack: 'snack',
    snacks: 'snack',
  };

  function parseMenu(md) {
    const lines = String(md).split('\n');
    const meals = [];
    const boosters = [];
    let breakglass = null;    // { note, items: [{text, tags}] }
    let meal = null;          // current meal object
    let base = null;          // current base object
    let inBoosters = false;
    let inBreakglass = false;
    let ignoring = false;

    const flushBase = () => { base = null; };

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');

      const h2 = line.match(/^##\s+(?!#)(.+)$/);
      if (h2) {
        flushBase();
        const title = h2[1].trim();
        const { name } = splitEmoji(title);
        const key = MEAL_KEYS[name.toLowerCase()];
        if (key) {
          meal = { key, name, note: '', bases: [] };
          meals.push(meal);
          inBoosters = false;
          inBreakglass = false;
          ignoring = false;
        } else if (name.toLowerCase() === 'boosters') {
          meal = null;
          inBoosters = true;
          inBreakglass = false;
          ignoring = false;
        } else if (name.toLowerCase() === 'break glass') {
          meal = null;
          inBoosters = false;
          inBreakglass = true;
          breakglass = breakglass || { note: '', items: [] };
          ignoring = false;
        } else {
          meal = null;
          inBoosters = false;
          inBreakglass = false;
          ignoring = true; // Reference etc.
        }
        continue;
      }

      if (ignoring) continue;

      const h3 = line.match(/^###\s+(.+)$/);
      if (h3 && meal) {
        const rawName = h3[1].trim();
        const tags = extractTags(rawName);
        const { name, emoji } = splitEmoji(stripTags(rawName));
        base = {
          id: meal.key + '-' + slugify(name),
          name,
          emoji,
          tags,
          note: '',
          riffs: [],
          explicitBoosters: [],
        };
        meal.bases.push(base);
        continue;
      }

      // Blockquote lines: "> boosters: …" attaches; other quotes become notes.
      const quote = line.match(/^>\s*(.*)$/);
      if (quote && inBreakglass) {
        const q = quote[1].trim();
        if (q) breakglass.note = breakglass.note ? breakglass.note + ' ' + q : q;
        continue;
      }
      if (quote && !inBoosters) {
        const q = quote[1].trim();
        const bl = q.match(/^boosters:\s*(.+)$/i);
        if (bl && base) {
          base.explicitBoosters.push(...bl[1].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
        } else if (q) {
          if (base) base.note = base.note ? base.note + ' ' + q : q;
          else if (meal) meal.note = meal.note ? meal.note + ' ' + q : q;
        }
        continue;
      }

      const bullet = line.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
      if (!bullet) continue;
      const text = bullet[1].trim();

      if (inBreakglass) {
        breakglass.items.push({ text: stripTags(text), tags: extractTags(text) });
        continue;
      }

      if (inBoosters) {
        // "- Name [tags] — pairs: a, b, c (note)"
        const parts = text.split(/\s+[—–-]{1,2}\s+pairs:\s*/i);
        const left = parts[0];
        const tags = extractTags(left);
        const name = stripTags(left).trim();
        let pairs = [];
        let note = '';
        if (parts[1]) {
          let right = parts[1].trim();
          const paren = right.match(/\(([^)]*)\)\s*$/);
          if (paren) {
            note = paren[1].trim();
            right = right.slice(0, paren.index).trim();
          }
          pairs = right.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        }
        boosters.push({ id: slugify(name), name, tags, pairs, note });
        continue;
      }

      if (base) {
        const tags = extractTags(text);
        base.riffs.push({ text: stripTags(text), tags });
      }
    }

    // Resolve boosters onto bases: explicit names first, then pairs matching.
    for (const m of meals) {
      for (const b of m.bases) {
        const baseName = b.name.toLowerCase();
        const attached = [];
        for (const booster of boosters) {
          const boosterName = booster.name.toLowerCase();
          const explicit = b.explicitBoosters.some(
            (e) => boosterName.includes(e) || e.includes(boosterName.split(' (')[0])
          );
          const paired = booster.pairs.some(
            (p) => baseName.includes(p) || p.includes(baseName)
          );
          if (explicit || paired) attached.push(booster.id);
        }
        b.boosterIds = attached;
        delete b.explicitBoosters;
      }
    }

    return { meals, boosters, breakglass };
  }

  // --- Recipe parser (ingredients.md) --------------------------------------
  // Ported from the original scripts/build.js; same markdown contract:
  //   # Ingredient Database → ## Category → ### Ingredient → - **Recipe** [tags]
  //   with cross-references "*full entry under X*".

  const CROSSREF_RE = /^\*?\s*(?:full entry under|under|variation of|variation under)\b/i;
  const stripItalics = (line) => line.replace(/\*([^*]*)\*/g, '$1').trim();

  function parseRecipes(md) {
    const lines = String(md).split('\n');
    let dbStart = lines.findIndex((l) => l.trim() === '# Ingredient Database');
    if (dbStart < 0) return { recipes: [], ingredients: [], tags: [] };
    const dbLines = lines.slice(dbStart + 1);

    const recipes = [];
    const ingredientMap = new Map();
    const pendingCrossRefs = [];

    let currentCategory = null;
    let currentIngredient = null;
    let currentRecipe = null;

    const flushRecipe = () => {
      if (!currentRecipe) return;
      const isCrossRef =
        !currentRecipe.fields.source &&
        !currentRecipe.fields.ingredients &&
        currentRecipe.fields._italic;
      if (isCrossRef) {
        const m = currentRecipe.fields._italic.match(/under\s+([^;]+?)(?:;|$)/i);
        if (m && currentIngredient) {
          pendingCrossRefs.push({
            from: currentIngredient,
            toRecipeName: currentRecipe.name,
            primary: m[1].trim(),
          });
        }
      } else {
        recipes.push(currentRecipe);
        if (currentIngredient) {
          const ing = ingredientMap.get(currentIngredient);
          if (ing) ing.recipeIds.add(currentRecipe.id);
        }
      }
      currentRecipe = null;
    };

    for (const line of dbLines) {
      if (/^##\s+/.test(line) && !/^###/.test(line)) {
        flushRecipe();
        currentCategory = line.replace(/^##\s+/, '').trim();
        currentIngredient = null;
        continue;
      }
      if (/^###\s+/.test(line)) {
        flushRecipe();
        const raw = line.replace(/^###\s+/, '').trim();
        const ingredientTags = extractTags(raw);
        const ingredientName = stripItalics(stripTags(raw));
        currentIngredient = ingredientName;
        if (!ingredientMap.has(ingredientName)) {
          ingredientMap.set(ingredientName, {
            name: ingredientName,
            tags: ingredientTags,
            recipeIds: new Set(),
            category: currentCategory,
          });
        }
        continue;
      }
      const recipeMatch = line.match(/^-\s+\*\*(.+?)\*\*\s*(.*)$/);
      if (recipeMatch && currentIngredient) {
        flushRecipe();
        const name = recipeMatch[1].trim();
        const tagPart = recipeMatch[2] || '';
        currentRecipe = {
          id: slugify(name),
          name,
          tags: extractTags(tagPart),
          primaryIngredient: currentIngredient,
          category: currentCategory,
          fields: {},
          secondaryIngredients: [],
        };
        const tagPartNoTags = stripTags(tagPart).trim();
        const inlineItalic = tagPartNoTags.match(/\*([^*]+)\*/);
        if (inlineItalic && CROSSREF_RE.test(inlineItalic[1])) {
          currentRecipe.fields._italic = inlineItalic[1].trim();
        }
        continue;
      }
      if (/^\s*$/.test(line)) continue;
      if (/^\s*\*\(empty[^)]*\)\*\s*$/i.test(line)) continue;

      if (currentRecipe) {
        const fieldMatch = line.match(/^\s+-\s+(.+)$/);
        if (fieldMatch) {
          const content = fieldMatch[1].trim();
          const italicChunk = content.match(/\*([^*]+)\*/);
          if (italicChunk && CROSSREF_RE.test(italicChunk[1])) {
            currentRecipe.fields._italic = italicChunk[1].trim();
            continue;
          }
          const fv = content.match(/^([A-Za-z][A-Za-z\s\-]*?):\s*(.+)$/);
          if (fv) {
            currentRecipe.fields[fv[1].toLowerCase().trim()] = fv[2].trim();
            continue;
          }
          const callout = content.match(/^\*\*([^*]+)\*\*\s*(.*)$/);
          if (callout) {
            currentRecipe.fields[callout[1].toLowerCase().trim()] = callout[2].trim();
            continue;
          }
          currentRecipe.fields._extra = currentRecipe.fields._extra || [];
          currentRecipe.fields._extra.push(content);
        }
      }
    }
    flushRecipe();

    for (const xref of pendingCrossRefs) {
      const target = recipes.find(
        (r) =>
          r.name.toLowerCase() === xref.toRecipeName.toLowerCase() ||
          (r.primaryIngredient &&
            r.primaryIngredient.toLowerCase().includes(xref.primary.toLowerCase().split(/[()]/)[0].trim()))
      );
      if (target) {
        if (!target.secondaryIngredients.includes(xref.from)) {
          target.secondaryIngredients.push(xref.from);
        }
        const ing = ingredientMap.get(xref.from);
        if (ing) ing.recipeIds.add(target.id);
      }
    }

    const tagSet = new Set();
    for (const r of recipes) for (const t of r.tags) tagSet.add(t);

    const ingredients = Array.from(ingredientMap.values())
      .filter((ing) => ing.recipeIds.size > 0)
      .map((ing) => ({
        name: ing.name,
        tags: ing.tags,
        category: ing.category,
        recipeIds: Array.from(ing.recipeIds).sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const recipesOut = recipes
      .map((r) => ({
        id: r.id,
        type: 'recipe',
        name: r.name,
        tags: r.tags,
        primaryIngredient: r.primaryIngredient,
        secondaryIngredients: r.secondaryIngredients,
        searchTerms: expandWithEquivalents([r.primaryIngredient, ...(r.secondaryIngredients || [])]),
        category: r.category,
        source: r.fields.source || null,
        ingredients: r.fields.ingredients || null,
        method: r.fields.method || null,
        age: r.fields.age || null,
        makes: r.fields.makes || null,
        storage: r.fields.storage || null,
        notes: r.fields.notes || null,
        spiceItUp: r.fields['spice it up'] || null,
        serveWith: r.fields['serve with'] || null,
        familyTip: r.fields['family tip'] || null,
        extras: r.fields._extra || [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return { recipes: recipesOut, ingredients, tags: Array.from(tagSet).sort() };
  }

  return { parseMenu, parseRecipes, expandWithEquivalents, expandQueryTerms, EQUIVALENCE_CLASSES };
});
