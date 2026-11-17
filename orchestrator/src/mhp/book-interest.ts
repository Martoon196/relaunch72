import type { MhpRegistrantRecord } from './growth-service.js';

/** Stable public form label: retained in each prospect's signup history. */
export const MHP_BOOK_INTEREST_LABEL = 'Before You Buy — book interest';

/** Filter the owner-authorised read; never use query parameters to select a workspace. */
export function bookInterestRegistrants(registrants: readonly MhpRegistrantRecord[]): MhpRegistrantRecord[] {
  return registrants.filter(person => person.signups.includes(MHP_BOOK_INTEREST_LABEL));
}
