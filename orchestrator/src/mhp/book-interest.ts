import type { MhpRegistrantRecord } from './growth-service.js';

/** Stable public form label: retained in each prospect's signup history. */
export const MHP_BOOK_INTEREST_LABEL = 'Before You Buy — book interest';
/** The book form's module field (CHEATSHEET_MODULE). */
export const MHP_BOOK_MODULE = 'book-before-you-buy';

/** Filter the owner-authorised read; never use query parameters to select a workspace. */
export function bookInterestRegistrants(registrants: readonly MhpRegistrantRecord[]): MhpRegistrantRecord[] {
  return registrants.filter(person => person.signups.includes(MHP_BOOK_INTEREST_LABEL));
}
