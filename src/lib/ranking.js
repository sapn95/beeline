// Ranking combines fuzzy relevance with how often / how recently an app was
// launched, so the apps you actually use float to the top.

import { fuzzyMatch } from './fuzzy.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENCY_WINDOW_DAYS = 20; // recency boost decays to zero over this span
const URL_MATCH_WEIGHT = 0.5; // a URL/host match counts for less than a name match

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function usageBoost(stat, now) {
  const freq = Math.min(stat.count ?? 0, 50) * 1.5;
  let recency = 0;
  if (stat.lastLaunched && now) {
    const ageDays = (now - stat.lastLaunched) / DAY_MS;
    recency = Math.max(0, RECENCY_WINDOW_DAYS - ageDays);
  }
  return freq + recency;
}

/**
 * Score a single app for a query. Returns null when neither the name nor the
 * host match. When the query is empty, every app scores on usage only.
 */
export function scoreApp(app, query, now = 0, stats = {}) {
  const stat = stats[app.id] || { count: 0, lastLaunched: 0 };
  const boost = usageBoost(stat, now);

  const nameMatch = fuzzyMatch(query, app.name);
  if (nameMatch.matched) {
    return { app, score: nameMatch.score + boost, positions: nameMatch.positions, field: 'name' };
  }

  // Fall back to the host so people can search by domain (e.g. "azure").
  const urlMatch = fuzzyMatch(query, hostOf(app.url));
  if (urlMatch.matched) {
    return { app, score: urlMatch.score * URL_MATCH_WEIGHT + boost, positions: [], field: 'url' };
  }

  return null;
}

/** Rank a list of apps for a query, best first. Ties break alphabetically. */
export function rankApps(apps, query, now = 0, stats = {}) {
  const q = String(query ?? '').trim();
  const scored = [];
  for (const app of apps) {
    const r = scoreApp(app, q, now, stats);
    if (r) scored.push(r);
  }
  scored.sort((a, b) => b.score - a.score || a.app.name.localeCompare(b.app.name));
  return scored;
}
