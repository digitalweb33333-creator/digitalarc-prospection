// ============================================================
// Service web - réponses automatiques 24/7 (déploiement Render)
// ------------------------------------------------------------
// Enveloppe HTTP autour de auto-reply.js pour tourner comme un web service
// Render (plan gratuit). Trois rôles :
//   GET /health  -> liveness (pour le keep-alive / health check Render)
//   GET /run     -> déclenche UN cycle auto-reply (protégé par CRON_TOKEN)
//   setInterval  -> exécute aussi un cycle toutes les REPLY_INTERVAL_MIN min
//
// Le plan gratuit s'endort après ~15 min sans trafic : un pinger externe
// (UptimeRobot/cron-job.org) doit taper /health (ou /run) régulièrement pour
// garder l'instance éveillée afin que l'intervalle interne continue de scanner.
//
// auto-reply.js est lancé en processus enfant (aucune modif du script) avec
// l'environnement du service (variables Render). Un verrou évite les exécutions
// concurrentes.
// ============================================================
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pull, push, crmStats, syncConfigured } from "./lib/crm-sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PORT = Number(process.env.PORT || 10000);
const CRON_TOKEN = process.env.CRON_TOKEN || "";
const INTERVAL_MIN = Number(process.env.REPLY_INTERVAL_MIN || 15);

let running = false;
let lastRun = null;
let lastResult = null;
let runs = 0;

function spawnAutoReply() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/email/auto-reply.js", "--send"], {
      cwd: ROOT,
      env: process.env,
    });
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("close", (code) => resolve({ code }));
    child.on("error", (e) => resolve({ error: e.message }));
  });
}

// Un cycle = pull état partagé -> auto-reply -> push état modifié.
async function runCycle(trigger) {
  if (running) {
    console.log(`[server] cycle déjà en cours, ignore (${trigger})`);
    return { skipped: true };
  }
  running = true;
  runs++;
  console.log(`[server] === cycle auto-reply (${trigger}) #${runs} ===`);
  try {
    await pull(console); // CRM partagé (repo privé) -> data/crm/
    const r = await spawnAutoReply(); // détecte / classe / répond / notifie
    await push(console); // persiste anti-doublon + opt-out + statuts
    lastResult = r.code ?? null;
    console.log(`[server] cycle terminé (code ${lastResult})`);
    return r;
  } catch (e) {
    console.error(`[server] erreur cycle : ${e.message}`);
    return { error: e.message };
  } finally {
    running = false;
    lastRun = new Date().toISOString();
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === "/health" || url.pathname === "/") {
    return json(200, { ok: true, service: "digitalarc-autoreply", running, runs, lastRun, lastResult, sync: syncConfigured(), crm: crmStats() });
  }

  if (url.pathname === "/run") {
    if (CRON_TOKEN && url.searchParams.get("token") !== CRON_TOKEN) {
      return json(401, { error: "unauthorized" });
    }
    // Répond tout de suite, le scan continue en arrière-plan (évite les timeouts cron)
    json(202, { started: !running, alreadyRunning: running });
    runCycle("http /run");
    return;
  }

  json(404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`[server] digitalarc-autoreply à l'écoute sur :${PORT}`);
  console.log(`[server] intervalle interne : ${INTERVAL_MIN} min | token /run : ${CRON_TOKEN ? "requis" : "désactivé"}`);
  // Premier cycle peu après le démarrage, puis à intervalle régulier.
  setTimeout(() => runCycle("démarrage"), 8000);
  setInterval(() => runCycle("intervalle"), INTERVAL_MIN * 60 * 1000);
});
