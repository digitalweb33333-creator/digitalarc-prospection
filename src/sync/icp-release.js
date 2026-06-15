// ============================================================
// Assouplissement ICP : libère des prospects `parked_icp`
// ------------------------------------------------------------
// Croise chaque prospect parqué avec le nb d'employés réel (CSV Apollo
// d'origine) et repasse en statut `new` ceux dont l'entreprise est <= au
// plafond assoupli. Les emails sont ensuite (re)générés par email:gen.
//
// Idempotent : ne touche que les `parked_icp` ; relançable sans risque.
//
// Usage : node src/sync/icp-release.js --max-employees=100 [--dry-run]
// ============================================================
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCrm, saveCrm } from "../lib/crm.js";
import { log } from "../lib/logger.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CSV = path.join(ROOT, "data/raw/apollo-merged-2026-06-11.csv");

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const a = argv.find((x) => x.startsWith(n + "="));
  return a ? a.split("=").slice(1).join("=") : d;
};
const DRY = argv.includes("--dry-run");
const MAX = Number(opt("--max-employees", 100));

function parseCSV(t) {
  const rows = [];
  let row = [], f = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { row.push(f); f = ""; }
      else if (c === "\r") { /* skip */ }
      else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
      else f += c;
    }
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const rows = parseCSV(fs.readFileSync(CSV, "utf8").replace(/^﻿/, ""));
const h = rows[0];
const I = (n) => h.indexOf(n);
const cE = I("# Employees"), cEm = I("Email");
const empByEmail = new Map();
for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  if (!row || row.length < 5) continue;
  const em = (row[cEm] || "").trim().toLowerCase();
  if (!em) continue;
  const n = parseInt(String(row[cE] || "").replace(/[^0-9]/g, ""), 10);
  empByEmail.set(em, isNaN(n) ? null : n);
}

const crm = loadCrm();
const parked = [...crm.values()].filter((p) => p.email_status === "parked_icp");

let released = 0, keptBig = 0, noSize = 0;
const byProf = {};
for (const p of parked) {
  const e = empByEmail.get((p.email_to || p.email || "").toLowerCase());
  if (e == null) { noSize++; continue; }       // taille inconnue -> on laisse parqué (prudence)
  if (e > MAX) { keptBig++; continue; }          // trop grosse -> reste parqué
  if (!DRY) { p.email_status = "new"; }           // libéré -> entrera dans email:gen
  released++;
  byProf[p.profession] = (byProf[p.profession] || 0) + 1;
}

if (!DRY) saveCrm(crm);

log.step(`Assouplissement ICP (plafond <= ${MAX} employes)${DRY ? " [DRY-RUN]" : ""}`);
log.ok(`Liberes (parked_icp -> new) : ${released}`);
log.info(`Laisses parques : ${keptBig} trop grosses (> ${MAX} emp.) | ${noSize} taille inconnue`);
log.info("Repartition metier des liberes : " + Object.entries(byProf).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(", "));
log.info(DRY ? "Dry-run : aucun changement ecrit." : "Etape suivante : npm run email:gen");
