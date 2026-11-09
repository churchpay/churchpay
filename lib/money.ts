// Euros are parsed once, then stored and compared as integer cents.
function numberToCents(value: string): number | null {
  if (
    !/^(?:(?:[1-9][0-9]{0,2}(?:\.[0-9]{3})+|[0-9]+)(?:,[0-9]{1,2})?|[0-9]+\.[0-9]{1,2})$/.test(
      value,
    )
  )
    return null;
  const german =
    value.includes(",") || /^[1-9][0-9]{0,2}(?:\.[0-9]{3})+$/.test(value);
  const normalized = german
    ? value.replaceAll(".", "").replace(",", ".")
    : value;
  const [whole, fraction = ""] = normalized.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= 99999999
    ? cents
    : null;
}

export function parseEuroCents(input: string): number | null {
  const text = input.trim();
  if (!text || text.length > 256) return null;
  const plain = numberToCents(text);
  if (plain !== null) return plain;
  // Count currency markers before extracting anything: never choose one price
  // from an ambiguous label. Other numbers (e.g. ages) are not payment amounts.
  const currencies = [...text.matchAll(/€|(?<!\p{L})(?:Euro|EUR)(?!\p{L})/giu)];
  if (currencies.length !== 1) return null;
  const before = text.slice(0, currencies[0].index).trimEnd();
  const amount = /([0-9][0-9.,]*)$/.exec(before);
  if (!amount) return null;
  const prefix = before.slice(0, amount.index);
  // A separated label hyphen is valid; a sign directly attached to the price,
  // exponent notation or a fragment of an invalid number is not.
  if (prefix && /[\p{N}.,+\-−]$/u.test(prefix)) return null;
  if (/[0-9][eE]\s*$/u.test(prefix)) return null;
  if (/[+−]\s*$/u.test(prefix) || /^\s*-\s*$/u.test(prefix)) return null;
  return numberToCents(amount[1]);
}

export function sumEuroCents(values: string[]): number | null {
  if (!values.length) return null;
  let total = 0;
  for (const value of values) {
    const cents = parseEuroCents(value);
    if (cents === null) return null;
    total += cents;
  }
  return total > 0 && total <= 99999999 ? total : null;
}

export function formatPayPalAmount(cents: number) {
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > 99999999)
    throw new Error("Invalid payment amount");
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
