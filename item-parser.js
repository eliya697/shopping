/*
 * Turns free text into items.
 *   parseSingle("2 ק״ג עגבניות")          -> { name: "עגבניות", quantity: "2 ק״ג" }
 *   parseSpoken("תוסיף חלב, ביצים ועגבניות") -> [{ name: "חלב" }, { name: "ביצים" }, { name: "עגבניות" }]
 * Works in the browser (window.ItemParser) and in Node (for tests).
 */
(function (root) {
  "use strict";

  const NUMBER_WORDS = {
    "אחד": 1, "אחת": 1, "שניים": 2, "שתיים": 2, "שני": 2, "שתי": 2, "זוג": 2,
    "שלוש": 3, "שלושה": 3, "ארבע": 4, "ארבעה": 4, "חמש": 5, "חמישה": 5,
    "שש": 6, "שישה": 6, "שבע": 7, "שבעה": 7, "שמונה": 8, "תשע": 9, "תשעה": 9,
    "עשר": 10, "עשרה": 10, "חצי": "½",
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, half: "½",
  };

  const UNITS = {
    "קילו": "ק״ג", "קג": "ק״ג", "ק״ג": "ק״ג", "ק\"ג": "ק״ג", "קילוגרם": "ק״ג",
    "גרם": "גרם", "ליטר": "ליטר", "ליטרים": "ליטר",
    "חבילה": "חבילה", "חבילות": "חבילות", "בקבוק": "בקבוק", "בקבוקים": "בקבוקים",
    "יחידה": "יח׳", "יחידות": "יח׳", "מגש": "מגש", "מגשים": "מגשים",
    "קופסה": "קופסה", "קופסאות": "קופסאות", "שקית": "שקית", "שקיות": "שקיות",
    "צרור": "צרור", "צרורות": "צרורות",
    kg: "kg", kilo: "kg", g: "g", grams: "g", l: "l", liter: "l", liters: "l",
    pack: "pack", packs: "packs", bottle: "bottle", bottles: "bottles",
  };
  // Units that can start an item on their own ("קילו עגבניות" = 1 kg of tomatoes).
  const STANDALONE_UNITS = new Set(["קילו", "ליטר", "חבילה", "בקבוק", "מגש", "קופסה", "שקית", "צרור"]);

  const COMMAND_PREFIX = /^(?:(?:תוסיף|תוסיפי|תוסיפו|הוסף|הוסיפי|להוסיף|תכניס|תכניסי|תרשום|תרשמי|צריך|צריכים|צריכה|נא|בבקשה|גם|add|please|we need|i need|buy)\s+)+/;
  const COMMAND_SUFFIX = /\s+(?:לרשימה|לרשימת הקניות|בבקשה|תודה|to the list|to my list|please)$/;
  const CONNECTORS = new Set(["של", "of"]);

  function numberValue(token) {
    if (/^\d+(?:[.,]\d+)?$/.test(token)) return token.replace(",", ".");
    return Object.prototype.hasOwnProperty.call(NUMBER_WORDS, token) ? NUMBER_WORDS[token] : null;
  }

  const tidy = (text) => String(text || "").replace(/\s+/g, " ").trim();

  /* ---------- One typed item, quantity optional at either end ---------- */
  function parseSingle(text) {
    const tokens = tidy(text).split(" ").filter(Boolean);
    if (tokens.length < 2) return { name: tokens.join(" "), quantity: "" };

    // Leading: "2 חלב", "2 ק״ג עגבניות", "חצי קילו גבינה", "קילו עגבניות"
    let num = numberValue(tokens[0]);
    if (num !== null) {
      let i = 1;
      let quantity = String(num);
      if (UNITS[tokens[i]] && tokens.length > i + 1) quantity += " " + UNITS[tokens[i++]];
      if (CONNECTORS.has(tokens[i]) && tokens.length > i + 1) i++;
      return { name: tokens.slice(i).join(" "), quantity };
    }
    if (STANDALONE_UNITS.has(tokens[0]) && tokens.length > 1) {
      let i = 1;
      if (CONNECTORS.has(tokens[i]) && tokens.length > i + 1) i++;
      return { name: tokens.slice(i).join(" "), quantity: "1 " + UNITS[tokens[0]] };
    }

    // Trailing: "חלב x2", "חלב ×2", "חלב 2", "עגבניות 2 ק״ג"
    const last = tokens[tokens.length - 1];
    const times = /^[x×]\s*(\d+)$/i.exec(last);
    if (times) return { name: tokens.slice(0, -1).join(" "), quantity: times[1] };
    if (UNITS[last] && tokens.length >= 3 && numberValue(tokens[tokens.length - 2]) !== null) {
      return { name: tokens.slice(0, -2).join(" "), quantity: `${numberValue(tokens[tokens.length - 2])} ${UNITS[last]}` };
    }
    if (/^\d+$/.test(last)) return { name: tokens.slice(0, -1).join(" "), quantity: last };

    return { name: tokens.join(" "), quantity: "" };
  }

  /* ---------- Dictated lists ---------- */
  function buildMatcher(vocabulary) {
    // Longest phrases first; each phrase is split into words.
    const phrases = [...new Set(vocabulary.map((v) => tidy(v).toLowerCase()).filter(Boolean))]
      .map((p) => p.split(" "))
      .sort((a, b) => b.length - a.length || b.join(" ").length - a.join(" ").length);

    // Length (in tokens) of the longest known phrase starting at tokens[i], or 0.
    // The last word only needs a prefix match ("עגבני" matches "עגבניות").
    return function matchAt(tokens, i) {
      for (const words of phrases) {
        if (i + words.length > tokens.length) continue;
        let ok = true;
        for (let k = 0; k < words.length && ok; k++) {
          const tok = tokens[i + k];
          ok = k === words.length - 1 ? tok.startsWith(words[k]) : tok === words[k];
        }
        if (ok) return words.length;
      }
      return 0;
    };
  }

  function parseSpoken(text, vocabulary = []) {
    let t = String(text || "")
      .toLowerCase()
      .replace(/[.!?;:]/g, ",")
      .replace(/\s+(?:and|וגם|ועוד)\s+/g, ",");
    // Trailing space so a lone command word ("תוסיף") is stripped too.
    t = tidy((tidy(t) + " ").replace(COMMAND_PREFIX, "")).replace(COMMAND_SUFFIX, "");

    const matchAt = buildMatcher(vocabulary);
    const items = [];

    t.split(",").map(tidy).filter(Boolean).forEach((chunk) => {
      const tokens = chunk.replace(COMMAND_PREFIX, "").split(" ").filter(Boolean);
      let current = null; // { words, quantity, knownHead }
      let pendingQty = "";

      const flush = () => {
        if (current && current.words.length) items.push({ name: current.words.join(" "), quantity: current.quantity });
        current = null;
      };

      for (let i = 0; i < tokens.length;) {
        // A leading "ו" is "and" when what follows is a known item / number, or
        // when the current item already has a known head ("ביצים וזיתים").
        const tok = tokens[i];
        if (tok.length > 2 && tok[0] === "ו" && !matchAt(tokens, i)) {
          const stripped = tok.slice(1);
          const probe = tokens.slice();
          probe[i] = stripped;
          if (numberValue(stripped) !== null || matchAt(probe, i) || (current && current.knownHead)) {
            tokens[i] = stripped;
            flush();
          }
        }

        const word = tokens[i];
        const num = numberValue(word);
        if (num !== null && i + 1 < tokens.length) {
          flush();
          pendingQty = String(num);
          i++;
          if (UNITS[tokens[i]] && i + 1 < tokens.length) pendingQty += " " + UNITS[tokens[i++]];
          if (CONNECTORS.has(tokens[i]) && i + 1 < tokens.length) i++;
          continue;
        }
        if (!current && !pendingQty && STANDALONE_UNITS.has(word) && i + 1 < tokens.length) {
          pendingQty = "1 " + UNITS[word];
          i++;
          if (CONNECTORS.has(tokens[i]) && i + 1 < tokens.length) i++;
          continue;
        }

        const known = matchAt(tokens, i);
        if (known) {
          flush();
          current = { words: tokens.slice(i, i + known), quantity: pendingQty, knownHead: true };
          pendingQty = "";
          i += known;
          continue;
        }

        // Unknown word: starts an item, or describes the current one ("שמן זית").
        if (!current) {
          current = { words: [word], quantity: pendingQty, knownHead: false };
          pendingQty = "";
        } else {
          current.words.push(word);
        }
        i++;
      }
      flush();
    });

    // Drop exact repeats ("חלב, חלב").
    const seen = new Set();
    return items.filter((it) => {
      const key = it.name.toLowerCase();
      if (!it.name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const api = { parseSingle, parseSpoken };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ItemParser = api;
})(typeof window !== "undefined" ? window : globalThis);
