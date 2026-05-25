/**
 * A phone-field element. e.g. 9415-555-2121-H → { number: "415-555-2121", type: "H" }.
 * An optional 3-letter city may lead the entry (9NYC305-555-1212-H); otherwise the
 * display prepends the agency home city (workbook display "1.LOS080-955-6610-A").
 */
export interface PhoneElement {
  number: string;
  type?: string; // trailing letter: H home, B business, ...
  city?: string; // explicit 3-letter city from the entry
}

export function parsePhoneText(text: string): PhoneElement {
  let city: string | undefined;
  if (/^[A-Z]{3}/.test(text)) {
    city = text.slice(0, 3);
    text = text.slice(3);
  }
  const m = /-([A-Z])$/.exec(text);
  if (m) return { city, number: text.slice(0, m.index), type: m[1] };
  return { city, number: text };
}
