// The review rounds the Part asks the app's Assistant for (ws.assistant.register's `review`, bridge
// 1.9, unreleased): once the model ends its answer in a turn that edited the Part, the app sends
// it this prompt ("Review round i of 3: ...") and the turn goes on, until a round makes no edit or
// the three rounds are used up. The prompt is fixed text: ASCII, vendor-neutral, no project data,
// at most 1500 characters (the app's limit). The view inputs it names are ones the view tool
// takes, and the check kinds, get_model's parts and the help topic it names exist
// (tests/assistant/review.test.ts pins them). The eval can turn it off (testing.ts setReview).
// No runtime imports.
// Owner: ASSISTANT.
// SPDX-License-Identifier: GPL-3.0-or-later

/** How many review rounds a turn that edited the Part gets at most. */
export const REVIEW_ROUNDS = 3;

/** The review prompt the model gets at the end of a turn that edited the Part. */
export const REVIEW_PROMPT = [
  'Look at the Part as a whole: call view with views iso, top and front, then view again with views front and section "Front middle" (a cut through the middle), labels bodies; the pictures show each body in its own colour.',
  'Compare it with the request, with the reference picture if one was given, and with what the real object looks like (its typical features and proportions). List what differs, then fix those with the tools; measure sizes you are not sure of.',
  'Check that every part the request named exists (get_model parts). For a mechanism: is each moving part held radially (a shaft in its bore) and along its shaft on both sides (check stack)? Does anything collide when it turns (check sweep, check interference)? If it is to be printed: can every part be printed (help printing: walls, overhangs, clearances)?',
  "If nothing needs changing, reply 'Review: no changes' without calling any edit tool. If view says the model reads no images, check with get_model and measure instead.",
].join('\n');

/** ws.assistant.register's `review`. */
export const CAD_REVIEW: Readonly<{ rounds: number; prompt: string }> = Object.freeze({ rounds: REVIEW_ROUNDS, prompt: REVIEW_PROMPT });
