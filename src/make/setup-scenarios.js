// ============================================================
// Setup Make via API
// ------------------------------------------------------------
// 1. Cree un webhook (hook) "Digitalarc CRM Inbound"
// 2. Cree un scenario "Digitalarc CRM Sync" declenche par ce webhook
// 3. Affiche l'URL du webhook a coller dans .env (MAKE_WEBHOOK_CRM)
// 4. Genere aussi un blueprint complet importable (webhook -> Google Sheets)
//
// Le module Google Sheets necessite une connexion OAuth Google qui ne peut
// PAS etre creee sans navigateur. Deux options sont documentees a la fin.
//
// Idempotent : ne recree pas si le hook/scenario existe deja.
//
// Usage : node src/make/setup-scenarios.js
// ============================================================
import fs from "node:fs";
import path from "node:path";
import "dotenv/config";
import { log } from "../lib/logger.js";
import { dataDir, ROOT } from "../lib/config.js";

const TOKEN = process.env.MAKE_API_TOKEN;
const ZONE = process.env.MAKE_ZONE || "eu1";
const TEAM = Number(process.env.MAKE_TEAM_ID || 1898223);
const SHEET_ID = process.env.GOOGLE_SHEETS_ID || "";
const SHEET_TAB = process.env.MAKE_SHEET_TAB || "prospects"; // onglet cible du Sheet
const B = `https://${ZONE}.make.com/api/v2`;
const H = { Authorization: `Token ${TOKEN}`, "Content-Type": "application/json" };

const HOOK_NAME = "Digitalarc CRM Inbound";
const SCENARIO_NAME = "Digitalarc CRM Sync";

async function api(method, p, body) {
  const res = await fetch(B + p, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let json;
  try {
    json = JSON.parse(txt);
  } catch {
    json = { raw: txt };
  }
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${txt}`);
  return json;
}

async function ensureHook() {
  const existing = await api("GET", `/hooks?teamId=${TEAM}`);
  const found = (existing.hooks || []).find((h) => h.name === HOOK_NAME);
  if (found) {
    log.ok(`Webhook existant : ${found.url || "(url via GET detail)"} (id ${found.id})`);
    return found;
  }
  const created = await api("POST", "/hooks", {
    name: HOOK_NAME,
    teamId: TEAM,
    typeName: "gateway-webhook",
    method: false,
    headers: false,
    stringify: false,
  });
  const hook = created.hook || created;
  log.ok(`Webhook cree : ${hook.url} (id ${hook.id})`);
  return hook;
}

// Blueprint minimal valide : declencheur webhook seul (le reste se branche dans Make)
function webhookOnlyBlueprint(hookId) {
  return {
    name: SCENARIO_NAME,
    flow: [
      {
        id: 1,
        module: "gateway:CustomWebHook",
        version: 1,
        parameters: { hook: hookId, maxResults: 1 },
        mapper: {},
        metadata: { designer: { x: 0, y: 0 }, restore: {} },
      },
    ],
    metadata: {
      instant: true,
      version: 1,
      scenario: {
        roundtrips: 1, maxErrors: 3, autoCommit: true, autoCommitTriggerLast: true,
        sequential: false, confidential: false, dataloss: false, dlq: false,
      },
      designer: { orphans: [] },
    },
  };
}

async function ensureScenario(hookId) {
  const existing = await api("GET", `/scenarios?teamId=${TEAM}`);
  const found = (existing.scenarios || []).find((s) => s.name === SCENARIO_NAME);
  if (found) {
    log.ok(`Scenario existant : "${SCENARIO_NAME}" (id ${found.id})`);
    return found;
  }
  const created = await api("POST", "/scenarios", {
    teamId: TEAM,
    blueprint: JSON.stringify(webhookOnlyBlueprint(hookId)),
    scheduling: JSON.stringify({ type: "indefinitely" }),
  });
  const scn = created.scenario || created;
  log.ok(`Scenario cree : "${SCENARIO_NAME}" (id ${scn.id})`);
  return scn;
}

// Blueprint complet importable (webhook -> Google Sheets Add a Row)
function fullBlueprint(hookId) {
  const cols = [
    "place_id","title","profession","country","locality","phone","email_to",
    "website","score","absent_chatgpt","screenshot_url","email_status",
    "sent_at","mailbox_used","event",
  ];
  const values = {};
  cols.forEach((c, i) => (values[i] = `{{1.${c}}}`));
  return {
    name: "Digitalarc CRM Sync (complet)",
    flow: [
      {
        id: 1, module: "gateway:CustomWebHook", version: 1,
        parameters: { hook: hookId, maxResults: 1 }, mapper: {},
        metadata: { designer: { x: 0, y: 0 } },
      },
      {
        id: 2, module: "google-sheets:addRow", version: 2,
        parameters: { __IMTCONN__: "<<CONNECTER_GOOGLE>>" },
        mapper: {
          mode: "select", insertUnformatted: false, valueInputOption: "USER_ENTERED",
          spreadsheetId: SHEET_ID, sheetId: SHEET_TAB, includesHeaders: true,
          values,
        },
        metadata: { designer: { x: 300, y: 0 } },
      },
    ],
    metadata: {
      instant: true, version: 1,
      scenario: { roundtrips: 1, maxErrors: 3, autoCommit: true, sequential: false, confidential: false, dataloss: false, dlq: false },
      designer: { orphans: [] },
    },
  };
}

async function main() {
  if (!TOKEN) {
    log.error("MAKE_API_TOKEN manquant dans .env");
    process.exit(1);
  }
  log.step(`Setup Make (zone ${ZONE}, team ${TEAM})`);

  const hook = await ensureHook();
  // Recupere l'url complete si absente
  let url = hook.url;
  if (!url) {
    const detail = await api("GET", `/hooks/${hook.id}`);
    url = (detail.hook || detail).url;
  }
  await ensureScenario(hook.id);

  // Ecrit le blueprint complet importable
  const bpDir = dataDir("make");
  const bpFile = path.join(bpDir, "blueprint-crm-sync.json");
  fs.writeFileSync(bpFile, JSON.stringify(fullBlueprint(hook.id), null, 2), "utf8");

  log.step("A FAIRE (1 etape manuelle, OAuth Google obligatoire)");
  console.log(`
  1. Colle cette ligne dans .env :
       MAKE_WEBHOOK_CRM=${url}

  2. Connecte Google Sheets a Make (OAuth, une seule fois) :
     - Ouvre le scenario "${SCENARIO_NAME}" sur ${ZONE}.make.com
     - Ajoute un module "Google Sheets > Add a Row" apres le webhook
     - Autorise ton compte Google, choisis la feuille (ID ${SHEET_ID || "<ton sheet>"})
     - Mappe les colonnes (en-tetes = colonnes du CSV data/crm/crm.csv)
     - OU importe directement le blueprint pre-rempli :
       ${path.relative(ROOT, bpFile)}
     - Active le scenario (interrupteur ON)

  Ensuite, chaque envoi/relance Node enverra automatiquement la ligne au Sheet.
  `);
}

main().catch((e) => {
  log.error(e.message);
  process.exit(1);
});
