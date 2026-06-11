// ============================================================
// Import d'un export CSV Apollo (in-app) -> CRM
// ------------------------------------------------------------
// Apollo Basic ne donne pas les emails via API, mais l'export in-app OUI.
// Ce script parse l'export, ne garde que les emails VERIFIED (delivrabilite),
// deduplique, infere le metier, et integre dans crm.json (score 7 = curate
// par l'utilisateur -> qualifie pour email:gen).
//
// Filtre ICP (actif par defaut) : ne garde que les TPE/independants (taille
// d'entreprise <= 20 employes) et 1 seul contact par cabinet/domaine (prefere le
// decideur). Evite d'ecrire aux grosses boites (Pfizer, federations...) et de
// spammer plusieurs salaries d'un meme cabinet.
//
// Usage :
//   node src/sync/import-csv.js "C:\\chemin\\apollo-contacts-export.csv"
//   node src/sync/import-csv.js <fichier> --all-emails              (inclut les non-verifies)
//   node src/sync/import-csv.js <fichier> --no-icp                  (desactive le filtre ICP)
//   node src/sync/import-csv.js <fichier> --max-employees=50        (plafond taille, def. 20)
//   node src/sync/import-csv.js <fichier> --no-dedupe-domain        (garde plusieurs contacts/cabinet)
//   node src/sync/import-csv.js <fichier> --keep-unknown-employees  (garde taille inconnue)
// ============================================================
import "dotenv/config";
import fs from "node:fs";
import { professions } from "../lib/config.js";
import { loadCrm, saveCrm, upsert } from "../lib/crm.js";
import { log } from "../lib/logger.js";

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith("--")); // 1er argument positionnel
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const a = argv.find((x) => x.startsWith(name + "="));
  return a ? a.split("=").slice(1).join("=") : def;
};

const VERIFIED_ONLY = !flag("--all-emails");
// --- Filtre ICP (TPE/indépendants only) : actif par défaut ---
//   --no-icp                  : désactive tout le filtre ICP
//   --max-employees=N         : plafond taille d'entreprise (def. 20, env ICP_MAX_EMPLOYEES)
//   --no-dedupe-domain        : ne pas réduire à 1 contact par cabinet/domaine
//   --keep-unknown-employees  : garder les contacts dont la taille est inconnue
const ICP_OFF = flag("--no-icp");
const MAX_EMPLOYEES = Number(opt("--max-employees", process.env.ICP_MAX_EMPLOYEES ?? 20));
const DEDUPE_DOMAIN = !flag("--no-dedupe-domain");
const KEEP_UNKNOWN_EMP = flag("--keep-unknown-employees");

if (!file || !fs.existsSync(file)) {
  log.error(`Fichier introuvable : ${file}`);
  process.exit(1);
}

// --- Parseur CSV robuste (guillemets, virgules et retours-ligne dans les champs) ---
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\r") { /* ignore */ }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
const rows = parseCSV(raw);
const header = rows[0];
const I = (name) => header.indexOf(name);
const C = {
  first: I("First Name"), last: I("Last Name"), title: I("Title"),
  company: I("Company Name"), email: I("Email"), status: I("Email Status"),
  industry: I("Industry"), keywords: I("Keywords"), website: I("Website"),
  city: I("City"), country: I("Country"),
  work: I("Work Direct Phone"), corp: I("Corporate Phone"), mobile: I("Mobile Phone"),
  linkedin: I("Person Linkedin Url"), apolloId: I("Apollo Contact Id"),
  employees: I("# Employees"), seniority: I("Seniority"),
};

const profIds = new Set(professions.map((p) => p.id));
const PROF_RULES = [
  [/couvreur|charpent|toiture|roofer|roofing/i, "artisans"],
  [/plomb|plumber|chauffag|[ée]lectric|electric|menuis|ma[çc]on|peintre|carrel|serrur|artisan|b[âa]timent|construction|btp|r[ée]nov/i, "artisans"],
  [/avocat|lawyer|attorney|juridique|legal|barrister/i, "avocats"],
  [/notaire|notary/i, "notaires"],
  [/dentiste|dentist|orthodont/i, "dentistes"],
  [/m[ée]decin|docteur|\bdoctor\b|physician|g[ée]n[ée]raliste/i, "medecins"],
  [/kin[ée]|physio/i, "kines"],
  [/comptab|accountant|fiduciaire/i, "comptables"],
  [/architect/i, "architectes"],
  [/immobili|real estate|courtier|r[ée]gie/i, "agences_immo"],
  [/coach/i, "coaches"],
];
function inferProfession(title, industry, keywords) {
  const hay = `${title || ""} ${industry || ""} ${(keywords || "").slice(0, 200)}`;
  for (const [re, id] of PROF_RULES) if (re.test(hay)) return id;
  return "artisans";
}
function mapCountry(c) {
  const s = (c || "").toLowerCase();
  if (/suisse|switzerland/.test(s)) return "CH";
  if (/belg/.test(s)) return "BE";
  if (/luxemb/.test(s)) return "LU";
  return "FR";
}
const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e || "");

// --- Helpers ICP (taille d'entreprise + détection décideur + domaine) ---
// Fournisseurs grand public : un domaine partagé (gmail, orange...) ≠ une entreprise,
// donc JAMAIS dédupliqué (chaque indépendant reste unique).
const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|orange|wanadoo|free|sfr|neuf|laposte|bbox|numericable|gmx|proton|protonmail|aol|libertysurf|club-internet)\./i;
const DECIDER_SEN = /Owner|Founder|Partner|Manager|Director|Head|Vp|C[_-]?Suite|Senior/i;
const OWNER_TITLE = /g[eé]rant|owner|founder|fondat|associ[eé]|propri[eé]taire|dirige|president|pr[eé]sident|titulaire|ma[iî]tre|\bdr\b|docteur/i;
const numEmp = (s) => { const n = parseInt(String(s || "").replace(/[^0-9]/g, ""), 10); return isNaN(n) ? null : n; };
const isDecider = (sen, title) => DECIDER_SEN.test(sen || "") || OWNER_TITLE.test(title || "");
const domainOf = (e) => (String(e || "").split("@")[1] || "").toLowerCase();
const isCompanyDomain = (d) => Boolean(d) && !FREE_MAIL.test(d + ".");

// Métadonnées ICP par email (taille, décideur, domaine), remplies au parsing.
const icpMeta = new Map();

const leads = [];
let noEmail = 0, unverified = 0;
const seen = new Set();
for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  if (!row || row.length < 5) continue;
  const email = (row[C.email] || "").trim().toLowerCase();
  const status = (row[C.status] || "").trim();
  if (!isEmail(email)) { noEmail++; continue; }
  // Statut EXACT "Verified" requis (ne PAS matcher "Unverified" en sous-chaine).
  if (VERIFIED_ONLY && status.trim().toLowerCase() !== "verified") { unverified++; continue; }
  if (seen.has(email)) continue;
  seen.add(email);
  icpMeta.set(email, {
    employees: numEmp(row[C.employees]),
    decider: isDecider(row[C.seniority], row[C.title]),
    domain: domainOf(email),
  });
  const website = (row[C.website] || "").trim();
  const company = (row[C.company] || "").trim();
  const name = `${(row[C.first] || "").trim()} ${(row[C.last] || "").trim()}`.trim();
  const apolloId = (row[C.apolloId] || "").trim() || email;
  leads.push({
    place_id: `apollo-csv:${apolloId}`,
    title: company || name || email,
    contact_name: name,
    profession: inferProfession(row[C.title], row[C.industry], row[C.keywords]),
    country: mapCountry(row[C.country]),
    currency: mapCountry(row[C.country]) === "CH" ? "CHF" : "EUR",
    city_query: `${(row[C.city] || "").trim()} (Apollo CSV)`,
    category: (row[C.title] || "").trim(),
    address: "", postal_code: "",
    locality: (row[C.city] || "").trim(),
    phone: ((row[C.work] || row[C.corp] || row[C.mobile]) || "").replace(/^'/, "").trim(),
    email,
    website,
    maps_url: (row[C.linkedin] || "").trim() || website,
    rating: null, reviews_count: 0, images_count: 0,
    has_website: Boolean(website), has_hours: false,
    has_phone: Boolean(row[C.work] || row[C.mobile]),
    permanently_closed: false,
    source: "apollo-csv", email_status_src: status,
    scraped_at: new Date().toISOString(),
    is_https: website.startsWith("https"), site_avant_2020: null,
    absent_chatgpt: null, screenshot_url: null,
    score: 7, // curate par l'utilisateur -> qualifie
    // Detail honnete : un lead Apollo n'est PAS "nouvellement cree" (≠ BODACC).
    // Sans site -> pas_de_site (angle fort, exact) ; avec site -> aucun "probleme"
    // invente (email reste generique mais sincere). Voir generate-emails.js.
    score_detail: website ? {} : { pas_de_site: true },
    score_potential: 7,
  });
}

const crm = loadCrm();
const known = new Set([...crm.values()].map((r) => (r.email_to || "").toLowerCase()).filter(Boolean));
// Domaines d'entreprise déjà présents au CRM (pour ne pas re-contacter un 2e
// salarié d'un cabinet déjà adressé). Les domaines grand public sont ignorés.
const knownDomains = new Set(
  [...crm.values()]
    .map((r) => domainOf((r.email_to || "").toLowerCase()))
    .filter(isCompanyDomain)
);

// 1) Dédup par email vs CRM
const fresh = leads.filter((l) => !known.has(l.email));
const dupInCrm = leads.length - fresh.length;

// 2) Filtre ICP : taille d'entreprise + 1 contact par cabinet/domaine
let kept = fresh;
let droppedSize = 0, droppedDup = 0, unknownEmp = 0;
if (!ICP_OFF) {
  // 2a) Taille d'entreprise (<= MAX_EMPLOYEES)
  const sizeKept = [];
  for (const l of fresh) {
    const e = icpMeta.get(l.email)?.employees ?? null;
    if (e == null) {
      unknownEmp++;
      if (KEEP_UNKNOWN_EMP) sizeKept.push(l); else droppedSize++;
    } else if (e <= MAX_EMPLOYEES) {
      sizeKept.push(l);
    } else {
      droppedSize++;
    }
  }
  // 2b) Dédup par domaine d'entreprise (1 contact/cabinet, préfère un décideur)
  if (DEDUPE_DOMAIN) {
    const byDom = new Map();
    const out = [];
    for (const l of sizeKept) {
      const d = icpMeta.get(l.email)?.domain || "";
      if (!isCompanyDomain(d)) { out.push(l); continue; } // grand public -> unique
      if (knownDomains.has(d)) { droppedDup++; continue; } // cabinet déjà au CRM
      if (!byDom.has(d)) byDom.set(d, []);
      byDom.get(d).push(l);
    }
    for (const [, list] of byDom) {
      list.sort((a, b) => (icpMeta.get(b.email)?.decider ? 1 : 0) - (icpMeta.get(a.email)?.decider ? 1 : 0));
      out.push(list[0]);
      droppedDup += list.length - 1;
    }
    kept = out;
  } else {
    kept = sizeKept;
  }
}

const { added, updated } = upsert(crm, kept);
for (const l of kept) {
  const rec = crm.get(l.place_id);
  if (rec) { rec.email_to = l.email; rec.score = 7; if (rec.email_status !== "new") rec.email_status = "new"; }
}
saveCrm(crm);

log.step("Import CSV Apollo");
log.ok(`Lignes CSV (hors entete) : ${rows.length - 1}`);
log.ok(`Importes (nouveaux, dans l'ICP) : ${kept.length}  [added ${added}, updated ${updated}]`);
log.info(`Ignores : ${noEmail} sans email valide | ${unverified} non-Verified | ${dupInCrm} deja en CRM`);
if (!ICP_OFF) {
  log.info(
    `Filtre ICP (<=${MAX_EMPLOYEES} emp.${DEDUPE_DOMAIN ? " + 1/domaine" : ""}) : ` +
      `-${droppedSize} hors taille${KEEP_UNKNOWN_EMP ? "" : ` (dont ${unknownEmp} taille inconnue)`}` +
      `${DEDUPE_DOMAIN ? `, -${droppedDup} doublons cabinet` : ""}. ` +
      `Desactiver : --no-icp.`
  );
} else {
  log.warn("Filtre ICP DESACTIVE (--no-icp) : tous les contacts Verified importes.");
}
const byProf = {};
for (const l of kept) byProf[l.profession] = (byProf[l.profession] || 0) + 1;
log.info("Repartition metier : " + Object.entries(byProf).map(([k, v]) => `${k}:${v}`).join(", "));
log.info("Etape suivante : npm run email:gen");
