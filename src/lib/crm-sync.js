// ============================================================
// Synchronisation de l'état CRM via un repo GitHub privé (store partagé)
// ------------------------------------------------------------
// Le FS de Render est éphémère et le repo de code est public (pas de PII).
// On utilise donc un repo GitHub PRIVÉ comme source de vérité partagée entre
// la machine locale (scraping/envoi) et Render (réponses auto) :
//   pull()  : récupère crm.json / suppression.json / auto-replies-processed.json
//             du repo privé -> data/crm/ (avant chaque cycle).
//   push()  : renvoie ces fichiers vers le repo privé APRÈS un cycle, mais
//             seulement ceux qui ont réellement changé (pas de commit inutile).
//
// Indispensable pour : (1) que Render voie les prospects contactés,
// (2) persister l'anti-doublon (pas de double réponse au redémarrage),
// (3) persister les opt-out STOP (obligation RGPD) entre local et Render.
//
// Variables d'env : GITHUB_TOKEN (scope repo), CRM_REPO ("owner/name"),
// CRM_BRANCH (def. main).
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const CRM_DIR = path.join(ROOT, "data", "crm");
const API = "https://api.github.com";

const FILES = ["crm.json", "suppression.json", "auto-replies-processed.json"];

const TOKEN = () => process.env.GITHUB_TOKEN || process.env.CRM_GITHUB_TOKEN || "";
const REPO = () => process.env.CRM_REPO || "";
const BRANCH = () => process.env.CRM_BRANCH || "main";

const sha = {};        // dernier sha connu par fichier (pour les PUT)
const pulledRaw = {};  // contenu récupéré au dernier pull (détection de changement)

export function syncConfigured() {
  return Boolean(TOKEN() && REPO());
}

function ghHeaders() {
  return {
    Authorization: `Bearer ${TOKEN()}`,
    "User-Agent": "digitalarc-crm-sync",
    Accept: "application/vnd.github+json",
  };
}

async function ghGet(file) {
  const url = `${API}/repos/${REPO()}/contents/${file}?ref=${encodeURIComponent(BRANCH())}`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${file}: HTTP ${res.status}`);
  return res.json();
}

async function ghPut(file, contentStr, prevSha) {
  const url = `${API}/repos/${REPO()}/contents/${file}`;
  const body = {
    message: `crm-sync: ${file} (${process.env.RENDER ? "render" : "local"})`,
    content: Buffer.from(contentStr, "utf8").toString("base64"),
    branch: BRANCH(),
    ...(prevSha ? { sha: prevSha } : {}),
  };
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...ghHeaders(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const err = new Error(`PUT ${file}: HTTP ${res.status} ${t.slice(0, 160)}`);
    err.status = res.status;
    throw err;
  }
  const j = await res.json();
  return j.content && j.content.sha;
}

// Récupère l'état partagé -> data/crm/
export async function pull(logger = console) {
  if (!syncConfigured()) {
    logger.log?.("[crm-sync] non configuré (GITHUB_TOKEN/CRM_REPO) — pull ignoré");
    return false;
  }
  fs.mkdirSync(CRM_DIR, { recursive: true });
  for (const f of FILES) {
    try {
      const data = await ghGet(f);
      if (!data) {
        pulledRaw[f] = undefined;
        continue;
      }
      const content = Buffer.from(data.content, "base64").toString("utf8");
      fs.writeFileSync(path.join(CRM_DIR, f), content, "utf8");
      sha[f] = data.sha;
      pulledRaw[f] = content;
    } catch (e) {
      logger.error?.(`[crm-sync] pull ${f}: ${e.message}`);
    }
  }
  logger.log?.(`[crm-sync] pull OK depuis ${REPO()}`);
  return true;
}

// Renvoie l'état modifié vers le repo (seulement les fichiers changés)
export async function push(logger = console) {
  if (!syncConfigured()) return false;
  for (const f of FILES) {
    const local = path.join(CRM_DIR, f);
    if (!fs.existsSync(local)) continue;
    const content = fs.readFileSync(local, "utf8");
    if (content === pulledRaw[f]) continue; // inchangé -> pas de commit
    try {
      if (!sha[f]) {
        const cur = await ghGet(f);
        sha[f] = cur && cur.sha;
      }
      sha[f] = await ghPut(f, content, sha[f]);
      pulledRaw[f] = content;
      logger.log?.(`[crm-sync] push ${f}`);
    } catch (e) {
      if (e.status === 409) {
        // conflit de sha : on resynchronise le sha et on réessaie une fois
        try {
          const cur = await ghGet(f);
          sha[f] = await ghPut(f, content, cur && cur.sha);
          pulledRaw[f] = content;
          logger.log?.(`[crm-sync] push ${f} (après resync)`);
        } catch (e2) {
          logger.error?.(`[crm-sync] push ${f} (retry): ${e2.message}`);
        }
      } else {
        logger.error?.(`[crm-sync] push ${f}: ${e.message}`);
      }
    }
  }
  return true;
}

// Compteur rapide de prospects (pour /health)
export function crmStats() {
  try {
    const raw = fs.readFileSync(path.join(CRM_DIR, "crm.json"), "utf8").replace(/^﻿/, "");
    const arr = JSON.parse(raw);
    const contacted = arr.filter(
      (p) => p.email_to && ["sent", "followed_up", "replied"].includes(p.email_status)
    ).length;
    return { records: arr.length, contacted };
  } catch {
    return { records: 0, contacted: 0 };
  }
}
