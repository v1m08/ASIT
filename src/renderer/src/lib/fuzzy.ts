// Subsequence scoring, the way editor palettes work: "gsc" hits "GradeScope".
// Shared by the command bar and anything else that ranks by what you typed.

/**
 * Returns a score (higher is better) or -1 for no match. Contiguous runs and
 * word-start hits rank above scattered letters, so exact-ish typing wins.
 */
export function fuzzyScore(text: string, query: string): number {
  if (!query) return 0
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  // Shorter labels win ties: "Gradescope" and "Grade something later" are both
  // prefix hits for "grade", and the one that is mostly your query is the one
  // you meant.
  const brevity = Math.min(40, t.length / 2)
  const direct = t.indexOf(q)
  if (direct === 0) return 1000 - brevity
  if (direct > 0) {
    const wordStart = /[\s\-_/.:]/.test(t[direct - 1])
    return (wordStart ? 800 : 700) - Math.min(direct, 100) - brevity
  }

  let ti = 0
  let points = 0
  let streak = 0
  for (const ch of q) {
    if (ch === ' ') continue
    const at = t.indexOf(ch, ti)
    if (at === -1) return -1
    const wordStart = at === 0 || /[\s\-_/.:]/.test(t[at - 1])
    streak = at === ti ? streak + 1 : 0
    points += 10 + streak * 4 + (wordStart ? 8 : 0)
    ti = at + 1
  }
  return points
}
