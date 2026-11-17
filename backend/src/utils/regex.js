// Search text as a literal pattern: whatever is typed (".*", "(a+)+",
// "(") is matched as those characters, never run as a regular expression --
// a crafted pattern could otherwise tie up the database. Capped in length.
export const escapeRegex = (value) => String(value ?? '').slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One item per name: "Panadol 500mg" and "panadol  500MG" are the same item.
export const sameNameFilter = (name) => ({ name: { $regex: `^\\s*${String(name).trim().split(/\s+/).map(escapeRegex).join('\\s+')}\\s*$`, $options: 'i' } });

// A name search matches from the start of the name ("Z" finds Zinc, not
// Albendazole); `text` must already be escaped.
export const startsWith = (text) => ({ $regex: `^\\s*${text}`, $options: 'i' });

// A generic name matches at the start of any of its words ("sulphate"
// finds Zinc Sulphate), never inside a word.
export const wordStart = (text) => ({ $regex: `(^|\\s)${text}`, $options: 'i' });

// A code or number (item code, serial, barcode, invoice number): with a digit
// typed it matches anywhere ("123" finds PUR-2026-000123); letters only
// match from the start, like names ("n" must not find SN-AMOX500).
export const codeMatch = (text) => (/\d/.test(text) ? { $regex: text, $options: 'i' } : startsWith(text));

// Sort names A to Z with upper and lower case alike ("cuma" next to "Cumar",
// not after every capitalised name).
export const NAME_ORDER = { locale: 'en', strength: 2 };
