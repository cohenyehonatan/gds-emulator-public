/** A phone-field element. e.g. 9415-555-2121-H → { number: "415-555-2121", type: "H" }. */
export interface PhoneElement {
  number: string;
  type?: string; // trailing letter: H home, B business, ...
}

export function parsePhoneText(text: string): PhoneElement {
  const m = /-([A-Z])$/.exec(text);
  if (m) return { number: text.slice(0, m.index), type: m[1] };
  return { number: text };
}
