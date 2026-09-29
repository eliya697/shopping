const assert = require("assert");
const Cat = require("../categories.js");
const P = require("../item-parser.js");

let failures = 0;
function check(label, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); console.log("ok  ", label); }
  catch (e) { failures++; console.log("FAIL", label, "\n     got     ", JSON.stringify(actual), "\n     expected", JSON.stringify(expected)); }
}

// ---- categorize
const cats = {
  "עגבניות": "produce", "לחם": "bakery", "פיתות": "bakery", "חלב": "dairy", "שוקולד חלב": "snacks",
  "חזה עוף": "meat", "גלידה": "frozen", "אורז": "pantry", "פירורי לחם": "pantry", "במבה": "snacks",
  "מים מינרליים": "drinks", "מיץ תפוזים": "drinks", "נוזל כלים": "cleaning", "מרכך כביסה": "cleaning",
  "מרכך שיער": "hygiene", "שמפו": "hygiene", "אקמול": "hygiene", "סבון כלים": "cleaning",
  "חמים": "misc", "פלפל שחור": "pantry", "פלפל אדום": "produce", "סוכריות": "snacks", "סוכר": "pantry",
  "והחלב": "dairy", "Milk": "misc", "קוטג' 5%": "dairy", "גבינה צהובה": "dairy", "טונה": "pantry",
};
for (const [name, cat] of Object.entries(cats)) check(`categorize ${name}`, Cat.categorize(name), cat);
Cat.learned = { "גבינה צהובה": "misc" };
check("learned override", Cat.categorize("גבינה צהובה"), "misc");
Cat.learned = {};
check("sanitizeOrder fills missing", Cat.sanitizeOrder(["dairy", "bogus", "dairy"]).slice(0, 2), ["dairy", "produce"]);
check("sanitizeOrder length", Cat.sanitizeOrder([]).length, Cat.LIST.length);

// ---- parseSingle
const singles = {
  "חלב": { name: "חלב", quantity: "" },
  "2 חלב": { name: "חלב", quantity: "2" },
  "2 ק״ג עגבניות": { name: "עגבניות", quantity: "2 ק״ג" },
  "חצי קילו גבינה": { name: "גבינה", quantity: "½ ק״ג" },
  "קילו עגבניות": { name: "עגבניות", quantity: "1 ק״ג" },
  "חלב x2": { name: "חלב", quantity: "2" },
  "חלב ×3": { name: "חלב", quantity: "3" },
  "ביצים 12": { name: "ביצים", quantity: "12" },
  "עגבניות 2 קילו": { name: "עגבניות", quantity: "2 ק״ג" },
  "חלב 3%": { name: "חלב 3%", quantity: "" },
  "חלב 3 אחוז": { name: "חלב 3 אחוז", quantity: "" },
  "3 חבילות של טיטולים": { name: "טיטולים", quantity: "3 חבילות" },
  "שקיות אשפה": { name: "שקיות אשפה", quantity: "" },
  "7": { name: "7", quantity: "" },
};
for (const [text, exp] of Object.entries(singles)) check(`single "${text}"`, P.parseSingle(text), exp);

// ---- parseSpoken
const vocab = Cat.vocabulary();
const names = (t, v = vocab) => P.parseSpoken(t, v).map((i) => (i.quantity ? `${i.quantity}|${i.name}` : i.name));
check("commas + ו", names("תוסיף חלב, ביצים ועגבניות"), ["חלב", "ביצים", "עגבניות"]);
check("no punctuation", names("תוסיף חלב ביצים ועגבניות"), ["חלב", "ביצים", "עגבניות"]);
check("modifier stays", names("שמן זית ולחם"), ["שמן זית", "לחם"]);
check("unknown after known head joins with ו", names("ביצים וזיתים ירוקים"), ["ביצים", "זיתים ירוקים"]);
check("unknown head keeps ו-word", names("תמצית ורדים"), ["תמצית ורדים"]);
check("numbers + units", names("שני קילו עגבניות ושלושה מלפפונים"), ["2 ק״ג|עגבניות", "3|מלפפונים"]);
check("standalone unit", names("קילו תפוחים וחלב"), ["1 ק״ג|תפוחים", "חלב"]);
check("וגם separator", names("צריך נייר טואלט וגם סבון כלים"), ["נייר טואלט", "סבון כלים"]);
check("suffix stripped", names("תוסיף במבה לרשימה"), ["במבה"]);
check("english", names("add milk, eggs and tomatoes"), ["milk", "eggs", "tomatoes"]);
check("english numbers", names("Add two bottles of water and bread"), ["2 bottles|water", "bread"]);
check("dedupe", names("חלב, חלב"), ["חלב"]);
check("compounds", names("מיץ תפוזים וחלב סויה"), ["מיץ תפוזים", "חלב סויה"]);
check("without history splits", names("יוגורט תות וחלב"), ["יוגורט", "תות", "חלב"]);
check("history phrase", names("יוגורט תות וחלב", [...vocab, "יוגורט תות"]), ["יוגורט תות", "חלב"]);
check("categorize head-first", Cat.categorize("יוגורט תות"), "dairy");
check("empty", names("תוסיף"), []);
check("ורד unknown first word", names("ורדים"), ["ורדים"]);

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PARSER TESTS PASSED");
process.exit(failures ? 1 : 0);
