/**
 * The agent turn "Browse for me" sends (new-tab page, command bar Shift+Enter).
 * The question is the user's own typed words — that is what makes it a live
 * user message and lets it be SENT rather than drafted (store.seedChat).
 */
export function browseForMePrompt(query: string): string {
  return (
    `Browse for me: ${query}\n\n` +
    'Look this up on the web using the browser — open a few good sources in tabs ' +
    'and read them — then give me a short, well-organised answer: the key points ' +
    'first, details after, and the links you used.'
  )
}
