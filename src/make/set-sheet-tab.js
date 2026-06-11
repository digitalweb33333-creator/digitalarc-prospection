// ============================================================
// Bascule l'onglet Google Sheets du scenario Make "Digitalarc CRM Sync"
// ------------------------------------------------------------
// Change UNIQUEMENT mapper.sheetId du module google-sheets:addRow vers
// MAKE_SHEET_TAB (def. "prospects"), en preservant la connexion OAuth et le
// mapping des colonnes. SECURISE :
//   1. sauvegarde le blueprint live (data/make/blueprint-live-backup-<date>.json)
//   2. applique le changement, garde le scenario actif
//   3. envoie 1 ligne test au webhook et lit l'execution Make
//   4. si l'onglet n'existe pas (erreur "Unable to parse range") -> AUTO-REVERT
//      vers l'onglet precedent + reactive, et signale qu'il faut creer l'onglet.
//
// Prerequis : l'onglet doit exister dans le Sheet (Make ne le cree pas).
//   Colonnes A..G attendues : Nom | Email | Metier | Ville | Score | Statut | Date
//
// Usage :
//   node src/make/set-sheet-tab.js                 (vers MAKE_SHEET_TAB)
//   node src/make/set-sheet-tab.js --tab=prospects
//   node src/make/set-sheet-tab.js --no-test       (n'envoie pas de ligne test)
// ============================================================
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { log } from "../lib/logger.js";
import { dataDir, parseArgs } from "../lib/config.js";

const args = parseArgs();
const TOKEN = process.env.MAKE_API_TOKEN;
const ZONE = process.env.MAKE_ZONE || "eu1";
const TEAM = Number(process.env.MAKE_TEAM_ID || 1898223);
const HOOK = process.env.MAKE_WEBHOOK_CRM;
const TAB = String(args.tab || process.env.MAKE_SHEET_TAB || "prospects");
const DO_TEST = !args["no-test"];
const SCENARIO_RE = /CRM Sync/i;
const B = `https://${ZONE}.make.com/api/v2`;
const H = { Authorization: `Token ${TOKEN}`, "Content-Type": "application/json" };

async function api(method, p, body) {
  const res = await fetch(B + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const txt = await res.text();
  let json; try { json = JSON.parse(txt); } catch { json = { raw: txt }; }
  if (!res.ok) { const e = new Error(`${method} ${p} -> ${res.status} ${txt.slice(0, 300)}`); e.status = res.status; throw e; }
  return json;
}
const getScenario = async () =>
  (await api("GET", `/scenarios?teamId=${TEAM}`)).scenarios.find((s) => SCENARIO_RE.test(s.name));
const getBlueprint = async (id) => {
  const r = await api("GET", `/scenarios/${id}/blueprint`);
  return r.response?.blueprint ?? r.blueprint;
};
const gsModule = (bp) => bp.flow.find((m) => /google-sheets/i.test(m.module || ""));
async function setTab(id, bp, tab, wasActive) {
  gsModule(bp).mapper.sheetId = tab;
  try {
    await api("PATCH", `/scenarios/${id}`, { blueprint: JSON.stringify(bp) });
  } catch (e) {
    // certains comptes refusent le PATCH d'un scenario actif -> stop/patch/start
    try { await api("POST", `/scenarios/${id}/stop`); } catch {}
    await api("PATCH", `/scenarios/${id}`, { blueprint: JSON.stringify(bp) });
  }
  if (wasActive) { try { await api("POST", `/scenarios/${id}/start`); } catch (e) { log.error(`Reactivation: ${e.message}`); } }
}
async function lastExecutionError(id) {
  const logs = await api("GET", `/scenarios/${id}/logs?teamId=${TEAM}&pg[sortDir]=desc&pg[limit]=4`);
  const items = logs.scenarioLogs || [];
  const exec = items.find((it) => it.eventType === "EXECUTION_END");
  return exec?.error?.message || null;
}

async function main() {
  if (!TOKEN) { log.error("MAKE_API_TOKEN manquant dans .env"); process.exit(1); }
  const scn = await getScenario();
  if (!scn) { log.error('Scenario "Digitalarc CRM Sync" introuvable'); process.exit(1); }
  const wasActive = scn.isActive;

  const bp = await getBlueprint(scn.id);
  const gs = gsModule(bp);
  if (!gs) { log.error("Module google-sheets:addRow introuvable dans le blueprint"); process.exit(1); }
  const prevTab = gs.mapper.sheetId;

  log.step(`Make CRM Sync (id ${scn.id}) : onglet "${prevTab}" -> "${TAB}"`);
  const bak = path.join(dataDir("make"), `blueprint-live-backup-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(bak, JSON.stringify(bp, null, 2), "utf8");
  log.ok(`Sauvegarde blueprint live : ${path.relative(process.cwd(), bak)}`);

  await setTab(scn.id, structuredClone(bp), TAB, wasActive);
  log.ok(`Onglet applique : "${TAB}"`);

  if (!DO_TEST || !HOOK) {
    log.warn(DO_TEST ? "MAKE_WEBHOOK_CRM absent : pas de test d'execution." : "--no-test : pas de verification d'execution.");
    log.info(`Verifie manuellement que l'onglet "${TAB}" existe (sinon le scenario echouera).`);
    return;
  }

  log.info("Envoi d'une ligne test au webhook...");
  await fetch(HOOK, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "__set-sheet-tab test__", email_to: "test@example.com", profession: "test", locality: "TEST", score: 0, email_status: "test", sent_at: new Date().toISOString(), event: "test" }),
  });
  await new Promise((r) => setTimeout(r, 9000));
  const err = await lastExecutionError(scn.id);

  if (err) {
    log.error(`Execution Make en ERREUR : ${err}`);
    log.warn(`L'onglet "${TAB}" n'existe probablement pas. AUTO-REVERT vers "${prevTab}".`);
    const bp2 = await getBlueprint(scn.id);
    await setTab(scn.id, bp2, prevTab, wasActive);
    log.ok(`Restaure sur "${prevTab}". Cree l'onglet "${TAB}" (en-tetes A1:G1 : Nom|Email|Metier|Ville|Score|Statut|Date) puis relance.`);
    process.exit(2);
  }
  log.ok(`Execution Make OK : l'onglet "${TAB}" recoit bien les lignes (une ligne test a ete ajoutee, supprime-la).`);
}

main().catch((e) => { log.error(e.stack || e.message); process.exit(1); });
