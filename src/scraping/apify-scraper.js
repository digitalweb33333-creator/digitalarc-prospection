// ============================================================
// Scraping Google Maps via Apify
// ------------------------------------------------------------
// Pour chaque (profession x ville), lance l'actor Google Maps,
// normalise les fiches, deduplique, applique le pre-scoring
// des criteres detectables des le scraping (pas_de_site, gmb_incomplet),
// puis sauvegarde dans data/raw/.
//
// SCRAPING PAR LOTS (plan gratuit Apify) :
//   - 50 fiches MAX par recherche (cap dur, non depassable)
//   - traitement par lots resumables : reprend automatiquement les jobs
//     non encore faits (data/state/scrape-progress.json)
//   - garde-fou cout : verifie l'usage mensuel Apify avant chaque job et
//     s'arrete avant de depasser le budget gratuit (~5 $)
//   - resultats fusionnes/dedupliques dans data/raw/prospects-master.json
//
// Usage :
//   node src/scraping/apify-scraper.js --batch=5         (5 jobs ce run puis stop)
//   node src/scraping/apify-scraper.js --dry-run         (montre les jobs restants)
//   node src/scraping/apify-scraper.js --profession=artisans --country=FR --batch=10
//   node src/scraping/apify-scraper.js --reset           (efface la progression)
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { ApifyClient } from "apify-client";
import { log } from "../lib/logger.js";
import {
  env,
  professions,
  regions,
  scoring,
  dataDir,
  parseArgs,
} from "../lib/config.js";

const args = parseArgs();

// Cap dur : jamais plus de 50 fiches par recherche (contrainte plan gratuit)
const HARD_CAP_PLACES = 50;
const PLACES = Math.min(env.maxPlacesPerSearch, HARD_CAP_PLACES);
// Nombre de jobs par lot (par defaut 5 pour rester econome)
const BATCH = args.batch ? Number(args.batch) : 5;
// Budget mensuel gratuit a ne pas depasser (USD)
const FREE_USD_LIMIT = Number(process.env.APIFY_FREE_USD_LIMIT || 5);
const USD_SAFETY = 0.9; // s'arrete a 90% du budget

const jobKey = (j) => `${j.professionId}|${j.city}`;

// -- 1. Construction de la liste des jobs (profession x ville) ----------------
function buildJobs() {
  const selProf = args.profession;
  const selCountry = args.country;
  const maxCities = args["max-cities"] ? Number(args["max-cities"]) : Infinity;

  const jobs = [];
  for (const prof of professions) {
    if (selProf && prof.id !== selProf) continue;
    for (const country of regions) {
      if (selCountry && country.code !== selCountry) continue;
      const cities = country.cities.slice(0, maxCities);
      for (const city of cities) {
        jobs.push({
          professionId: prof.id,
          professionLabel: prof.label,
          keywords: prof.keywords,
          countryCode: country.code,
          language: country.language,
          city,
        });
      }
    }
  }
  return jobs;
}

// -- 2. Normalisation d'une fiche Apify -> schema CRM stable ------------------
function normalize(item, job) {
  const website = (item.website || "").trim();
  const hasWebsite = Boolean(website);
  const reviews = Number(item.reviewsCount || 0);
  const images = Number(item.imagesCount || 0);
  const hasHours =
    Array.isArray(item.openingHours) && item.openingHours.length > 0;
  const hasPhone = Boolean(item.phone);

  return {
    place_id: item.placeId || item.fid || item.cid || null,
    title: item.title || item.name || "",
    profession: job.professionId,
    country: job.countryCode,
    city_query: job.city,
    category: item.categoryName || (item.categories && item.categories[0]) || "",
    address: item.address || "",
    postal_code: item.postalCode || "",
    locality: item.city || "",
    phone: item.phone || "",
    email: (item.emails && item.emails[0]) || "",
    website,
    maps_url: item.url || "",
    rating: item.totalScore ?? null,
    reviews_count: reviews,
    images_count: images,
    has_website: hasWebsite,
    has_hours: hasHours,
    has_phone: hasPhone,
    permanently_closed: Boolean(item.permanentlyClosed || item.temporarilyClosed),
    scraped_at: new Date().toISOString(),
    // Champs remplis par les etapes suivantes (enrichment / screenshot / scoring)
    is_https: null,
    site_avant_2020: null,
    absent_chatgpt: null,
    screenshot_url: null,
    score: null,
    score_detail: null,
  };
}

// -- 3. Pre-scoring : criteres detectables des le scraping --------------------
// Renvoie un objet partiel { points, detail } pour pas_de_site + gmb_incomplet.
function prescore(p) {
  const detail = {};
  let points = 0;

  if (!p.has_website) {
    points += scoring.criteria.pas_de_site.points;
    detail.pas_de_site = true;
  }

  const rules = scoring.gmb_incomplet_rules;
  const incomplete =
    p.reviews_count <= rules.max_reviews ||
    p.images_count <= rules.max_images ||
    (rules.require_opening_hours && !p.has_hours) ||
    (rules.require_phone && !p.has_phone);
  if (incomplete) {
    points += scoring.criteria.gmb_incomplet.points;
    detail.gmb_incomplet = true;
  }

  return { points, detail };
}

// -- 4. Appel Apify pour un job ----------------------------------------------
async function runJob(client, job) {
  // IMPORTANT : maxCrawledPlacesPerSearch est PAR mot-cle. On repartit le cap
  // de 50 sur les mots-cles pour que le TOTAL par job reste <= 50 (cout maitrise).
  const perTerm = Math.max(1, Math.floor(PLACES / job.keywords.length));
  const input = {
    searchStringsArray: job.keywords,
    locationQuery: job.city,
    language: job.language,
    maxCrawledPlacesPerSearch: perTerm,
    skipClosedPlaces: true,
    scrapeContacts: false,
    maxImages: 0,
  };

  log.info(
    `Apify -> [${job.professionLabel}] @ ${job.city} ` +
      `(${job.keywords.length} mots-cles x ${perTerm} = max ${perTerm * job.keywords.length}/job)`
  );
  const run = await client.actor(env.apifyActor).call(input);
  const { items } = await client.dataset(run.defaultDatasetId).listItems();
  return items;
}

// -- Garde-fou : usage mensuel Apify (USD) -----------------------------------
// Renvoie { used, limit } en USD, ou null si indisponible.
async function monthlyUsd() {
  try {
    const res = await fetch(
      `https://api.apify.com/v2/users/me/limits?token=${env.apifyToken}`
    );
    if (!res.ok) return null;
    const j = await res.json();
    const used = j.data?.current?.monthlyUsageUsd;
    const limit = j.data?.limits?.maxMonthlyUsageUsd ?? FREE_USD_LIMIT;
    if (typeof used !== "number") return null;
    return { used, limit };
  } catch {
    return null;
  }
}

// -- Progression (reprise par lots) ------------------------------------------
function loadProgress() {
  const f = path.join(dataDir("state"), "scrape-progress.json");
  const data = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : { done: [] };
  return { file: f, done: new Set(data.done) };
}
function saveProgress(file, doneSet) {
  fs.writeFileSync(file, JSON.stringify({ done: [...doneSet] }, null, 2), "utf8");
}

// -- Master deduplique (fichier canonique lu par le scoring) -----------------
function loadMaster() {
  const f = path.join(dataDir("raw"), "prospects-master.json");
  const arr = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : [];
  return { file: f, map: new Map(arr.map((p) => [p.place_id, p])) };
}

// -- 5. Main -----------------------------------------------------------------
async function main() {
  // Reset de la progression si demande
  const progress = loadProgress();
  if (args.reset) {
    saveProgress(progress.file, new Set());
    log.ok("Progression remise a zero.");
    return;
  }

  const allJobs = buildJobs();
  const pending = allJobs.filter((j) => !progress.done.has(jobKey(j)));
  const batch = pending.slice(0, BATCH);

  log.step(
    `Plan : ${allJobs.length} jobs total | ${progress.done.size} faits | ` +
      `${pending.length} restants | ce lot : ${batch.length} (max ${PLACES} fiches/job)`
  );

  if (args["dry-run"]) {
    for (const j of batch) log.info(`  - [${j.professionLabel}] @ ${j.city}`);
    if (pending.length > batch.length)
      log.info(`  ... (+${pending.length - batch.length} en attente des prochains lots)`);
    log.warn("DRY-RUN : aucun appel Apify. Retirer --dry-run pour lancer ce lot.");
    return;
  }

  if (!batch.length) {
    log.ok("Tous les jobs sont faits. (--reset pour repartir de zero.)");
    return;
  }

  if (!env.apifyToken) {
    log.error("APIFY_TOKEN manquant dans .env.");
    process.exit(1);
  }

  // Garde-fou cout avant de commencer
  const usd = await monthlyUsd();
  if (usd !== null) {
    const cap = Math.min(usd.limit, FREE_USD_LIMIT);
    log.info(`Usage Apify ce mois : ${usd.used.toFixed(2)} $ / ${cap} $`);
    if (usd.used >= cap * USD_SAFETY) {
      log.error(
        `Budget presque atteint (${usd.used.toFixed(2)} $ / ${cap} $). Arret pour rester gratuit. ` +
          `Attendre le renouvellement (cycle mensuel) ou passer en plan payant.`
      );
      return;
    }
  } else {
    log.warn("Usage Apify indisponible : garde-fou cout desactive pour ce run.");
  }

  const client = new ApifyClient({ token: env.apifyToken });
  const master = loadMaster();
  let totalRaw = 0,
    newUnique = 0;

  for (const [i, job] of batch.entries()) {
    // Re-verifie le budget avant chaque job
    const u = await monthlyUsd();
    if (u !== null) {
      const cap = Math.min(u.limit, FREE_USD_LIMIT);
      if (u.used >= cap * USD_SAFETY) {
        log.warn(`Budget atteint (${u.used.toFixed(2)} $ / ${cap} $) en cours de lot. Arret propre.`);
        break;
      }
    }
    log.info(`Job ${i + 1}/${batch.length} du lot`);
    try {
      const items = await runJob(client, job);
      totalRaw += items.length;
      for (const item of items) {
        const p = normalize(item, job);
        if (!p.place_id || p.permanently_closed) continue;
        if (master.map.has(p.place_id)) continue; // dedup global (tous lots)
        const { points, detail } = prescore(p);
        p.score = points;
        p.score_detail = detail;
        master.map.set(p.place_id, p);
        newUnique++;
      }
      // Persiste apres CHAQUE job (aucune perte si interruption)
      progress.done.add(jobKey(job));
      saveProgress(progress.file, progress.done);
      fs.writeFileSync(
        master.file,
        JSON.stringify([...master.map.values()], null, 2),
        "utf8"
      );
      log.ok(`  ${items.length} fiches | total CRM brut : ${master.map.size} (+${newUnique})`);
    } catch (err) {
      log.error(`  Echec [${job.professionLabel} @ ${job.city}] : ${err.message}`);
    }
  }

  const all = [...master.map.values()];
  log.step("Resultat du lot");
  log.ok(`Fiches brutes ce lot : ${totalRaw} | nouveaux uniques : ${newUnique}`);
  log.ok(`Total prospects (master) : ${all.length}`);
  log.ok(`Sans site web : ${all.filter((p) => !p.has_website).length}`);
  log.ok(`Restants apres ce lot : ${pending.length - batch.length}`);
  log.info(`Fichier : ${path.relative(process.cwd(), master.file)}`);
  log.info("Relancer la meme commande pour le lot suivant, ou : npm run score");
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
