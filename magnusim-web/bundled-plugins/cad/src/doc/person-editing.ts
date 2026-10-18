// PersonEditing: an Assistant step met the person's work and stood back. Thrown
// by an edit made inside AssistantStep.run that would otherwise commit or replace
// a session the step does not own (the person's open panel), and by
// doc.assistant.begin while such a session is open. The person's session is left
// open and uncommitted; the Assistant waits and tries again.
// Owner: DOC-CORE.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { FeatureId } from '../types/doc';

export class PersonEditing extends Error {
  /** The feature whose panel the person has open, or null. */
  readonly feature: FeatureId | null;

  constructor(message: string, feature: FeatureId | null = null) {
    super(message);
    this.name = 'PersonEditing';
    this.feature = feature;
  }
}

export function isPersonEditing(e: unknown): e is PersonEditing {
  return e instanceof PersonEditing;
}
