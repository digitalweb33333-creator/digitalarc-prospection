// Analyse (lecture seule) de la répartition par taille d'entreprise des
// prospects parqués `parked_icp`, en croisant avec le CSV Apollo d'origine.
// Sert à choisir un seuil d'assouplissement ICP défendable avant de libérer.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CSV = path.join(ROOT, "data/raw/apollo-merged-2026-06-11.csv");
const CRM = path.join(ROOT, "data/crm/crm.json");

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
const cE = I("# Employees"), cEm = I("Email"), cSen = I("Seniority"), cT = I("Title");
const map = new Map();
for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  if (!row || row.length < 5) continue;
  const em = (row[cEm] || "").trim().toLowerCase();
  if (!em) continue;
  const n = parseInt(String(row[cE] || "").replace(/[^0-9]/g, ""), 10);
  map.set(em, { emp: isNaN(n) ? null : n, sen: row[cSen] || "", title: row[cT] || "" });
}

const crm = JSON.parse(fs.readFileSync(CRM, "utf8"));
const arr = Array.isArray(crm) ? crm : Object.values(crm);
const parked = arr.filter((p) => p.email_status === "parked_icp");

const DEC = /Owner|Founder|Partner|Manager|Director|Head|Vp|C[_-]?Suite|Senior/i;
const OWN = /g[eé]rant|owner|founder|fondat|associ[eé]|propri[eé]taire|dirige|president|pr[eé]sident|titulaire|ma[iî]tre|\bdr\b|docteur/i;

const buckets = { "<=20": 0, "21-50": 0, "51-100": 0, "101-500": 0, ">500": 0, "inconnu": 0 };
let nomatch = 0, decUnknown = 0;
for (const p of parked) {
  const m = map.get((p.email_to || p.email || "").toLowerCase());
  if (!m) { nomatch++; continue; }
  const e = m.emp;
  const dec = DEC.test(m.sen) || OWN.test(m.title);
  if (e == null) { buckets["inconnu"]++; if (dec) decUnknown++; }
  else if (e <= 20) buckets["<=20"]++;
  else if (e <= 50) buckets["21-50"]++;
  else if (e <= 100) buckets["51-100"]++;
  else if (e <= 500) buckets["101-500"]++;
  else buckets[">500"]++;
}

console.log("Parked_icp total:", parked.length, "| introuvables dans CSV:", nomatch);
console.log("Repartition par taille entreprise:");
for (const [k, v] of Object.entries(buckets)) console.log("  " + k.padEnd(9) + " employes : " + v);
console.log("Parmi 'inconnu', deciders (gerant/owner/dr...):", decUnknown);
console.log("");
console.log("Seuil <=50 (vs 20) liberale en plus : " + buckets["21-50"] + " (taille connue)");
console.log("Ajouter 'inconnu' mais decideur seulement : +" + decUnknown);
