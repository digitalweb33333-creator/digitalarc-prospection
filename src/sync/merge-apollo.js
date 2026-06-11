// ============================================================
// Fusionne plusieurs exports Apollo (in-app) en UN seul CSV deduplique par email.
// ------------------------------------------------------------
// Conserve les en-tetes Apollo (l'import les relit par nom). 1 ligne par email
// (lowercase) ; en cas de doublon, prefere une ligne au statut "Verified".
// Sortie : data/raw/apollo-merged-<date>.csv  -> a passer ensuite a import-csv.js.
//
// Usage :
//   node src/sync/merge-apollo.js <f1.csv> <f2.csv> ...
//   node src/sync/merge-apollo.js --dir="C:\\Users\\moi\\Downloads"   (scanne apollo-contacts-export*.csv)
//   node src/sync/merge-apollo.js --dir=. --out=data/raw/mon-merge.csv
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { log } from "../lib/logger.js";
import { dataDir, parseArgs } from "../lib/config.js";

const args = parseArgs();

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
const csvCell = (v) => {
  v = v == null ? "" : String(v);
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

// --- Selection des fichiers ---
let files = args._.filter(Boolean);
if (args.dir) {
  const dir = String(args.dir);
  const found = fs.readdirSync(dir)
    .filter((f) => /^apollo-contacts-export.*\.csv$/i.test(f))
    .map((f) => path.join(dir, f));
  files.push(...found);
}
files = [...new Set(files)];
if (!files.length) {
  log.error("Aucun fichier. Passe des chemins CSV, ou --dir=<dossier>.");
  process.exit(1);
}

let header = null, emailIdx = -1, statusIdx = -1;
const byEmail = new Map();
let totalRows = 0, noEmail = 0, dupMerged = 0;
const perFile = {};

for (const f of files) {
  if (!fs.existsSync(f)) { log.warn(`Absent, ignore : ${f}`); continue; }
  const rows = parseCSV(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
  const h = rows[0];
  if (!header) { header = h; emailIdx = h.indexOf("Email"); statusIdx = h.indexOf("Email Status"); }
  if (emailIdx < 0) { log.error(`Colonne "Email" absente dans ${path.basename(f)}`); process.exit(1); }
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < 5) continue;
    totalRows++;
    const email = (row[emailIdx] || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { noEmail++; continue; }
    const verified = (row[statusIdx] || "").trim().toLowerCase() === "verified";
    const prev = byEmail.get(email);
    if (prev) { dupMerged++; if (!prev.verified && verified) byEmail.set(email, { row, verified }); }
    else byEmail.set(email, { row, verified });
  }
  perFile[path.basename(f)] = rows.length - 1;
}

const out = [header.map(csvCell).join(",")];
let verifiedCount = 0;
for (const { row, verified } of byEmail.values()) {
  out.push(header.map((_, i) => csvCell(row[i] ?? "")).join(","));
  if (verified) verifiedCount++;
}
const outFile = args.out
  ? path.resolve(String(args.out))
  : path.join(dataDir("raw"), `apollo-merged-${new Date().toISOString().slice(0, 10)}.csv`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, out.join("\n"), "utf8");

log.step("Merge Apollo");
log.info("Fichiers : " + Object.entries(perFile).map(([k, v]) => `${k}:${v}`).join(", "));
log.ok(`Lignes lues : ${totalRows} | sans email : ${noEmail} | doublons fusionnes : ${dupMerged}`);
log.ok(`Emails uniques : ${byEmail.size} (dont ${verifiedCount} Verified)`);
log.ok(`Fichier : ${outFile}`);
log.info(`Etape suivante : node src/sync/import-csv.js "${outFile}"`);
