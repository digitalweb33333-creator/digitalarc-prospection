// ============================================================
// Modeles de reponse automatique par categorie
// ------------------------------------------------------------
// buildReply(category, prospect, { incomingSubject }) ->
//   { subject, text, html }  ou  null  (categorie sans reponse auto).
//
// Voix : Joachim / Digitalarc, ton humain (humanize), avec opt-out RGPD.
// Reprend la signature et le footer des emails existants (followups /
// generate-emails) sans les modifier.
// ============================================================
import { professions } from "../lib/config.js";
import { humanize } from "./humanize.js";
import { CATEGORIES } from "./reply-classifier.js";

const profById = Object.fromEntries(professions.map((p) => [p.id, p]));

const sender = {
  website: process.env.SENDER_WEBSITE || "https://digitalarc.fr",
  logoUrl: process.env.SENDER_LOGO_URL || "",
  replyTo: process.env.SENDER_REPLY_TO || "contact@digitalarc.fr",
};

// "Re: ..." propre (sans empiler les Re:)
function reSubject(s = "") {
  const base = String(s).replace(/^(\s*re\s*:\s*)+/i, "").trim() || "votre demande";
  return `Re: ${base}`;
}

// Mots indiquant un nom d'entreprise (pas une personne) -> pas de prénom.
const BUSINESS_RE =
  /\b(cabinet|clinique|centre|pharmacie|restaurant|brasserie|pizz\w*|garage|sarl|sasu|sas|eurl|selarl|scp|sci|s\.?a\b|soci[ée]t[ée]|entreprise|ets|[ée]tablissement|agence|atelier|boulangerie|p[âa]tisserie|boucherie|institut|maison|studio|groupe|group|menuiserie|toiture|couverture|charpente|plomberie|chauffage|[ée]lectricit[ée]|coiffure|salon|boutique|magasin|immobilier|assurance|notaire|[ée]tude|h[ôo]tel|spa|optique|opticien|laboratoire|labo|ambulance|taxi|auto|services?|consulting|conseil|fitness|[ée]cole|cr[èe]che|b[âa]timent|construction|r[ée]novation|jardin|paysag\w*|transport|nettoyage|d[ée]m[ée]nag\w*)\b/i;

// Civilités / titres à retirer avant extraction.
const HONORIFIC_RE = /\b(dr|docteur|pr|professeur|me|ma[îi]tre|mr|m|mme|mlle|monsieur|madame|mademoiselle)\.?\b/gi;

// Met en casse "Prénom" en gérant traits d'union et apostrophes (Jean-Pierre, N'Guyen).
const toName = (w) =>
  w.toLowerCase().replace(/(^|[-'’])([a-zà-öø-ÿ])/g, (_, sep, c) => sep + c.toUpperCase());

// Prénoms français courants (sans accents) pour lever l'ambiguïté d'ordre
// "Nom Prénom" vs "Prénom Nom" quand rien d'autre ne tranche.
const FIRST_NAMES = new Set([
  "jean","pierre","paul","jacques","michel","andre","philippe","alain","bernard","claude",
  "daniel","patrick","nicolas","christophe","laurent","stephane","pascal","eric","frederic",
  "david","julien","thomas","olivier","sebastien","vincent","antoine","alexandre","maxime",
  "guillaume","romain","quentin","clement","hugo","lucas","theo","mathis","nathan","enzo",
  "louis","gabriel","raphael","arthur","jules","adam","noah","ethan","tom","leo","timothee",
  "baptiste","mathieu","damien","cedric","fabien","gregory","jerome","ludovic","sylvain",
  "yann","yannick","gaetan","florian","jonathan","kevin","mickael","anthony","jordan","dylan",
  "francois","gerard","robert","henri","georges","marcel","rene","roger","gilbert","didier",
  "denis","franck","herve","joel","lionel","marc","mathias","maxence","remi","samuel","simon",
  "valentin","victor","william","xavier","aurelien","benjamin","bruno","charles","emmanuel",
  "gilles","guy","jean-pierre","jean-claude","jean-paul","jean-luc","jean-michel","jean-marc",
  "marie","nathalie","isabelle","sylvie","catherine","francoise","martine","christine",
  "monique","nicole","anne","sophie","celine","valerie","sandrine","stephanie","veronique",
  "caroline","aurelie","julie","emilie","laure","laetitia","virginie","camille","manon",
  "lea","chloe","emma","sarah","laura","marine","pauline","oceane","ines","jade","louise",
  "alice","clara","anais","melanie","elodie","audrey","amelie","charlotte","mathilde",
  "claire","helene","beatrice","brigitte","danielle","florence","jacqueline","karine",
  "patricia","chantal","corinne","delphine","fanny","gaelle","lucie","magali","myriam",
  "sabrina","severine","solene","carole","agnes","annie","colette","genevieve","simone",
  "suzanne","fatima","karim","mohamed","mehdi","sofia","nadia","leila","yasmine","sonia",
]);

const normName = (w) =>
  w.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/['’].*/, "");
const isFirstName = (w) => {
  const n = normName(w);
  return FIRST_NAMES.has(n) || FIRST_NAMES.has(n.split("-")[0]);
};

// Extrait un prénom plausible depuis le titre quand c'est un nom de personne.
// Renvoie "" si on n'est pas sûr (nom d'entreprise, ambigu, un seul mot...).
function extractFirstName(title) {
  if (!title) return "";
  // coupe sur un séparateur : tiret ENTOURÉ d'espaces, |, virgule, parenthèse
  // (on ne casse pas les prénoms composés type "Jean-Pierre")
  let t = String(title).split(/\s[-–—]\s|[|,(]/)[0].trim();
  if (BUSINESS_RE.test(t)) return "";
  t = t.replace(HONORIFIC_RE, " ").trim();

  const tokens = t
    .split(/\s+/)
    .filter((w) => /^[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’-]*$/.test(w));
  if (tokens.length < 2) return ""; // un seul mot = trop incertain

  // 1) Un token reconnu comme prénom courant tranche tout de suite
  const known = tokens.filter(isFirstName);
  if (known.length === 1) return toName(known[0]);

  // 2) NOM en MAJUSCULES + Prénom : le token NON majuscule est le prénom
  const isUpper = (w) => w === w.toUpperCase() && /[A-ZÀ-Ö]/.test(w);
  const upper = tokens.filter(isUpper);
  if (upper.length === tokens.length) return ""; // tout en majuscules = ordre ambigu
  if (upper.length >= 1) return toName(tokens.find((w) => !isUpper(w)));

  // 3) "Prénom Nom" tout en Titlecase, prénom inconnu : on suppose l'ordre occidental
  return toName(tokens[0]);
}

// Prénom du contact : champ CRM explicite, sinon extraction depuis le titre.
function greeting(p) {
  const explicit = (p.first_name || p.prenom || p.contact_first_name || "").toString().trim();
  const prenom = explicit || extractFirstName(p.title);
  return prenom ? `Bonjour ${prenom},` : "Bonjour,";
}

// 2 templates seulement (avant humanisation) :
//   A - interested / price_objection / info_request : questions de qualification
//   B - bad_timing : on revient plus tard
function bodyFor(category, p) {
  const link = sender.website.replace(/^https?:\/\//, "");

  // Template B - pas le bon moment
  if (category === CATEGORIES.TIMING) {
    return `Bonjour,

Pas de souci, je comprends. Je note de revenir vers vous plus tard : dites-moi juste la période qui vous conviendrait (dans un mois ? à la rentrée ?) et je m'aligne dessus, sans vous relancer entre-temps.

En attendant, vous pouvez jeter un œil à mes réalisations sur ${link}. Au plaisir d'échanger le moment venu.`;
  }

  // Template A - intéressé / demande d'info / objection prix
  if (
    category === CATEGORIES.INTERESTED ||
    category === CATEGORIES.PRICE ||
    category === CATEGORIES.INFO
  ) {
    return `${greeting(p)}

Merci pour votre retour, je suis ravi de l'intérêt que vous portez à Digitalarc.

Pour vous préparer une proposition adaptée à votre activité, j'aurais besoin de quelques informations rapides :

1. Avez-vous déjà un site web ? Si oui, quelle est l'adresse ?
2. Combien de pages souhaitez-vous ? (Accueil, Services, À propos, Contact = 4 pages de base — vous en voulez plus ?)
3. Quels services souhaitez-vous mettre en avant ?
4. Avez-vous déjà un logo ?
5. Avez-vous des textes/contenu rédigé ou souhaitez-vous que je m'en occupe ?

Répondez simplement à ces questions et je vous prépare une proposition adaptée.`;
  }

  return null;
}

export function buildReply(category, p, { incomingSubject } = {}) {
  const raw = bodyFor(category, p);
  if (raw === null) return null; // categorie non auto-repondue

  const link = sender.website.replace(/^https?:\/\//, "");
  // Opt-out fonctionnel : mailto pre-rempli STOP (capte par watch-replies).
  const optoutUrl = `mailto:${sender.replyTo}?subject=STOP`;
  const sig = `Joachim\nDigitalarc — ${link}`;
  const footer = `Pour ne plus être contacté, répondez simplement STOP à cet email.`;

  const body = humanize(raw).text;
  const subject = reSubject(incomingSubject || p.email_subject);
  const text = `${body}\n\n${sig}\n\n---\n${footer}`;

  const para = (s) =>
    s
      .split("\n\n")
      .map((blk) => `<p>${blk.replace(/\n/g, "<br>")}</p>`)
      .join("\n");
  const logoHtml = sender.logoUrl
    ? `<p><img src="${sender.logoUrl}" alt="Digitalarc" width="210" style="width:210px;height:auto;border-radius:8px;display:block"></p>`
    : "";
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;line-height:1.55;max-width:600px">
${para(body)}
${logoHtml}<p>Joachim<br>Digitalarc — <a href="${sender.website}">${link}</a></p>
<hr style="border:none;border-top:1px solid #eee">
<p style="font-size:11px;color:#999">Pour ne plus etre contacte : repondez STOP ou <a href="${optoutUrl}">cliquez ici</a>.</p>
</body></html>`;

  return { subject, text, html };
}
