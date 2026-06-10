// ============================================================
// CRM local = source de verite (data/crm/crm.json)
// + export CSV (import Google Sheets) + push optionnel vers Make
// + liste de suppression (opt-out RGPD)
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config.js";

const CRM_FILE = () => path.join(dataDir("crm"), "crm.json");
const SUPPRESSION_FILE = () => path.join(dataDir("crm"), "suppression.json");
const SENDLOG_FILE = () => path.join(dataDir("crm"), "sendlog.json");

const readJson = (f, def) =>
  fs.existsSync(f)
    ? JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")) // strip BOM
    : def;
const writeJson = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2), "utf8");

// -- CRM (map place_id -> record) --------------------------------------------
export function loadCrm() {
  const arr = readJson(CRM_FILE(), []);
  const map = new Map(arr.map((r) => [r.place_id, r]));
  return map;
}

export function saveCrm(map) {
  const arr = [...map.values()];
  writeJson(CRM_FILE(), arr);
  exportCsv(arr);
  return arr.length;
}

// Fusionne des prospects dans le CRM sans ecraser l'etat email existant.
export function upsert(map, prospects) {
  let added = 0,
    updated = 0;
  for (const p of prospects) {
    if (!p.place_id) continue;
    const existing = map.get(p.place_id);
    if (existing) {
      // garde le pipeline email (status, relances) ; rafraichit les donnees prospect
      map.set(p.place_id, {
        ...p,
        email_status: existing.email_status,
        sent_at: existing.sent_at,
        mailbox_used: existing.mailbox_used,
        followup_stage: existing.followup_stage,
        followups: existing.followups,
        email_to: existing.email_to || p.email || "",
      });
      updated++;
    } else {
      map.set(p.place_id, {
        ...p,
        email_status: "new",
        email_to: p.email || "",
        sent_at: null,
        mailbox_used: null,
        followup_stage: 0,
        followups: [],
      });
      added++;
    }
  }
  return { added, updated };
}

// -- Export CSV (en-tetes stables pour Google Sheets) ------------------------
const CSV_COLS = [
  "place_id", "title", "profession", "country", "currency", "locality", "address",
  "phone", "email_to", "website", "is_https", "site_avant_2020",
  "absent_chatgpt", "reviews_count", "score", "score_potential",
  "score_detail", "screenshot_url", "maps_url", "source",
  "email_status", "sent_at", "mailbox_used", "followup_stage",
];

function csvCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") v = JSON.stringify(v);
  v = String(v);
  return /[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function exportCsv(arr) {
  const lines = [CSV_COLS.join(",")];
  for (const r of arr) {
    // devise par defaut selon le pays (affichage CSV uniquement, ne modifie pas le JSON)
    const row = { ...r, currency: r.currency || (r.country === "CH" ? "CHF" : r.country ? "EUR" : "") };
    lines.push(CSV_COLS.map((c) => csvCell(row[c])).join(","));
  }
  fs.writeFileSync(path.join(dataDir("crm"), "crm.csv"), lines.join("\n"), "utf8");
}

// -- Liste de suppression (opt-out) ------------------------------------------
export function loadSuppression() {
  return new Set(readJson(SUPPRESSION_FILE(), []).map((e) => e.toLowerCase()));
}
export function addSuppression(email) {
  const set = loadSuppression();
  set.add(email.toLowerCase());
  writeJson(SUPPRESSION_FILE(), [...set]);
}

// -- Journal d'envoi (cap quotidien par boite) -------------------------------
export function loadSendLog() {
  return readJson(SENDLOG_FILE(), {});
}
export function recordSend(mailbox) {
  const log = loadSendLog();
  const day = new Date().toISOString().slice(0, 10);
  log[day] = log[day] || {};
  log[day][mailbox] = (log[day][mailbox] || 0) + 1;
  writeJson(SENDLOG_FILE(), log);
  return log[day];
}
export function sentToday() {
  const log = loadSendLog();
  const day = new Date().toISOString().slice(0, 10);
  return log[day] || {};
}

// -- Push vers Make (webhook) -> Make ecrit dans Google Sheets ---------------
export async function pushToMake(record, webhookUrl) {
  if (!webhookUrl) return false;
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(record),
    });
    return res.ok;
  } catch {
    return false;
  }
}
