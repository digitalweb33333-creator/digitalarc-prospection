// ============================================================
// BODACC - detection des entreprises nouvellement creees (France)
// ------------------------------------------------------------
// Source officielle gratuite (data publique). Pour chaque metier cible,
// recupere les CREATIONS recentes correspondantes : nom, ville, CP,
// activite, adresse. Signal d'intention fort (+2 : une entreprise neuve
// a besoin de tout, dont un site).
//
// LIMITES (honnetes) :
//   - France uniquement (CH/BE/LU non couverts par BODACC).
//   - BODACC ne fournit NI email NI telephone -> ces leads partent avec
//     email_status="needs_contact" : il faut les enrichir (recherche
//     Google Maps / site) ou les contacter par voie postale/telephone.
//
// Usage :
//   node src/scraping/bodacc.js                 (tous metiers, 7 derniers jours)
//   node src/scraping/bodacc.js --days=14 --limit=100
//   node src/scraping/bodacc.js --profession=dentistes
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { log } from "../lib/logger.js";
import { professions, scoring, dataDir, parseArgs } from "../lib/config.js";
import { loadCrm, saveCrm, upsert } from "../lib/crm.js";

const args = parseArgs();
const DAYS = Number(args.days || 7);
const LIMIT = Number(args.limit || 50); // par metier
const API =
  "https://bodacc-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/annonces-commerciales/records";

// Termes d'activite BODACC par metier (apparaissent dans le champ "activite")
const TERMS = {
  medecins: "médecin",
  avocats: "avocat",
  comptables: "expert-comptable",
  architectes: "architecte",
  agences_immo: "agence immobilière",
  coaches: "coaching",
  artisans: "plomberie",
  notaires: "notaire",
  kines: "kinésithérapeute",
  dentistes: "chirurgien-dentiste",
};

function sinceDate(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

async function fetchCreations(term, since) {
  const where = `familleavis="creation" and dateparution >= "${since}" and "${term}"`;
  const url = `${API}?where=${encodeURIComponent(where)}&order_by=${encodeURIComponent(
    "dateparution desc"
  )}&limit=${Math.min(LIMIT, 100)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BODACC ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.results || [];
}

function parseEtab(e) {
  try {
    const o = JSON.parse(e.listeetablissements).etablissement || {};
    const a = o.adresse || {};
    const address = [a.numeroVoie, a.typeVoie, a.nomVoie].filter(Boolean).join(" ");
    return { activite: (o.activite || "").trim(), address };
  } catch {
    return { activite: "", address: "" };
  }
}

function normalize(e, professionId) {
  const { activite, address } = parseEtab(e);
  const detail = { pas_de_site: true, intention_achat: true };
  const score =
    scoring.criteria.pas_de_site.points + scoring.criteria.intention_achat.points;
  return {
    place_id: `bodacc:${e.id}`,
    title: e.commercant || "",
    profession: professionId,
    country: "FR",
    city_query: `${e.ville || ""} (BODACC)`,
    category: activite.slice(0, 120),
    address,
    postal_code: e.cp || "",
    locality: e.ville || "",
    phone: "",
    email: "",
    website: "",
    maps_url: e.url_complete || "",
    rating: null,
    reviews_count: 0,
    images_count: 0,
    has_website: false, // a confirmer par enrichissement
    has_hours: false,
    has_phone: false,
    permanently_closed: false,
    source: "bodacc",
    bodacc_date: e.dateparution,
    bodacc_registre: e.registre,
    intention_achat: true,
    scraped_at: new Date().toISOString(),
    is_https: null,
    site_avant_2020: null,
    absent_chatgpt: null,
    screenshot_url: null,
    score, // pas_de_site(5) + intention(2) = 7 -> deja qualifie
    score_detail: detail,
  };
}

async function main() {
  const since = sinceDate(DAYS);
  const selected = args.profession
    ? professions.filter((p) => p.id === args.profession)
    : professions;

  log.step(`BODACC - creations FR depuis ${since} (${selected.length} metiers)`);

  const seen = new Map();
  for (const prof of selected) {
    const term = TERMS[prof.id];
    if (!term) continue;
    try {
      const rows = await fetchCreations(term, since);
      let kept = 0;
      for (const e of rows) {
        const p = normalize(e, prof.id);
        if (!p.title || seen.has(p.place_id)) continue;
        seen.set(p.place_id, p);
        kept++;
      }
      log.ok(`  ${prof.label} ("${term}") : ${rows.length} trouvees | gardees ${kept}`);
    } catch (err) {
      log.error(`  ${prof.label} : ${err.message}`);
    }
  }

  const leads = [...seen.values()];
  const outDir = dataDir("raw");
  const stamp = new Date().toISOString().slice(0, 10);
  const outFile = path.join(outDir, `bodacc-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(leads, null, 2), "utf8");

  // Integration CRM : statut "needs_contact" (pas d'email -> pas d'envoi auto)
  const crm = loadCrm();
  const { added, updated } = upsert(crm, leads);
  for (const p of leads) {
    const rec = crm.get(p.place_id);
    if (rec && (rec.email_status === "new" || !rec.email_to))
      rec.email_status = "needs_contact";
  }
  saveCrm(crm);

  log.step("Resultat BODACC");
  log.ok(`Nouvelles entreprises (leads chauds) : ${leads.length}`);
  log.ok(`CRM : +${added} nouveaux, ${updated} maj | statut "needs_contact"`);
  log.ok(`Fichier : ${path.relative(process.cwd(), outFile)}`);
  log.warn(
    "BODACC ne donne ni email ni telephone. Ces leads sont a enrichir " +
      "(recherche Google Maps/site) ou a contacter par telephone/courrier."
  );
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
