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
  /** Name reference number ("*5467") for this passenger; printed, not transmitted. */
  reference?: string;
}

export interface NameItem {
  count: number;
  surname: string;
  passengers: Passenger[];
  /** Infant(s) not occupying a seat (the "-I/" name field). */
  infant?: boolean;
  /** Name reference number ("*5467") for the whole name field. */
  reference?: string;
  /**
   * Passenger type code remark — webhelp BF-fields compare rows
   * verbatim: `N.JONES/ROBERT J*P-MIL` (military),
   * `N.1RYAN/TIM*P-C08 DOB18MAR15` (child + date of birth).
   */
  ptc?: string;
  /** DOB suffix riding the PTC remark (`DOB18MAR15`). */
  dob?: string;
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

  // Passenger-type-code remark + optional DOB: "...*P-C08 DOB18MAR15".
  let ptc: string | undefined;
  let dob: string | undefined;
  const ptcMatch = /\*(P-[A-Z0-9]+)( DOB([A-Z0-9]+))?$/.exec(body);
  if (ptcMatch) {
    ptc = ptcMatch[1];
    dob = ptcMatch[3];
    body = body.slice(0, ptcMatch.index);
  }

  // Trailing name reference number: "...*5467".
  let reference: string | undefined;
  const refMatch = /\*([A-Za-z0-9]+)$/.exec(body);
  if (refMatch) {
    reference = refMatch[1];
    body = body.slice(0, refMatch.index);
  }

  // Optional leading count: "2MURRAY/..." → count 2.
  const countMatch = /^(\d+)/.exec(body);
  const explicitCount = countMatch ? parseInt(countMatch[1], 10) : undefined;
  body = countMatch ? body.slice(countMatch[0].length) : body;

  const [surname, ...givenTokens] = body.split('/');
  const passengers = givenTokens.map(parsePassenger);

  return {
    ptc,
    dob,
    surname: surname.trim(),
    passengers,
    count: explicitCount ?? Math.max(1, passengers.length),
    infant,
    reference,
  };
}

/** Render a name item: "2MURRAY/FRED MR/HANA MRS", "I/1ADAMS/MARY", "1SMITH/LAUREN*5467". */
export function formatNameItem(item: NameItem): string {
  const given = item.passengers
    .map((p) => {
      const title = p.title ? ` ${p.title}` : '';
      const ref = p.reference ? `*${p.reference}` : '';
      return `${p.firstName}${title}${ref}`;
    })
    .join('/');
  const itemRef = item.reference ? `*${item.reference}` : '';
  const ptcTail = item.ptc ? `*${item.ptc}${item.dob ? ' DOB' + item.dob : ''}` : '';
  return `${item.infant ? 'I/' : ''}${item.count}${item.surname}/${given}${itemRef}${ptcTail}`;
}
