// Configurable starter vocabulary, not a universal rule about language use.
export const DEFAULT_FILLERS = Object.freeze([
  "um", "uh", "erm", "ah", "like", "you know", "basically", "actually",
]);
export const MIN_RATE_WORDS = 20;

/** Tokenise whole words, then normalise only the explicitly supported variants. */
function words(text) {
  const tokens = text.toLowerCase().replaceAll("’", "'")
    .match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) || [];
  return tokens.map((token) => token.replace(/^um+$/, "um").replace(/^uh+$/, "uh"));
}

/**
 * Analyse a complete transcript snapshot; no retained counts or browser access.
 * Phrase occurrences count once, not once per word. Longest phrases win overlaps.
 * Explicitly configured single words also count, including inside matched phrases.
 * @param {string} transcript - Current recognised text.
 * @param {string[]} fillers - Configurable words and phrases.
 * @returns {{totalFillers: number, counts: Object<string, number>, totalWords: number, ratePer100Words: number|null}}
 */
export function analyseFillers(transcript, fillers = DEFAULT_FILLERS) {
  if (typeof transcript !== "string") throw new TypeError("Transcript must be text.");
  if (!Array.isArray(fillers) || fillers.some((item) => typeof item !== "string" || words(item).length === 0)) {
    throw new TypeError("Fillers must be a list of nonempty words or phrases.");
  }
  const tokens = words(transcript);
  const names = [...new Set(fillers.map((item) => words(item).join(" ")))];
  const counts = Object.fromEntries(names.map((name) => [name, 0]));
  const singleWords = new Set(names.filter((name) => !name.includes(" ")));
  for (const token of tokens) {
    if (singleWords.has(token)) counts[token]++;
  }

  const phrases = names.filter((name) => name.includes(" "))
    .map((name) => ({name, tokens: name.split(" ")}))
    .sort((a, b) => b.tokens.length - a.tokens.length);
  for (let index = 0; index < tokens.length;) {
    const match = phrases.find((phrase) =>
      phrase.tokens.every((token, offset) => tokens[index + offset] === token)
    );
    if (match) {
      counts[match.name]++;
      index += match.tokens.length;
    } else {
      index++;
    }
  }
  const totalFillers = Object.values(counts).reduce((sum, count) => sum + count, 0);
  return {
    totalFillers,
    counts,
    totalWords: tokens.length,
    ratePer100Words: tokens.length >= MIN_RATE_WORDS ? totalFillers / tokens.length * 100 : null,
  };
}
