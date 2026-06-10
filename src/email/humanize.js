// ============================================================
// Triple-passe d'humanisation (anti AI-slop) - NATIF, deterministe
// ------------------------------------------------------------
// Remplace l'idee des 3 skills externes (anti-ai-slop / humanizer /
// avoid-ai-writing) par 3 passes locales, sans dependance ni code tiers :
//   Passe 1 - cliches & tournures IA typiques (FR) -> supprimes/reformules
//   Passe 2 - format (tirets longs, listes, emojis, doubles espaces)
//   Passe 3 - ouvertures/cloture generiques d'IA -> coupees
//
// humanize(text) renvoie { text, slopScore, hits } ou slopScore = nb de
// patterns IA detectes AVANT nettoyage (0 = deja humain).
// ============================================================

// Cliches / tournures qui "sentent" l'IA en francais
const CLICHES = [
  [/\bn'h[ée]sitez pas (?:[àa] )?/gi, ""],
  [/\bdans (?:un|le) monde (?:où|ou) [^.,;]+[.,;]/gi, ""],
  [/\b[àa] l'[ée]re (?:du|de la) num[ée]rique\b/gi, "aujourd'hui"],
  [/\bdans le paysage num[ée]rique actuel\b/gi, "aujourd'hui"],
  [/\bforce est de constater (?:que )?/gi, ""],
  [/\bil est important de (?:noter|souligner) que\b/gi, ""],
  [/\bil convient de (?:noter|souligner)\b/gi, ""],
  [/\bj'esp[èe]re que ce (?:message|mail|email|courriel) vous trouve(?:ra)? (?:bien|en bonne sant[ée])[.,]?/gi, ""],
  [/\bje me permets de vous (?:contacter|[ée]crire)[ ,]*/gi, ""],
  [/\bv[ée]ritable(?:ment)?\b/gi, ""],
  [/\bsolution(s)? cl[ée]s? en main\b/gi, "site"],
  [/\bbooster\b/gi, "augmenter"],
  [/\boptimiser votre pr[ée]sence en ligne\b/gi, "vous rendre visible"],
  [/\bde nos jours\b/gi, "aujourd'hui"],
  [/\bn'attendez plus\b/gi, ""],
  [/\bplongez? dans\b/gi, ""],
];

// Ouvertures/cl[ô]tures generiques d'IA a couper
const GENERIC_LINES = [
  /^\s*en tant que .+,\s*/i,
  /^\s*cordialement,?\s*$/i,
];

function pass1(text) {
  let t = text;
  for (const [re, rep] of CLICHES) t = t.replace(re, rep);
  return t;
}

function pass2(text) {
  return text
    // NOTE: regles desactivees a la demande (on conserve les tirets longs — et les points de suspension ...)
    //   .replace(/\s+—\s+/g, ", ")   // tiret long -> virgule  (DESACTIVE)
    //   .replace(/—/g, "-")          // tiret long -> tiret    (DESACTIVE)
    //   .replace(/\.{2,}/g, ".")     // ... -> .               (DESACTIVE)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "") // emojis
    .replace(/[ \t]{2,}/g, " ") // doubles espaces
    // ponctuation orpheline laissee par les suppressions de cliches
    .replace(/,\s*,+/g, ",")
    .replace(/\s+,/g, ",")
    .replace(/,\s*\./g, ".")
    .replace(/([:;])\s*([.,])/g, "$1")
    .replace(/^([ \t]*)[,;:]\s*/gm, "$1") // virgule en debut de ligne
    .replace(/ \./g, ".")
    .replace(/\n{3,}/g, "\n\n"); // max 1 ligne vide
}

function pass3(text) {
  return text
    .split("\n")
    .filter((line) => !GENERIC_LINES.some((re) => re.test(line.trim()) && line.trim().length < 40))
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

// Compte les patterns IA presents avant nettoyage (indicateur de "slop")
function scoreSlop(text) {
  let n = 0;
  for (const [re] of CLICHES) {
    const m = text.match(re);
    if (m) n += m.length;
  }
  n += (text.match(/—/g) || []).length;
  n += (text.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu) || []).length;
  return n;
}

export function humanize(text) {
  const slopScore = scoreSlop(text);
  // 3 passes, deux tours pour rattraper ce que le 1er laisse passer
  let t = text;
  for (let i = 0; i < 2; i++) t = pass3(pass2(pass1(t)));
  return { text: t, slopScore };
}
