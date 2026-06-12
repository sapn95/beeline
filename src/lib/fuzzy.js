// Lightweight fuzzy subsequence matcher with scoring — zero dependencies so it
// stays fast to load in the popup. Returns { matched, score, positions } so the
// caller can both rank results and highlight the matched characters.

const SCORE_MATCH = 16; // base reward for each matched character
const SCORE_CONSECUTIVE = 12; // bonus when this match directly follows the previous one
const SCORE_WORD_START = 10; // bonus for matching at the start of a word
const SCORE_CAMEL = 8; // bonus for matching a camelCase hump
const PENALTY_GAP = 2; // penalty per skipped character between matches
const PENALTY_LEADING = 1; // penalty per character before the first match

const WORD_BOUNDARY = /[\s\-_./\\]/;

/**
 * Fuzzy-match `query` against `target`.
 * An empty query matches everything with a neutral score of 0.
 * @returns {{ matched: boolean, score: number, positions: number[] }}
 */
export function fuzzyMatch(query, target) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  const t = String(target ?? '');
  if (q === '') return { matched: true, score: 0, positions: [] };

  const tl = t.toLowerCase();
  const positions = [];
  let score = 0;
  let qi = 0;
  let lastMatch = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (tl[ti] !== q[qi]) continue;

    positions.push(ti);
    score += SCORE_MATCH;

    if (lastMatch === ti - 1) {
      score += SCORE_CONSECUTIVE;
    } else if (lastMatch !== -1) {
      score -= Math.min(PENALTY_GAP * (ti - lastMatch - 1), 24);
    }

    const prev = t[ti - 1];
    if (ti === 0 || (prev && WORD_BOUNDARY.test(prev))) {
      score += SCORE_WORD_START;
    } else if (isCamelHump(t, ti)) {
      score += SCORE_CAMEL;
    }

    lastMatch = ti;
    qi++;
  }

  if (qi < q.length) return { matched: false, score: 0, positions: [] };

  // Prefer matches that begin earlier in the target.
  score -= Math.min(positions[0] * PENALTY_LEADING, 10);
  return { matched: true, score, positions };
}

function isCamelHump(text, i) {
  const prev = text[i - 1];
  const cur = text[i];
  return (
    Boolean(prev) && prev === prev.toLowerCase() && cur === cur.toUpperCase() && /[a-z]/i.test(cur)
  );
}
