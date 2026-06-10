// ============================================================
// Import d'un export CSV Apollo (in-app) -> CRM
// ------------------------------------------------------------
// Apollo Basic ne donne pas les emails via API, mais l'export in-app OUI.
// Ce script parse l'export, ne garde que les emails VERIFIED (delivrabilite),
// deduplique, infere le metier, et integre dans crm.json (score 7 = curate
// par l'utilisateur -> qualifie pour email:gen).
//
// Usage :
//   node src/sync/import-csv.js "C:\\chemin\\apollo-contacts-export.csv"
//   node src/sync/import-csv.js <fichier> --all-emails   (inclut les non-verifies)
// ============================================================
import "dotenv/config";
import fs from "node:fs";
import { professions } from "../lib/config.js";
import { loadCrm, saveCrm, upsert } from "../lib/crm.js";
import { log } from "../lib/logger.js";

const file = process.argv[2];
const VERIFIED_ONLY = !process.argv.includes("--all-emails");
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

const leads = [];
let noEmail = 0, unverified = 0;
const seen = new Set();
for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  if (!row || row.length < 5) continue;
  const email = (row[C.email] || "").trim().toLowerCase();
  const status = (row[C.status] || "").trim();
  if (!isEmail(email)) { noEmail++; continue; }
  if (VERIFIED_ONLY && !/verified/i.test(status)) { unverified++; continue; }
  if (seen.has(email)) continue;
  seen.add(email);
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
    score_detail: { intention_achat: true },
    score_potential: 7,
  });
}

const crm = loadCrm();
const known = new Set([...crm.values()].map((r) => (r.email_to || "").toLowerCase()).filter(Boolean));
const fresh = leads.filter((l) => !known.has(l.email));
const dupInCrm = leads.length - fresh.length;
const { added, updated } = upsert(crm, fresh);
for (const l of fresh) {
  const rec = crm.get(l.place_id);
  if (rec) { rec.email_to = l.email; rec.score = 7; if (rec.email_status !== "new") rec.email_status = "new"; }
}
saveCrm(crm);

log.step("Import CSV Apollo");
log.ok(`Lignes CSV (hors entete) : ${rows.length - 1}`);
log.ok(`Importes (Verified, uniques, nouveaux) : ${fresh.length}  [added ${added}, updated ${updated}]`);
log.info(`Ignores : ${noEmail} sans email valide | ${unverified} non-Verified | ${dupInCrm} deja en CRM`);
const byProf = {};
for (const l of fresh) byProf[l.profession] = (byProf[l.profession] || 0) + 1;
log.info("Repartition metier : " + Object.entries(byProf).map(([k, v]) => `${k}:${v}`).join(", "));
log.info("Etape suivante : npm run email:gen");
