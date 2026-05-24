/** A passenger name element. e.g. -ALONSO/EDITH → { surname, firstName }. */
export interface NameElement {
  surname: string;
  firstName: string;
  title?: string; // MR / MRS / MS ...
}

/** Parse the text after the '-' sigil into a NameElement. */
export function parseNameText(text: string): NameElement {
  const [surname, rest = ''] = text.split('/', 2);
  const parts = rest.trim().split(/\s+/);
  const title = parts.length > 1 ? parts.pop() : undefined;
  return { surname: surname.trim(), firstName: parts.join(' ').trim(), title };
}
