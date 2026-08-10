// Lightweight fuzzy subsequence matcher with scoring — zero dependencies so it
// stays fast to load in the popup. Returns { matched, score, positions } so the
// caller can both rank results and highlight the matched characters.
//
// The query is split into TERMS on the same separators that count as word
// boundaries in the target, and every term has to match somewhere. Without that
// split the whole query was one subsequence and a separator had to appear
// LITERALLY: `nova-test` found `NOVA-TEST`, and `nova test` found nothing at
// all — same app, same letters, one key different. The same miss hid `nova_test`
// and `nova.test` and `NovaTest` from `nova-test`, and meant word order could
// never be swapped.
//
// Splitting makes the separators interchangeable, and terms match in any order:
// `nova test`, `nova-test`, `test nova` and `nova_test` all find the same app,
// which is what typing a second word is for.

const SCORE_MATCH = 16; // base reward for each matched character
const SCORE_CONSECUTIVE = 12; // bonus when this match directly follows the previous one
const SCORE_WORD_START = 10; // bonus for matching at the start of a word
const SCORE_CAMEL = 8; // bonus for matching a camelCase hump
const PENALTY_GAP = 2; // penalty per skipped character between matches
const PENALTY_LEADING = 1; // penalty per character before the first match

const WORD_BOUNDARY = /[\s\-_./\\]/;
// The same characters, as a splitter. One list, so a separator can never be a
// boundary in the target and a literal in the query at the same time — which is
// exactly the state that hid `nova test` from `NOVA-TEST`.
const SEPARATORS = /[\s\-_./\\]+/;

// One shared object for the answer that carries no information. Frozen, array
// included: this is returned to every one of several hundred apps that miss on
// each keystroke, and a caller that pushed into a shared `positions` would
// corrupt every later miss.
const MISS = Object.freeze({ matched: false, score: 0, positions: Object.freeze([]) });

/**
 * Fuzzy-match `query` against `target`.
 *
 * Every whitespace- or punctuation-separated term in the query has to match,
 * each as its own subsequence, in any order. An empty query — or one made of
 * nothing but separators — matches everything with a neutral score of 0.
 *
 * @returns {{ matched: boolean, score: number, positions: number[] }}
 */
export function fuzzyMatch(query, target) {
  const t = String(target ?? '');
  const terms = queryTerms(query);
  if (terms.length === 0) return { matched: true, score: 0, positions: [] };
  if (terms.length === 1) return matchTerm(terms[0], t) ?? MISS;

  let score = 0;
  // A Set, because two terms can land on the same character — `nova` and `ova`
  // against `Nova`, say. The highlighter wants each position once.
  const positions = new Set();
  for (const term of terms) {
    const hit = matchTerm(term, t);
    if (!hit) return MISS;
    score += hit.score;
    for (const p of hit.positions) positions.add(p);
  }
  return { matched: true, score, positions: [...positions].sort((a, b) => a - b) };
}

/**
 * The query as terms: lower case, separators dropped, duplicates removed.
 *
 * Deduplicated because the terms are matched independently and nothing stops
 * two of them landing on the same characters — so `nova nova` would otherwise
 * score twice for one word and outrank a better app.
 *
 * Exported because the options page filters the app list too, with a plain
 * substring test, and had exactly the same miss. One definition of "separator"
 * for both, or the two search boxes disagree about what you typed.
 */
export function queryTerms(query) {
  return [
    ...new Set(
      String(query ?? '')
        .toLowerCase()
        .split(SEPARATORS)
        .filter(Boolean),
    ),
  ];
}

/** One term against the whole target. `null` when it is not in there. */
function matchTerm(q, t) {
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

  if (qi < q.length) return null;

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
