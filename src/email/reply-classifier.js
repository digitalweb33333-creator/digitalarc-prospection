// ============================================================
// Classification des reponses prospects - regles FR, deterministe, sans IA
// ------------------------------------------------------------
// classifyReply({ subject, body }) -> {
//   category,    // une de CATEGORIES
//   confidence,  // "high" | "medium" | "low" | "none"
//   signals,     // libelles des indices detectes (pour la notif)
//   isStop,      // true si demande d'opt-out / desinscription
//   cleanBody,   // corps sans le texte cite (notre email d'origine)
// }
//
// Categories demandees : interested, price_objection, bad_timing, info_request.
// Categories internes en plus : unsubscribe (STOP), not_interested, unknown.
// ============================================================

export const CATEGORIES = {
  INTERESTED: "interested",
  PRICE: "price_objection",
  TIMING: "bad_timing",
  INFO: "info_request",
  UNSUBSCRIBE: "unsubscribe",
  NOT_INTERESTED: "not_interested",
  UNKNOWN: "unknown",
};

// Categories pour lesquelles on envoie une reponse automatique au prospect.
export const AUTO_REPLY_CATEGORIES = new Set([
  CATEGORIES.INTERESTED,
  CATEGORIES.PRICE,
  CATEGORIES.TIMING,
  CATEGORIES.INFO,
]);

const STOP_RE =
  /\b(stop|d[ée]sinscri|d[ée]sabonn|unsubscribe|ne plus.{0,15}contact|retir\w*.{0,15}(liste|adresse)|supprim\w*.{0,15}adresse)\b/i;

// "pas interesse" / "non merci" : refus poli, sans demande de STOP formelle.
const NOT_INTERESTED_RE =
  /\b(pas|aucun(?:e)?|plus|jamais)\s+(?:du tout\s+)?(?:int[ée]ress|preneur|besoin|concern)|non\s+merci|sans\s+suite|ne\s+(?:suis|sommes)\s+pas\s+int[ée]ress/i;

const PHONE_RE = /(?:(?:\+|00)\d{1,3}[\s.]?)?(?:0|\(0\))?[1-9](?:[\s.\-]?\d{2}){4}/;

// [regex, poids, libelle] par categorie
const RULES = {
  [CATEGORIES.INTERESTED]: [
    [/\boui\b/i, 2, "oui"],
    [/\b(?:[çc]a m'?int[ée]resse|int[ée]ress[ée]e?s?)\b/i, 2, "interesse"],
    [/\b(preneur|partant|volontiers|d'accord|ok pour|ca marche|[çc]a marche)\b/i, 2, "accord"],
    [/\b(envoy(?:ez|er|e)|montrez|aper[çc]u|maquette|exemple|d[ée]mo)\b/i, 1, "demande_exemple"],
    [/\b(devis|proposition|offre)\b/i, 1, "devis"],
    [/\b(rappel(?:ez|er)|appel(?:ez|er)|rendez[- ]vous|\brdv\b|cr[ée]neau|disponible|joindre)\b/i, 2, "appel/rdv"],
  ],
  [CATEGORIES.PRICE]: [
    [/\btrop (?:cher|[ée]lev[ée]|on[ée]reux)\b/i, 3, "trop_cher"],
    [/\b(pas les moyens|hors budget|budget (?:serr|limit))\b/i, 3, "budget"],
    [/\b(prix|tarif|co[uû]te?|co[uû]ts?|combien|on[ée]reux|honoraires|cher)\b/i, 1, "prix/tarif"],
  ],
  [CATEGORIES.TIMING]: [
    [/\b(pas le (?:bon )?moment|pas maintenant|pas en ce moment)\b/i, 3, "pas_le_moment"],
    [/\b(plus tard|ult[ée]rieur\w*|à la rentr[ée]e|l'ann[ée]e prochaine|dans (?:quelques|[0-9]+) (?:semaines|mois|ans))\b/i, 3, "plus_tard"],
    [/\b(recontact\w+|revenez vers moi|recontactez)\b/i, 2, "recontacter"],
    [/\b(trop occup[ée]|surcharg[ée]|d[ée]bord[ée])\b/i, 2, "occupe"],
  ],
  [CATEGORIES.INFO]: [
    [/\b(infos?|informations?|renseignements?|en savoir plus|davantage|pr[ée]cisions?|pr[ée]ciser)\b/i, 2, "plus_infos"],
    [/\b(comment [çc]a (?:marche|fonctionne)|c'est quoi|en quoi (?:consiste|[çc]a consiste)|qui [êe]tes[- ]vous|vous faites quoi)\b/i, 2, "question_offre"],
    [/\b(r[ée]f[ée]rences?|portfolio|r[ée]alisations?|d[ée]tails?|documentation|brochure)\b/i, 1, "references"],
  ],
};

// Retire le texte cite (notre email d'origine) pour ne classer que la reponse.
function stripQuoted(raw = "") {
  const text = String(raw).replace(/\r\n/g, "\n");
  const markers = [
    /^\s*Le\b.+\ba\s+[ée]crit\s*:/m, // "Le 10 juin 2026 à 09:00, X a écrit :"
    /^\s*On\b.+\bwrote:/m,
    /^\s*-{2,}\s*(?:Message d'origine|Original Message|Forwarded)/im,
    /^\s*De\s*:\s.+/m, // en-tete Outlook recopie
    /^\s*_{5,}\s*$/m, // separateur Outlook
    /^>.*$/m, // premiere ligne citee
  ];
  let cut = text.length;
  for (const re of markers) {
    const m = text.match(re);
    if (m && m.index !== undefined && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).trim();
}

export function classifyReply({ subject = "", body = "" } = {}) {
  const cleanBody = stripQuoted(body);
  // On classe surtout sur le nouveau texte ; le sujet aide un peu.
  const hay = `${subject}\n${cleanBody}`;

  if (STOP_RE.test(hay)) {
    return {
      category: CATEGORIES.UNSUBSCRIBE,
      confidence: "high",
      signals: ["stop"],
      isStop: true,
      cleanBody,
    };
  }

  if (NOT_INTERESTED_RE.test(hay)) {
    return {
      category: CATEGORIES.NOT_INTERESTED,
      confidence: "high",
      signals: ["refus_poli"],
      isStop: false,
      cleanBody,
    };
  }

  // Scoring pondere par categorie
  const scores = {};
  const signals = [];
  for (const [cat, rules] of Object.entries(RULES)) {
    let s = 0;
    for (const [re, weight, label] of rules) {
      if (re.test(hay)) {
        s += weight;
        signals.push(`${cat}:${label}`);
      }
    }
    scores[cat] = s;
  }
  // Bonus : numero de telephone dans la reponse = intention de contact forte
  if (PHONE_RE.test(cleanBody)) {
    scores[CATEGORIES.INTERESTED] += 2;
    signals.push("interested:telephone");
  }
  // Un "?" sans autre indice fort penche vers une demande d'info
  if (/\?/.test(cleanBody) && Object.values(scores).every((v) => v === 0)) {
    scores[CATEGORIES.INFO] += 1;
    signals.push("info_request:question");
  }

  // Choix : score max, depart-egalite par ordre de priorite
  const ORDER = [
    CATEGORIES.INTERESTED,
    CATEGORIES.PRICE,
    CATEGORIES.TIMING,
    CATEGORIES.INFO,
  ];
  let best = CATEGORIES.UNKNOWN;
  let bestScore = 0;
  for (const cat of ORDER) {
    if (scores[cat] > bestScore) {
      best = cat;
      bestScore = scores[cat];
    }
  }

  const confidence =
    bestScore >= 3 ? "high" : bestScore === 2 ? "medium" : bestScore === 1 ? "low" : "none";

  return {
    category: bestScore === 0 ? CATEGORIES.UNKNOWN : best,
    confidence,
    signals,
    isStop: false,
    cleanBody,
    scores,
  };
}
