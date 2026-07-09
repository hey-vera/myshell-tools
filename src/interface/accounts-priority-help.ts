/**
 * Honest priority/weight copy shared by account menus.
 *
 * priorityWeight / custom weight balance seats *within one provider*
 * via normalized load (sessionTokens / priorityWeight) and sticky
 * high-weight selection. They do NOT choose Claude vs Codex vs Grok
 * (provider order is separate).
 */

/** Dim list-screen note under the priority column when accounts exist. */
export const PRIORITY_WEIGHT_LIST_HINT =
  'Weight balances seats of this provider only (tokens \u00f7 weight) — not Claude vs Codex vs Grok.';

/** Help block above priority preset keys on the edit/priority screen. */
export const PRIORITY_WEIGHT_EDIT_HELP =
  'Weight balances load among this provider\'s seats (session tokens \u00f7 weight).\n' +
  'Higher weight absorbs more of this provider\'s work. Does not choose provider order.';

/** One-line parenthetical under the priority field on the account detail screen. */
export const PRIORITY_WEIGHT_DETAIL_NOTE =
  'within-provider seat balance only — not Auto provider order';
