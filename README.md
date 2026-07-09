# Tiny Kitchen

A tiny "what do I feed the toddler" instrument. Not a recipe database — a
decision helper: pick a meal, see a short list of food categories, tap one,
get the ways to run it. Or let the Deal tab hand you one card at a time.

**Live app:** https://opoo-em.github.io/tiny-kitchen/

## What this is

A static web app — HTML, CSS, vanilla JavaScript, no framework. Installable
as a PWA, works offline, designed for one-handed kitchen use.

## Architecture

This public repo contains only the app shell. All food data lives in a
separate private repo as plain markdown; the app fetches it at runtime via
the GitHub API using a fine-grained read-only token that the owner configures
on-device. No personal data is ever published here.

- `parser.js` — parses the markdown data client-side
- `app.js` — Browse (cascade) / Deal (one card at a time) / Recipes / Setup
- `service-worker.js` — offline shell caching

---

*Built with* [Claude Code](https://claude.com/product/claude-code).
