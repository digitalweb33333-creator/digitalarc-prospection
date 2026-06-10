// ============================================================
// Apollo.io - prospection B2B Suisse romande (francophone)
// ------------------------------------------------------------
// Trouve des dirigeants/independants des 10 metiers cibles en Suisse
// ROMANDE uniquement (Geneve, Vaud, Fribourg, Neuchatel, Valais, Jura)
// => emails en francais. Devise CHF. Integre les prospects dans le
// MEME CRM (data/crm/crm.json) et le meme pipeline que la France :
// meme rotation des 4 boites SMTP, meme warm-up, memes relances.
//
// Anti-doublon : un prospect Apollo deja present dans crm.json
//   - par place_id (apollo:<id>)  -> ignore (upsert)
//   - par email deja connu        -> ignore (dedupe email, tous canaux)
//
// SECURITE : DRY-RUN par defaut (AUCUN appel API). Le fetch reel ne se
// declenche qu'avec --run (a lancer seulement sur ordre explicite).
//
// Usage :
//   node src/scraping/apollo.js                 (DRY-RUN : plan, aucun appel)
//   node src/scraping/apollo.js --profession=dentistes
//   node src/scraping/apollo.js --run           (appel API reel)
//   node src/scraping/apollo.js --run --enrich  (revele les emails, consomme des credits)
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { log } from "../lib/logger.js";
import { professions, scoring, dataDir, parseArgs } from "../lib/config.js";
import { loadCrm, saveCrm, upsert } from "../lib/crm.js";

const args = parseArgs();
const RUN = Boolean(args.run); // sans --run : aucun appel reseau
const ENRICH = Boolean(args.enrich); // revele les emails (people/match, consomme des credits)
const PER_PAGE = Math.min(Number(args["per-page"] || process.env.APOLLO_PER_PAGE || 25), 100);
const MAX_PAGES = Number(args.pages || process.env.APOLLO_MAX_PAGES || 1);
const LIMIT = args.limit ? Number(args.limit) : Infinity; // cap global de leads gardes

const API_KEY = process.env.APOLLO_API_KEY;
const COUNTRY = process.env.APOLLO_COUNTRY || "CH";
const CURRENCY = process.env.APOLLO_CURRENCY || "CHF";

const SEARCH_URL = "https://api.apollo.io/api/v1/mixed_people/api_search";
const MATCH_URL = "https://api.apollo.io/api/v1/people/match";

// Suisse ROMANDE (francophone) uniquement -> garantit des emails en francais.
// (Zurich/Berne/Bale exclus volontairement : germanophones.)
const LOCATIONS = [
  "Geneva, Switzerland",
  "Lausanne, Switzerland",
  "Fribourg, Switzerland",
  "Neuchatel, Switzerland",
  "Sion, Switzerland",
  "Montreux, Switzerland",
  "Vevey, Switzerland",
  "Yverdon-les-Bains, Switzerland",
  "Nyon, Switzerland",
  "Morges, Switzerland",
  "Bulle, Switzerland",
  "Delemont, Switzerland",
];

// Intitules de poste cibles par metier (on vise le DECIDEUR)
const TITLES = {
  medecins: ["médecin", "docteur", "general practitioner", "physician"],
  avocats: ["avocat", "lawyer", "attorney", "associé"],
  comptables: ["expert-comptable", "comptable", "accountant", "fiduciaire"],
  architectes: ["architecte", "architect"],
  agences_immo: ["agent immobilier", "courtier immobilier", "real estate agent", "régie"],
  coaches: ["coach", "coach professionnel", "business coach"],
  artisans: ["gérant", "artisan", "plombier", "électricien", "menuisier", "owner"],
  notaires: ["notaire", "notary"],
  kines: ["kinésithérapeute", "physiothérapeute", "physiotherapist"],
  dentistes: ["dentiste", "chirurgien-dentiste", "dentist"],
};

// Email reellement exploitable (Apollo masque souvent : "email_not_unlocked@domain.com")
const isRealEmail = (e) =>
  typeof e === "string" &&
  /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) &&
  !/email_not_unlocked|not_unlocked|@domain\.com|@example\./i.test(e);

async function apolloSearch(titles, page) {
  const res = await fetch(SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Api-Key": API_KEY,
    },
    body: JSON.stringify({
      person_titles: titles,
      person_locations: LOCATIONS,
      contact_email_status: ["verified", "likely to engage"],
      page,
      per_page: PER_PAGE,
    }),
  });
  if (!res.ok) throw new Error(`Apollo search ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.people || json.contacts || [];
}

// Revele l'email d'un contact (consomme un credit Apollo)
async function apolloMatch(person) {
  const res = await fetch(MATCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Api-Key": API_KEY,
    },
    body: JSON.stringify({
      first_name: person.first_name,
      last_name: person.last_name,
      organization_name: person.organization?.name,
      domain: person.organization?.primary_domain,
    }),
  });
  if (!res.ok) return "";
  const json = await res.json();
  return isRealEmail(json.person?.email) ? json.person.email.toLowerCase() : "";
}

function normalize(person, professionId) {
  const org = person.organization || {};
  const domain = org.primary_domain || "";
  const website = org.website_url || (domain ? `https://${domain}` : "");
  const hasWebsite = Boolean(website);
  const email = isRealEmail(person.email) ? person.email.toLowerCase() : "";

  // Scoring (aligne sur BODACC) : un lead Apollo sans site = cible ideale pour une
  // agence web ET prospect activement selectionne (intention) -> 5 + 2 = 7 => qualifie.
  // Un lead AVEC site reste a 0 (a enrichir HTTPS/age via npm run score si besoin).
  const detail = {};
  let score = 0;
  if (!hasWebsite) {
    detail.pas_de_site = true;
    detail.intention_achat = true;
    score += scoring.criteria.pas_de_site.points + scoring.criteria.intention_achat.points; // 5+2=7
  }

  return {
    place_id: `apollo:${person.id}`,
    title: org.name || person.name || `${person.first_name || ""} ${person.last_name || ""}`.trim(),
    contact_name: person.name || "",
    profession: professionId,
    country: COUNTRY,
    currency: CURRENCY,
    city_query: `${person.city || org.city || ""} (Apollo)`,
    category: person.title || "",
    address: org.street_address || "",
    postal_code: org.postal_code || "",
    locality: person.city || org.city || "",
    phone: person.phone_numbers?.[0]?.raw_number || org.phone || "",
    email,
    website,
    maps_url: person.linkedin_url || website || "",
    rating: null,
    reviews_count: 0,
    images_count: 0,
    has_website: hasWebsite,
    has_hours: false,
    has_phone: Boolean(person.phone_numbers?.length || org.phone),
    permanently_closed: false,
    source: "apollo",
    apollo_id: person.id,
    intention_achat: !hasWebsite,
    linkedin_url: person.linkedin_url || "",
    scraped_at: new Date().toISOString(),
    is_https: null,
    site_avant_2020: null,
    absent_chatgpt: null,
    screenshot_url: null,
    score, // hors bonus ChatGPT et hors enrichissement HTTPS/age
    score_detail: detail,
    score_potential: score + scoring.criteria.absent_chatgpt.points,
  };
}

function printPlan(selected) {
  log.step("Apollo.io - PLAN (DRY-RUN, aucun appel API)");
  log.info(`Cle API        : ${API_KEY ? "presente" : "MANQUANTE (.env APOLLO_API_KEY)"}`);
  log.info(`Pays / devise  : ${COUNTRY} / ${CURRENCY}  (emails en francais)`);
  log.info(`Zones (romande): ${LOCATIONS.length} villes -> ${LOCATIONS.join(", ")}`);
  log.info(`Volume/job     : ${PER_PAGE} resultats x ${MAX_PAGES} page(s) par metier`);
  log.info(`Metiers cibles : ${selected.length}`);
  for (const prof of selected) {
    const titles = TITLES[prof.id] || [];
    log.info(`  - ${prof.label.padEnd(20)} titres: ${titles.join(", ")}`);
  }
  log.info("Anti-doublon   : par place_id (apollo:<id>) ET par email deja present dans crm.json");
  log.info("Integration    : meme crm.json, meme send.js (rotation 4 SMTP), meme warm-up 25/j, memes relances");
  log.warn("DRY-RUN : rien n'a ete appele ni ecrit. Ajouter --run pour lancer l'appel Apollo reel.");
}

async function main() {
  const selected = args.profession
    ? professions.filter((p) => p.id === args.profession)
    : professions;

  if (!selected.length) {
    log.error(`Profession inconnue : ${args.profession}`);
    process.exit(1);
  }

  // --- DRY-RUN (defaut) : on montre le plan, AUCUN appel reseau ---
  if (!RUN) return printPlan(selected);

  // --- Mode reel (--run) ---
  if (!API_KEY) {
    log.error("APOLLO_API_KEY manquant dans .env");
    process.exit(1);
  }

  const crm = loadCrm();
  // Set des emails deja connus dans le CRM (dedupe tous canaux confondus)
  const knownEmails = new Set(
    [...crm.values()].map((r) => (r.email_to || "").toLowerCase()).filter(Boolean)
  );

  log.step(`Apollo.io - recherche reelle (${selected.length} metiers, Suisse romande)`);

  const seenId = new Set();
  const leads = [];
  let skippedDup = 0;

  for (const prof of selected) {
    const titles = TITLES[prof.id];
    if (!titles) continue;
    let kept = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      let people = [];
      try {
        people = await apolloSearch(titles, page);
      } catch (err) {
        log.error(`  ${prof.label} p${page} : ${err.message}`);
        break;
      }
      if (!people.length) break;

      for (const person of people) {
        if (leads.length >= LIMIT) break;
        const p = normalize(person, prof.id);

        // Anti-doublon : place_id deja en CRM, deja vu ce run, ou email deja connu
        if (crm.has(p.place_id) || seenId.has(p.place_id)) { skippedDup++; continue; }
        if (p.email && knownEmails.has(p.email)) { skippedDup++; continue; }

        // Optionnel : reveler l'email (consomme un credit)
        if (!p.email && ENRICH) {
          p.email = await apolloMatch(person);
          if (p.email && knownEmails.has(p.email)) { skippedDup++; continue; }
        }

        seenId.add(p.place_id);
        if (p.email) knownEmails.add(p.email);
        leads.push(p);
        kept++;
      }
      await new Promise((r) => setTimeout(r, 800)); // anti rate-limit
    }
    log.ok(`  ${prof.label} : ${kept} gardes`);
  }

  // Trace brute (permet un scoring/enrichissement ulterieur si besoin)
  const outDir = dataDir("raw");
  const stamp = new Date().toISOString().slice(0, 10);
  const outFile = path.join(outDir, `prospects-apollo-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(leads, null, 2), "utf8");

  // Integration CRM (meme pipeline France)
  const { added, updated } = upsert(crm, leads);
  for (const p of leads) {
    const rec = crm.get(p.place_id);
    // Pas d'email exploitable -> needs_contact (jamais d'envoi auto), comme BODACC
    if (rec && (rec.email_status === "new" || !rec.email_to) && !(rec.email_to || "").includes("@"))
      rec.email_status = "needs_contact";
  }
  saveCrm(crm);

  const withEmail = leads.filter((p) => p.email).length;
  log.step("Resultat Apollo");
  log.ok(`Leads gardes        : ${leads.length} (dont ${withEmail} avec email exploitable)`);
  log.ok(`Doublons ignores    : ${skippedDup}`);
  log.ok(`CRM : +${added} nouveaux, ${updated} maj`);
  log.ok(`Fichier brut        : ${path.relative(process.cwd(), outFile)}`);
  log.info("Etape suivante : npm run email:gen (qualifies >=7 avec email) puis npm run send:dry.");
  if (!ENRICH)
    log.warn("Emails masques non revel es. Relancer avec --enrich pour les reveler (consomme des credits Apollo).");
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
