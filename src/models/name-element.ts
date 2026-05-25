/**
 * Name field. A single '-' entry creates one **name item**, which may cover
 * several passengers sharing a surname:
 *
 *   -ALONSO/EDITH            → 1 person
 *   -2MURRAY/FRED MR/HANA MRS → 2 people, surname MURRAY
 *
 * Display form (workbook "EXAMPLE OF BASIC PNR"):
 *   1.2MURRAY/FRED MR/HANA MRS   2.1SMITH/JUNE
 *    │ │      └ given names with titles, '/'-separated
 *    │ └ count (passengers in this item)
 *    └ name-item number
 */

const TITLES = new Set(['MR', 'MRS', 'MS', 'MISS', 'MSTR', 'DR', 'PROF', 'SIR', 'LADY']);

export interface Passenger {
  firstName: string;
  title?: string;
}

export interface NameItem {
  count: number;
  surname: string;
  passengers: Passenger[];
  /** Infant(s) not occupying a seat (the "-I/" name field). */
  infant?: boolean;
}

/** Parse one passenger token, e.g. "FRED MR" or "JANE MISS". */
export function parsePassenger(token: string): Passenger {
  const parts = token.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1 && TITLES.has(parts[parts.length - 1])) {
    const title = parts.pop();
    return { firstName: parts.join(' '), title };
  }
  return { firstName: parts.join(' ') };
}

/** Parse the text after the '-' sigil into a NameItem. "I/" marks an infant. */
export function parseNameText(text: string): NameItem {
  let infant = false;
  let body = text;
  if (/^I\//.test(body)) {
    infant = true;
    body = body.slice(2); // drop "I/"
  }

  // Optional leading count: "2MURRAY/..." → count 2.
  const countMatch = /^(\d+)/.exec(body);
  const explicitCount = countMatch ? parseInt(countMatch[1], 10) : undefined;
  body = countMatch ? body.slice(countMatch[0].length) : body;

  const [surname, ...givenTokens] = body.split('/');
  const passengers = givenTokens.map(parsePassenger);

  return {
    surname: surname.trim(),
    passengers,
    count: explicitCount ?? Math.max(1, passengers.length),
    infant,
  };
}

/** Render a name item: "2MURRAY/FRED MR/HANA MRS" or "I/1ADAMS/MARY". */
export function formatNameItem(item: NameItem): string {
  const given = item.passengers
    .map((p) => (p.title ? `${p.firstName} ${p.title}` : p.firstName))
    .join('/');
  return `${item.infant ? 'I/' : ''}${item.count}${item.surname}/${given}`;
}
