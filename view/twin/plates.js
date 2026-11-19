/* Licence plates in each country's real format, in the mix learned from the 2026 gate passes
   (VEHICLE_NO patterns, see ml/learn.py PLATE_RULES). Only the format is reproduced: the
   numbers are random, never copied from the data. */

const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const digits = (n, lead = true) => {
  let s = lead ? String(1 + rnd(9)) : String(rnd(10));
  while (s.length < n) s += rnd(10);
  return s;
};

/* Saudi plates use 17 letters, each with a fixed Latin twin printed beside it. */
const SA_AR = ["ا", "ب", "ح", "د", "ر", "س", "ص", "ط", "ع", "ق", "ك", "ل", "م", "ن", "ه", "و", "ى"];
const SA_EN = ["A", "B", "J", "D", "R", "S", "X", "T", "E", "G", "K", "L", "Z", "N", "H", "U", "V"];
const OM_AR = ["ا", "ب", "د", "ر", "س", "ص", "ط", "ع", "ك", "م", "ن", "ه", "و", "ي", "ح"];
const AE = [["Dubai", "دبي", "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")], ["Sharjah", "الشارقة", ["1", "2", "3", "4"]], ["Abu Dhabi", "أبوظبي", ["1", "2", "4", "5", "6", "7", "8", "10", "11", "12", "13", "14", "15", "16", "17", "50"]], ["Ajman", "عجمان", ["A", "B", "C", "D", "E", "H"]], ["Ras Al Khaimah", "رأس الخيمة", ["A", "B", "C", "D", "I", "K", "M", "N", "S", "V", "Y"]]];
const TR = ["31", "27", "33", "41", "34", "06", "01", "42"];

export const COUNTRY = {
  QA: { en: "Qatar", ar: "قطر", code: "QA" },
  SA: { en: "Saudi Arabia", ar: "السعودية", code: "KSA" },
  KW: { en: "Kuwait", ar: "الكويت", code: "KWT" },
  OM: { en: "Oman", ar: "عُمان", code: "OM" },
  AE: { en: "United Arab Emirates", ar: "الإمارات", code: "UAE" },
  TR: { en: "Türkiye", ar: "تركيا", code: "TR" },
  XX: { en: "Other", ar: "أخرى", code: "" },
};

/* { text: what the card shows, ar: Arabic line where the plate has one, country, note: the rule } */
export function makePlate(country) {
  switch (country) {
    case "SA": {
      const idx = [rnd(17), rnd(17), rnd(17)];
      const num = digits(4);
      return { country, text: `${num} ${idx.map((i) => SA_EN[i]).join(" ")}`, ar: `${idx.map((i) => SA_AR[i]).reverse().join(" ")} ${num}`, rule: "4 digits + 3 of the 17 Saudi letters" };
    }
    case "KW": {
      const pre = pick(["91", "95", "93", "90", "1", "2", "3", "5"]);
      return { country, text: `${pre}/${digits(5)}`, rule: "governorate code / 5 digits" };
    }
    case "OM": {
      const n = digits(Math.random() < 0.8 ? 4 : 3);
      const l = Math.random() < 0.85 ? [pick(OM_AR), pick(OM_AR)] : [pick(OM_AR)];
      return { country, text: n, ar: `${n} ${l.join(" ")}`, rule: "up to 5 digits + 1-2 Arabic letters" };
    }
    case "AE": {
      const [en, ar, codes] = Math.random() < 0.6 ? AE[0] : pick(AE);
      const code = pick(codes);
      return { country, text: `${code}/${digits(5)}`, emirate: en, ar, rule: `${en}: code + up to 5 digits` };
    }
    case "TR": {
      const L = "ABCDEFGHJKLMNPRSTUVYZ";
      const n = 1 + rnd(3);
      let letters = "";
      for (let i = 0; i < n; i += 1) letters += L[rnd(L.length)];
      return { country, text: `${pick(TR)} ${letters} ${digits(n === 1 ? 4 : 3, false)}`, rule: "province + letters + digits" };
    }
    case "QA":
    default:
      return { country: "QA", text: digits(Math.random() < 0.8 ? 5 : 6), rule: "numbers only, up to 6 digits" };
  }
}

/* Draw a country from the learned shares ({QA: 39.6, SA: 38, ...}). */
export function drawCountry(shares) {
  const entries = Object.entries(shares || { QA: 100 }).filter(([k]) => COUNTRY[k] && k !== "XX");
  const sum = entries.reduce((s, [, v]) => s + v, 0);
  let r = Math.random() * sum;
  for (const [k, v] of entries) if ((r -= v) <= 0) return k;
  return "QA";
}
