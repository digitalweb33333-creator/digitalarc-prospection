// ============================================================
// Enrichment + scoring complet
// ------------------------------------------------------------
// Reprend le dernier fichier data/raw/, enrichit chaque prospect
// ayant un site web (HTTPS reel + age du site), calcule le score /10
// final et repartit les prospects en 3 buckets :
//
//   - qualified       : score >= MIN_SCORE (pret pour email)
//   - pending_chatgpt : score un peu sous le seuil, mais le bonus
//                        "absent de ChatGPT" (2 pts) peut le faire passer
//                        -> vaut le coup de depenser Firecrawl dessus
//   - rejected        : trop loin du seuil meme avec le bonus ChatGPT
//
// Le critere absent_chatgpt n'est PAS evalue ici (etape Firecrawl separee) :
// on calcule donc le score "hors ChatGPT" et on raisonne sur le potentiel.
//
// Usage :
//   node src/scoring/score-prospects.js
//   node src/scoring/score-prospects.js --file=data/raw/prospects-XXX.json
//   node src/scoring/score-prospects.js --concurrency=20 --no-fetch
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { log } from "../lib/logger.js";
import { env, scoring, dataDir, ROOT, parseArgs } from "../lib/config.js";

const args = parseArgs();
const CONCURRENCY = Number(args.concurrency || 10);
const NO_FETCH = Boolean(args["no-fetch"]);
const FETCH_TIMEOUT_MS = 12000;

// -- Selection du fichier source ---------------------------------------------
function latestRawFile() {
  if (args.file) return path.resolve(ROOT, args.file);
  const dir = dataDir("raw");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("prospects-") && f.endsWith(".json"))
    .sort();
  if (!files.length) {
    log.error("Aucun fichier dans data/raw/. Lancer le scraping d'abord.");
    process.exit(1);
  }
  return path.join(dir, files.at(-1));
}

// -- Fetch avec timeout ------------------------------------------------------
async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; DigitalarcBot/1.0)" },
      ...opts,
    });
  } finally {
    clearTimeout(t);
  }
}

// Normalise une URL de site en variante https + http
function urlVariants(raw) {
  let u = raw.trim();
  u = u.replace(/^https?:\/\//i, "");
  return { https: `https://${u}`, http: `http://${u}` };
}

// -- Enrichment d'un prospect (HTTPS reel + age du site) ---------------------
async function enrich(p) {
  if (!p.has_website) {
    p.is_https = false;
    p.website_reachable = false;
    return p;
  }
  if (NO_FETCH) return p;

  const { https, http } = urlVariants(p.website);
  let res = null;
  let finalUrl = null;

  // 1. Tente HTTPS
  try {
    res = await fetchWithTimeout(https);
    if (res.ok || res.status < 400) finalUrl = res.url;
  } catch {
    /* https indisponible */
  }
  // 2. Sinon tente HTTP (=> site sans HTTPS)
  if (!finalUrl) {
    try {
      res = await fetchWithTimeout(http);
      if (res.ok || res.status < 400) finalUrl = res.url;
    } catch {
      /* totalement injoignable */
    }
  }

  p.website_reachable = Boolean(finalUrl);
  p.is_https = finalUrl ? finalUrl.startsWith("https://") : false;

  // 3. Analyse du HTML : age du site + extraction d'email (Google Maps n'en fournit pas)
  if (finalUrl && res) {
    try {
      const html = (await res.text()).slice(0, 300_000);
      p.site_avant_2020 = detectOldSite(html);
      p.email = extractEmail(html) || p.email || "";
    } catch {
      p.site_avant_2020 = null;
    }
  }
  return p;
}

// Extrait une adresse email plausible depuis le HTML (mailto: prioritaire, sinon regex).
function extractEmail(html) {
  const mailto = html.match(/mailto:([^"'?>\s]+@[^"'?>\s]+)/i);
  if (mailto) return mailto[1].toLowerCase();
  const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  const blacklist = /(\.png|\.jpg|\.jpeg|\.gif|\.webp|\.svg|@sentry|@example|wixpress|@2x|placeholder)/i;
  const found = (html.match(re) || [])
    .map((e) => e.toLowerCase())
    .filter((e) => !blacklist.test(e));
  return found[0] || null;
}

// Heuristiques "site avant 2020" (conservatrices) :
//  - annee de copyright detectee < 2020  -> signal fort
//  - absence de <meta viewport>          -> pas responsive = probablement ancien
function detectOldSite(html) {
  const lower = html.toLowerCase();
  const hasViewport = /<meta[^>]+name=["']?viewport/i.test(html);

  let copyrightYear = null;
  const re = /(?:©|&copy;|copyright)[^0-9]{0,20}(19|20)\d{2}/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const year = Number(m[0].match(/(19|20)\d{2}/)[0]);
    if (!copyrightYear || year > copyrightYear) copyrightYear = year; // garde la plus recente
  }

  if (copyrightYear && copyrightYear < 2020) return true;
  if (!hasViewport) return true; // non responsive
  return false;
}

// -- Scoring final -----------------------------------------------------------
function scoreFinal(p) {
  const c = scoring.criteria;
  const detail = { ...(p.score_detail || {}) }; // garde pas_de_site / gmb_incomplet du scraping
  let score = 0;

  if (detail.pas_de_site) score += c.pas_de_site.points;
  if (detail.gmb_incomplet) score += c.gmb_incomplet.points;

  // pas_https : seulement si le site existe et est joignable mais sans https
  if (p.has_website && p.website_reachable && p.is_https === false) {
    detail.pas_https = true;
    score += c.pas_https.points;
  }
  if (p.site_avant_2020 === true) {
    detail.site_avant_2020 = true;
    score += c.site_avant_2020.points;
  }

  p.score = score; // hors bonus ChatGPT
  p.score_detail = detail;
  p.score_potential = score + c.absent_chatgpt.points; // si absent de ChatGPT
  return p;
}

// -- Pool de concurrence -----------------------------------------------------
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// -- Main --------------------------------------------------------------------
async function main() {
  const src = latestRawFile();
  const prospects = JSON.parse(fs.readFileSync(src, "utf8"));
  log.step(`Scoring de ${prospects.length} prospects`);
  log.info(`Source : ${path.relative(ROOT, src)}`);
  if (NO_FETCH) log.warn("--no-fetch : enrichment HTTPS/age desactive.");

  let done = 0;
  await mapPool(prospects, CONCURRENCY, async (p) => {
    await enrich(p);
    scoreFinal(p);
    if (++done % 50 === 0) log.info(`  ${done}/${prospects.length} enrichis`);
    return p;
  });

  const min = env.minScore;
  const bonus = scoring.criteria.absent_chatgpt.points;

  const qualified = prospects.filter((p) => p.score >= min);
  const pending = prospects.filter(
    (p) => p.score < min && p.score_potential >= min
  );
  const rejected = prospects.filter((p) => p.score_potential < min);

  const sortDesc = (a, b) => b.score - a.score;
  qualified.sort(sortDesc);
  pending.sort(sortDesc);

  const outDir = dataDir("scored");
  const stamp = path.basename(src).replace("prospects-", "").replace(".json", "");
  const write = (name, data) => {
    const f = path.join(outDir, `${name}-${stamp}.json`);
    fs.writeFileSync(f, JSON.stringify(data, null, 2), "utf8");
    return path.relative(ROOT, f);
  };

  log.step("Resultat du scoring");
  log.ok(`Qualifies (>= ${min}/10, prets pour email)        : ${qualified.length}`);
  log.ok(`En attente ChatGPT (atteignent ${min} avec +${bonus}) : ${pending.length}`);
  log.info(`Rejetes (potentiel < ${min})                       : ${rejected.length}`);
  log.ok(`Fichier qualifies : ${write("qualified", qualified)}`);
  log.ok(`Fichier pending   : ${write("pending-chatgpt", pending)}`);

  // Apercu top 5
  log.step("Top 5 qualifies");
  for (const p of qualified.slice(0, 5)) {
    log.info(
      `  ${p.score}/10 [${p.profession}] ${p.title} (${p.locality}) ` +
        `{${Object.keys(p.score_detail).join(", ")}}`
    );
  }
  log.info(
    "\nEtape suivante : Firecrawl sur le bucket pending-chatgpt (+ qualified) pour la preuve d'absence ChatGPT."
  );
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
