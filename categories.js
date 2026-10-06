/*
 * Supermarket sections, automatic categorization and store-layout ordering.
 * Works in the browser (window.Categories) and in Node (for tests).
 */
(function (root) {
  "use strict";

  const LIST = [
    { key: "produce", label: "ירקות ופירות", emoji: "🥦" },
    { key: "bakery", label: "מאפייה", emoji: "🥖" },
    { key: "dairy", label: "חלב וביצים", emoji: "🧀" },
    { key: "meat", label: "בשר, עוף ודגים", emoji: "🍗" },
    { key: "frozen", label: "קפואים", emoji: "🧊" },
    { key: "pantry", label: "מזווה", emoji: "🥫" },
    { key: "snacks", label: "חטיפים ומתוקים", emoji: "🍫" },
    { key: "drinks", label: "משקאות", emoji: "🥤" },
    { key: "cleaning", label: "ניקיון ובית", emoji: "🧼" },
    { key: "hygiene", label: "פארם וטיפוח", emoji: "🧴" },
    { key: "misc", label: "כללי", emoji: "🛒" },
  ];
  const MAP = Object.fromEntries(LIST.map((c) => [c.key, c]));

  /*
   * Default walking path: produce at the entrance, dry goods through the middle
   * aisles, and chilled/frozen last so they stay cold on the way to the checkout.
   */
  const DEFAULT_STORE_ORDER = [
    "produce", "bakery", "pantry", "snacks", "drinks",
    "cleaning", "hygiene", "meat", "dairy", "frozen", "misc",
  ];

  /* A keyword matches at the start of a word (so "עגבני" matches "עגבניות"). Longest match wins. */
  const KEYWORDS = {
    produce: ["עגבני", "מלפפון", "חסה", "גזר", "תפוחי אדמה", "תפוח אדמה", "תפוח", "בננ", "תפוז", "קלמנטינ", "לימון", "בצל", "שום", "בטטה", "פלפל", "קישוא", "חציל", "כרוב", "ברוקולי", "כרובית", "אבוקדו", "ענב", "תות", "אבטיח", "מלון", "אגס", "אפרסק", "שזיף", "מנגו", "פטרוזיליה", "כוסברה", "שמיר", "נענע", "בזיליקום", "שומר", "פטריות", "תרד", "סלרי", "צנונ", "סלק", "דלעת", "ירקות", "פירות", "קולורבי", "תירס טרי"],
    bakery: ["לחם", "לחמני", "פיתה", "פיתות", "חלה", "חלות", "בגט", "טורטיה", "לאפה", "קרואסון", "מאפה", "מאפים", "עוגה", "עוגת", "רוגלך", "בייגל", "פוקצ'ה", "לחמניות", "כעך"],
    dairy: ["חלב סויה", "חלב שקדים", "חלב שיבולת שועל", "חלב", "גבינ", "קוטג", "יוגורט", "חמאה", "שמנת", "ביצים", "ביצה", "לבן", "לבנה", "מעדן", "משקה חלב", "מוצרלה", "בולגרית", "צפתית", "פודינג", "אשל", "גיל", "שוקו"],
    meat: ["עוף", "בקר", "הודו", "קציצות", "נקניק", "סלמון", "דג", "דגים", "פילה", "שניצל", "כבד", "המבורגר", "סטייק", "כרעיים", "שוקיים", "כנפיים", "חזה עוף", "פרגית", "טחון", "אנטריקוט", "צלי", "קבב", "אמנון", "מושט", "טונה טרי", "שווארמה"],
    frozen: ["קפוא", "קפואה", "קפואים", "גלידה", "גלידות", "ארטיק", "בורקס", "פיצה קפואה", "אפונה", "ירקות קפואים", "בצק עלים", "מלאווח", "ג'חנון", "קרח", "שניצל תירס"],
    pantry: ["אורז", "פסטה", "ספגטי", "קמח", "סוכר", "שמן", "מלח", "פלפל שחור", "תבלין", "פפריקה", "כמון", "קפה", "תה", "דגני בוקר", "קורנפלקס", "עדשים", "חומוס", "טחינה", "פתיתים", "קוסקוס", "קורנפלור", "רוטב סויה", "סויה", "רסק עגבניות", "רסק", "שימורים", "טונה", "תירס", "זיתים", "מלפפונים חמוצים", "חמוצים", "קטשופ", "מיונז", "חרדל", "דבש", "ריבה", "ממרח", "שקדים", "אגוזים", "בורגול", "קינואה", "שמרים", "אבקת אפייה", "וניל", "קקאו", "חומץ", "פירורי לחם", "נודלס", "מרק"],
    snacks: ["שוקולד", "במבה", "ביסלי", "חטיף", "חטיפים", "צ'יפס", "צ׳יפס", "ביסקוויט", "עוגיות", "עוגייה", "סוכריות", "מסטיק", "וופל", "קרקר", "פריכיות", "בייגלה", "פופקורן", "גרעינים", "תפוצ'יפס", "קליק", "פסק זמן", "מרשמלו"],
    drinks: ["מיץ תפוזים", "מיץ ענבים", "מיץ תפוחים", "מיץ אשכוליות", "מים", "מיץ", "קולה", "סודה", "בירה", "יין", "משקה", "משקאות", "תרכיז", "פטל", "ספרייט", "פאנטה", "נביעות", "מים מינרליים", "אייס קפה", "וודקה", "ערק", "תירוש", "לימונדה", "סחוט"],
    cleaning: ["סבון כלים", "נוזל כלים", "אקונומיקה", "נייר טואלט", "מגבונים", "שקיות אשפה", "שקיות זבל", "מרכך כביסה", "אבקת כביסה", "ג'ל כביסה", "מרכך", "מטהר", "ספריי", "מגבות נייר", "מגבת נייר", "כלור", "ספוג", "ספוגים", "סקוטש", "נייר כסף", "נייר אפייה", "ניילון נצמד", "שקיות", "טבליות למדיח", "מדיח", "סנו", "מסיר שומנים", "נוזל רצפות", "סמרטוט", "כפפות", "סוללות", "נורה", "מפיות", "צלחות חד פעמיות", "כוסות חד פעמיות"],
    hygiene: ["שמפו", "מרכך שיער", "משחת שיניים", "מברשת שיניים", "דאודורנט", "ג'ל רחצה", "סבון גוף", "סבון ידיים", "סבון", "חיתולים", "טיטולים", "מגבונים לחים", "תחבושות", "טמפונים", "קרם", "קרם הגנה", "אקמול", "נורופן", "אדוויל", "ויטמין", "פלסטר", "פלסטרים", "תרופה", "תרופות", "סכיני גילוח", "קצף גילוח", "צמר גפן", "מקלוני אוזניים", "מי פה", "חוט דנטלי", "לק", "בושם"],
  };

  // Flatten once: [{ keyword, category }] sorted longest first.
  const KEYWORD_INDEX = Object.entries(KEYWORDS)
    .flatMap(([category, words]) => words.map((keyword) => ({ keyword, category })))
    .sort((a, b) => b.keyword.length - a.keyword.length);

  const normalize = (text) =>
    String(text || "").toLowerCase().replace(/[׳']/g, "'").replace(/["״,.!?]/g, " ").replace(/\s+/g, " ").trim();

  /* Word index where `keyword` starts a word in `text` (Hebrew prefixes ה/ו/וה allowed), or -1. */
  const PREFIXES = ["", "ה", "ו", "וה"];
  function wordPosition(text, keyword) {
    const padded = " " + text;
    let best = -1;
    for (const p of PREFIXES) {
      const at = padded.indexOf(" " + p + keyword);
      if (at !== -1 && (best === -1 || at < best)) best = at;
    }
    return best === -1 ? -1 : padded.slice(0, best).split(" ").length - 1;
  }

  /*
   * Per-item icons ("חלב" -> 🥛). Same matching rules as categorize(): a keyword
   * starts a word, the earliest match wins ("שוקולד חלב" -> 🍫), and items with no
   * specific icon fall back to their section's emoji.
   */
  const ITEM_EMOJI = {
    "🥛": ["חלב", "שמנת", "משקה חלב", "שוקו"],
    "🧀": ["גבינ", "קוטג", "מוצרלה", "בולגרית", "צפתית", "פרמזן", "לבנה"],
    "🥚": ["ביצים", "ביצה"],
    "🧈": ["חמאה", "מרגרינה"],
    "🍦": ["גלידה", "גלידות", "ארטיק"],
    "🍞": ["לחם", "חלה", "חלות", "טוסט"],
    "🥖": ["בגט", "באגט"],
    "🥯": ["בייגל", "לחמני"],
    "🥐": ["קרואסון", "מאפה", "מאפים", "רוגלך"],
    "🫓": ["פיתה", "פיתות", "לאפה", "טורטיה", "מלאווח"],
    "🍰": ["עוגה", "עוגת"],
    "🍪": ["עוגיות", "עוגייה", "ביסקוויט", "וופל"],
    "🍅": ["עגבני", "רסק עגבניות", "קטשופ"],
    "🥒": ["מלפפון", "קישוא", "חמוצים"],
    "🥬": ["חסה", "כרוב", "תרד"],
    "🥕": ["גזר"],
    "🥔": ["תפוחי אדמה", "תפוח אדמה", "תפו\"א"],
    "🍎": ["תפוח", "תפוחים"],
    "🍌": ["בננ"],
    "🍊": ["תפוז", "קלמנטינ", "מנדרינ", "אשכולית"],
    "🍋": ["לימון", "לימונים"],
    "🧅": ["בצל"],
    "🧄": ["שום"],
    "🍠": ["בטטה"],
    "🫑": ["פלפל"],
    "🍆": ["חציל"],
    "🥦": ["ברוקולי", "כרובית", "ירקות"],
    "🥑": ["אבוקדו"],
    "🍇": ["ענב"],
    "🍓": ["תות"],
    "🍉": ["אבטיח"],
    "🍈": ["מלון"],
    "🍐": ["אגס"],
    "🍑": ["אפרסק", "נקטרינ"],
    "🍒": ["דובדבן", "דובדבנים"],
    "🥭": ["מנגו"],
    "🍍": ["אננס"],
    "🥝": ["קיווי"],
    "🥥": ["קוקוס"],
    "🍄": ["פטריות", "פטרייה"],
    "🌽": ["תירס"],
    "🫛": ["אפונה", "שעועית ירוקה"],
    "🌿": ["פטרוזיליה", "כוסברה", "שמיר", "נענע", "בזיליקום", "רוזמרין", "טימין"],
    "🫚": ["ג'ינג'ר", "גינגר"],
    "🎃": ["דלעת"],
    "🍗": ["עוף", "חזה עוף", "כרעיים", "שוקיים", "כנפיים", "פרגית", "שניצל", "הודו"],
    "🥩": ["בקר", "סטייק", "אנטריקוט", "טחון", "צלי", "פילה בקר", "כבד", "קבב"],
    "🍔": ["המבורגר"],
    "🌭": ["נקניק", "נקניקיות", "נקניקייה"],
    "🐟": ["דג", "דגים", "סלמון", "אמנון", "מושט", "טונה", "בורי", "לברק", "דניס"],
    "🦐": ["שרימפס"],
    "🍕": ["פיצה"],
    "🍚": ["אורז"],
    "🍝": ["פסטה", "ספגטי", "פתיתים", "נודלס"],
    "🌾": ["קמח", "שיבולת שועל", "קוואקר"],
    "🥣": ["דגני בוקר", "קורנפלקס", "גרנולה", "יוגורט", "מעדן"],
    "🫘": ["חומוס", "עדשים", "שעועית", "גרגירי"],
    "🫒": ["שמן זית", "זיתים", "שמן"],
    "🧂": ["מלח", "פלפל שחור", "תבלין", "תבלינים", "פפריקה", "כמון"],
    "🍯": ["דבש", "ריבה", "סילאן"],
    "☕": ["קפה", "נס קפה", "אייס קפה"],
    "🍵": ["תה"],
    "🍫": ["שוקולד", "ממרח שוקולד", "קקאו", "פסק זמן"],
    "🥜": ["במבה", "בוטנים", "חמאת בוטנים", "שקדים", "אגוזים", "קשיו", "פיסטוק"],
    "🥨": ["ביסלי", "בייגלה", "קרקר"],
    "🍟": ["צ'יפס", "תפוצ'יפס"],
    "🍿": ["פופקורן"],
    "🍬": ["סוכריות", "סוכרייה", "מרשמלו", "מסטיק"],
    "💧": ["מים", "מים מינרליים", "נביעות"],
    "🧃": ["מיץ", "תרכיז", "פטל", "סחוט", "לימונדה"],
    "🥤": ["קולה", "סודה", "ספרייט", "פאנטה", "משקה"],
    "🍺": ["בירה"],
    "🍷": ["יין", "תירוש"],
    "🥃": ["וודקה", "ערק", "וויסקי"],
    "🧊": ["קרח", "קפוא", "קפואה", "קפואים"],
    "🧻": ["נייר טואלט", "מגבות נייר", "מגבת נייר", "מפיות", "טישו"],
    "🧽": ["ספוג", "ספוגים", "סקוטש", "סבון כלים", "נוזל כלים"],
    "🧼": ["סבון", "סבון ידיים", "ג'ל רחצה"],
    "🧺": ["אבקת כביסה", "ג'ל כביסה", "מרכך כביסה"],
    "🧪": ["אקונומיקה", "כלור", "מסיר שומנים", "נוזל רצפות"],
    "🗑️": ["שקיות אשפה", "שקיות זבל"],
    "🧴": ["שמפו", "מרכך שיער", "קרם", "קרם הגנה", "דאודורנט", "קצף גילוח"],
    "🪥": ["משחת שיניים", "מברשת שיניים", "חוט דנטלי", "מי פה"],
    "👶": ["חיתולים", "טיטולים", "מגבונים לחים", "תמ\"ל", "מטרנה"],
    "💊": ["אקמול", "נורופן", "אדוויל", "ויטמין", "תרופה", "תרופות"],
    "🩹": ["פלסטר", "פלסטרים", "תחבושות"],
    "🔋": ["סוללות", "סוללה"],
    "💡": ["נורה", "נורות"],
    "🕯️": ["נרות", "נר"],
    "💐": ["פרחים"],
    "🐶": ["אוכל לכלב", "אוכל לכלבים"],
    "🐱": ["אוכל לחתול", "אוכל לחתולים", "חול לחתול"],
  };
  const EMOJI_INDEX = Object.entries(ITEM_EMOJI)
    .flatMap(([emoji, words]) => words.map((keyword) => ({ keyword: normalize(keyword), emoji })))
    .sort((a, b) => b.keyword.length - a.keyword.length);

  function emojiFor(name, category) {
    const n = normalize(name);
    let best = null;
    if (n) {
      for (const entry of EMOJI_INDEX) {
        const pos = wordPosition(n, entry.keyword);
        if (pos === -1) continue;
        if (!best || pos < best.pos) best = { pos, emoji: entry.emoji };
        if (pos === 0) break;
      }
    }
    if (best) return best.emoji;
    return (MAP[category || categorize(name)] || MAP.misc).emoji;
  }

  /* Categories the user picked by hand, remembered per item name. */
  let learned = {};

  /*
   * Hebrew puts the head noun first ("מיץ תפוזים" is juice, "שוקולד חלב" is chocolate),
   * so the keyword found earliest in the name wins; ties go to the longest keyword
   * ("פלפל שחור" beats "פלפל").
   */
  function categorize(name) {
    const n = normalize(name);
    if (!n) return "misc";
    if (learned[n] && MAP[learned[n]]) return learned[n];
    let best = null;
    for (const entry of KEYWORD_INDEX) {
      const pos = wordPosition(n, entry.keyword);
      if (pos === -1) continue;
      if (!best || pos < best.pos) best = { pos, category: entry.category }; // index is longest-first
      if (pos === 0) break;
    }
    return best ? best.category : "misc";
  }

  function learn(name, category) {
    const n = normalize(name);
    if (!n || !MAP[category]) return;
    learned[n] = category;
  }

  /* All known item words, for the voice parser's segmentation. */
  const vocabulary = () => KEYWORD_INDEX.map((k) => k.keyword);

  /* Keep a saved order valid if categories are added/removed in a later version. */
  function sanitizeOrder(order) {
    const valid = (Array.isArray(order) ? order : []).filter((k) => MAP[k]);
    const unique = [...new Set(valid)];
    DEFAULT_STORE_ORDER.forEach((k) => { if (!unique.includes(k)) unique.push(k); });
    return unique;
  }

  const api = {
    LIST,
    MAP,
    DEFAULT_STORE_ORDER,
    categorize,
    emojiFor,
    learn,
    get learned() { return learned; },
    set learned(value) { learned = value && typeof value === "object" ? value : {}; },
    normalize,
    vocabulary,
    sanitizeOrder,
    get: (key) => MAP[key] || MAP.misc,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Categories = api;
})(typeof window !== "undefined" ? window : globalThis);
