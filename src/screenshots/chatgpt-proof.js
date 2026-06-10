// ============================================================
// Preuve d'invisibilite IA via Firecrawl + Perplexity
// ------------------------------------------------------------
// ChatGPT exige une connexion -> impossible a screenshoter headless.
// On utilise Perplexity (moteur de reponse IA sans login), qui porte
// le meme argument : "les IA ne connaissent pas votre cabinet".
//
// Pour chaque prospect du bucket pending-chatgpt (+ qualified sans preuve) :
//   1. interroge Perplexity sur l'entreprise (screenshot + markdown)
//   2. si le nom n'apparait pas dans la reponse -> absent_chatgpt = true (+2)
//   3. telecharge le screenshot dans data/screenshots/
//   4. recalcule le score, met a jour le CRM, promeut les qualifies
//
// Usage :
//   node src/screenshots/chatgpt-proof.js                 (auto: dernier scoring)
//   node src/screenshots/chatgpt-proof.js --limit=20
//   node src/screenshots/chatgpt-proof.js --engine=perplexity
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { log } from "../lib/logger.js";
import { scoring, dataDir, ROOT, parseArgs } from "../lib/config.js";
import { loadCrm, saveCrm, upsert } from "../lib/crm.js";

const args = parseArgs();
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const ENGINE = args.engine || "perplexity";
const FC_KEY = process.env.FIRECRAWL_API_KEY;

const ENGINES = {
  perplexity: (q) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}`,
};

function latest(prefix) {
  const dir = dataDir("scored");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    .sort();
  return files.length ? path.join(dir, files.at(-1)) : null;
}

// Appel Firecrawl : screenshot + markdown d'une recherche IA
async function firecrawlScrape(url) {
  const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
    method: "POST",
    headers: {
      authorization: `Bearer ${FC_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      url,
      formats: ["screenshot", "markdown"],
      waitFor: 6000,
      timeout: 55000,
    }),
  });
  if (!res.ok) throw new Error(`Firecrawl ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return {
    screenshot: json.data?.screenshot || null,
    markdown: json.data?.markdown || "",
  };
}

// Telecharge le screenshot heberge par Firecrawl en local
async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return true;
}

// L'entreprise est-elle citee dans la reponse IA ?
function isMentioned(title, markdown) {
  if (!markdown) return false;
  const md = markdown.toLowerCase();

  // Signal fort d'ABSENCE : l'IA declare ne pas avoir d'info -> non cite
  const negatives = [
    "je n'ai pas", "aucune information", "pas d'information", "ne dispose",
    "n'ai trouve aucune", "aucune donnee", "il n'y a pas", "je ne trouve",
    "no specific information", "couldn't find", "i don't have", "i could not find",
    "aucun resultat", "introuvable", "ne semble pas exister",
  ];
  if (negatives.some((n) => md.includes(n))) return false;
  // Aucune source/lien externe sur l'entreprise = presence IA quasi nulle
  const hasSource = /\]\(https?:\/\//.test(markdown);
  if (!hasSource) return false;
  // tokens significatifs du nom (mots > 3 lettres, hors mots vides metier)
  const stop = new Set(["cabinet", "centre", "docteur", "maitre", "agence", "groupe", "saint", "sarl"]);
  const tokens = title
    .toLowerCase()
    .replace(/[^a-zà-ÿ0-9\s]/gi, " ")
    .split(/\s+/)
    .filter((t) => t.length > 3 && !stop.has(t));
  if (!tokens.length) return md.includes(title.toLowerCase());
  const hits = tokens.filter((t) => md.includes(t)).length;
  return hits / tokens.length >= 0.5; // majorite des tokens presents = cite
}

function rescore(p) {
  const c = scoring.criteria;
  const detail = { ...(p.score_detail || {}) };
  let score = 0;
  if (detail.pas_de_site) score += c.pas_de_site.points;
  if (detail.gmb_incomplet) score += c.gmb_incomplet.points;
  if (detail.pas_https) score += c.pas_https.points;
  if (detail.site_avant_2020) score += c.site_avant_2020.points;
  if (p.absent_chatgpt === true) {
    detail.absent_chatgpt = true;
    score += c.absent_chatgpt.points;
  }
  p.score = score;
  p.score_detail = detail;
  return p;
}

async function main() {
  if (!FC_KEY) {
    log.error("FIRECRAWL_API_KEY manquant dans .env");
    process.exit(1);
  }
  const buildUrl = ENGINES[ENGINE];
  if (!buildUrl) {
    log.error(`Moteur inconnu: ${ENGINE}. Disponible: ${Object.keys(ENGINES).join(", ")}`);
    process.exit(1);
  }

  // Cible : pending (potentiel >=7) + qualifies sans preuve encore
  const pendingFile = latest("pending-chatgpt-");
  const qualifiedFile = latest("qualified-");
  const pool = [];
  if (pendingFile) pool.push(...JSON.parse(fs.readFileSync(pendingFile, "utf8")));
  if (qualifiedFile) {
    for (const p of JSON.parse(fs.readFileSync(qualifiedFile, "utf8")))
      if (p.absent_chatgpt === null || p.absent_chatgpt === undefined) pool.push(p);
  }
  const targets = pool.filter((p) => p.absent_chatgpt == null).slice(0, LIMIT);

  log.step(`Preuve IA (${ENGINE}) sur ${targets.length} prospects`);
  if (!targets.length) {
    log.warn("Rien a traiter. Lancer le scoring d'abord (npm run score).");
    return;
  }

  const shotDir = dataDir("screenshots");
  const crm = loadCrm();
  let absent = 0,
    promoted = 0;

  for (const [i, p] of targets.entries()) {
    const q = `Connais-tu ${p.title} a ${p.locality || p.city_query}, son site web et ses services ?`;
    log.info(`${i + 1}/${targets.length} ${p.title} (${p.locality})`);
    try {
      const { screenshot, markdown } = await firecrawlScrape(buildUrl(q));
      const mentioned = isMentioned(p.title, markdown);
      p.absent_chatgpt = !mentioned;
      if (!mentioned) absent++;

      if (screenshot) {
        const safe = p.place_id.replace(/[^a-z0-9]/gi, "_");
        const dest = path.join(shotDir, `${safe}.png`);
        if (await download(screenshot, dest)) {
          p.screenshot_url = `data/screenshots/${safe}.png`;
        }
      }
      rescore(p);
      const status = p.absent_chatgpt ? "ABSENT" : "cite";
      log.ok(`  ${status} -> score ${p.score}/10`);
    } catch (e) {
      log.error(`  ${e.message}`);
      p.absent_chatgpt = null;
    }
  }

  // Promotion : reclasse les qualifies (score >= 7)
  const min = scoring.min_score;
  const nowQualified = targets.filter((p) => p.score >= min);
  promoted = nowQualified.length;

  upsert(crm, targets);
  saveCrm(crm);

  // Reecrit le fichier qualified consolide
  const allQualified = [...crm.values()].filter((p) => (p.score ?? 0) >= min);
  const outDir = dataDir("scored");
  fs.writeFileSync(
    path.join(outDir, "qualified-CONSOLIDATED.json"),
    JSON.stringify(allQualified, null, 2),
    "utf8"
  );

  log.step("Resultat");
  log.ok(`Absents des IA (preuve) : ${absent}/${targets.length}`);
  log.ok(`Nouveaux qualifies (>= ${min}/10) ce run : ${promoted}`);
  log.ok(`Total qualifies dans le CRM : ${allQualified.length}`);
  log.ok(`Screenshots : ${path.relative(ROOT, shotDir)}`);
  log.info("Etape suivante : generation des emails (npm run email:gen).");
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
