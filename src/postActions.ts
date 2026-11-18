// One shared set of "actions without an X trade post" for postThought (index.ts) and for analyst thoughts (intel/router.ts: tradedRefs →
// attachThoughts). A separate module without imports: pipeline.ts imports router.ts, so router cannot take the value from pipeline.
//
// For such an action the executor writes no trade post, so the analyst's "thought" must not be suppressed — nothing would replace it. A social
// task and a request to the owner produce no posts (the owner 2026-11-10: "no card, no post" for Phäros); a task-site session (E-06) —
// neither: it has no money and no position (a prod bug 2026-11-17: dapp_session suppressed the thought, nothing went out to X).
export const NO_POST_ACTIONS: ReadonlySet<string> = new Set(['skip', 'journal_only', 'social_session', 'notify_human', 'dapp_session']);
/** Whether the analysis has an action a trade post will cover (then the thought is not published). */
export const actedForPost = (decisions: { action: string }[]): boolean => decisions.some(x => !NO_POST_ACTIONS.has(x.action));
