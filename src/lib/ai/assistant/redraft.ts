// Redraft with AI: the user asked the assistant to rewrite the open draft. That one rewrite goes straight into
// the draft (the composer offers Undo); any other change the assistant makes to a draft needs the user's OK on a card.

/** The compose session whose Redraft is running, until its first edit or the end of its turn. */
let redraft: number | null = null;

/** The composer starts a Redraft for `session`; call the returned function when that turn ends. */
export function expectRedraft(session: number): () => void {
  redraft = session;
  return () => {
    if (redraft === session) redraft = null;
  };
}

/** True once for the session's Redraft: this edit is the rewrite the user asked for. */
export function takeRedraft(session: number): boolean {
  if (redraft !== session) return false;
  redraft = null;
  return true;
}
