// ============================================================
// Service web - réponses auto 24/7 + relances quotidiennes (Render)
// ------------------------------------------------------------
// Enveloppe HTTP autour de auto-reply.js et followups.js. Chaque cycle :
//   pull (état partagé) -> auto-reply --send -> [relances 1x/jour] -> push
//
//   GET /health       -> liveness + état CRM + dernière relance
//   GET /run          -> un cycle (auto-reply + relances si dues), protégé CRON_TOKEN
//   GET /followups    -> force un run de relances maintenant (protégé)
//   GET /smtp-verify  -> teste les 4 boîtes SMTP depuis Render (protégé)
//
// Les relances (J+3/J+7/J+14, via followups.js / SMTP) se déclenchent
// automatiquement une fois par jour à partir de FOLLOWUP_HOUR (UTC), portées
// par le même pinger externe que l'auto-reply. Idempotentes (followups.js ne
// renvoie jamais une relance déjà envoyée), donc sûres même en cas de reprise.
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
const FOLLOWUP_HOUR = Number(process.env.FOLLOWUP_HOUR || 8); // heure UTC mini pour les relances

let running = false;
let lastRun = null, lastResult = null, runs = 0;
let lastFollowupDay = null, lastFollowupRun = null, lastFollowupResult = null;

// Lance un script node en enfant (logs streamés). Renvoie { code } ou { error }.
function spawnNode(args) {
  return new Promise((resolve) => {
    console.log(`[server] -> node ${args.join(" ")}`);
    const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env });
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("close", (code) => resolve({ code }));
    child.on("error", (e) => resolve({ error: e.message }));
  });
}

// Variante qui capture la sortie (pour renvoyer un résultat HTTP, ex. /smtp-verify).
function spawnCapture(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env });
    let out = "";
    child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
    child.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
    child.on("close", (code) => resolve({ code, out }));
    child.on("error", (e) => resolve({ error: e.message, out }));
  });
}

// Les relances sont-elles à lancer (1x/jour, à partir de FOLLOWUP_HOUR UTC) ?
function followupsDue() {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (lastFollowupDay === day) return false; // déjà fait aujourd'hui
  if (now.getUTCHours() < FOLLOWUP_HOUR) return false; // trop tôt
  return true;
}

async function runCycle(trigger, opts = {}) {
  if (running) {
    console.log(`[server] cycle déjà en cours, ignore (${trigger})`);
    return { skipped: true };
  }
  running = true;
  runs++;
  console.log(`[server] === cycle (${trigger}) #${runs} ===`);
  try {
    await pull(console); // état partagé (repo privé) -> data/crm/
    const ar = await spawnNode(["src/email/auto-reply.js", "--send"]);
    lastResult = ar.code ?? null;

    let fu = null;
    if (opts.followups || followupsDue()) {
      console.log("[server] relances quotidiennes (J+3 / J+7 / J+14)");
      fu = await spawnNode(["src/email/followups.js", "--send"]);
      lastFollowupDay = new Date().toISOString().slice(0, 10);
      lastFollowupRun = new Date().toISOString();
      lastFollowupResult = fu.code ?? null;
    }

    await push(console); // persiste anti-doublon + opt-out + statuts + relances envoyées
    console.log(`[server] cycle terminé (auto-reply ${lastResult}${fu ? `, relances ${lastFollowupResult}` : ""})`);
    return { auto_reply: ar, followups: fu };
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
  const authed = () => !CRON_TOKEN || url.searchParams.get("token") === CRON_TOKEN;

  if (url.pathname === "/health" || url.pathname === "/") {
    return json(200, {
      ok: true, service: "digitalarc-autoreply", running, runs, lastRun, lastResult,
      sync: syncConfigured(), crm: crmStats(),
      followups: { lastRun: lastFollowupRun, lastResult: lastFollowupResult, lastDay: lastFollowupDay },
    });
  }
  if (url.pathname === "/run") {
    if (!authed()) return json(401, { error: "unauthorized" });
    json(202, { started: !running, alreadyRunning: running });
    runCycle("http /run");
    return;
  }
  if (url.pathname === "/followups") {
    if (!authed()) return json(401, { error: "unauthorized" });
    json(202, { started: !running, alreadyRunning: running });
    runCycle("http /followups", { followups: true });
    return;
  }
  if (url.pathname === "/smtp-verify") {
    if (!authed()) return json(401, { error: "unauthorized" });
    spawnCapture(["src/email/send.js", "--verify"]).then((r) =>
      json(200, { code: r.code ?? null, tail: (r.out || "").slice(-1200) })
    );
    return;
  }
  json(404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`[server] digitalarc-autoreply à l'écoute sur :${PORT}`);
  console.log(`[server] intervalle ${INTERVAL_MIN} min | relances dès ${FOLLOWUP_HOUR}h UTC | token ${CRON_TOKEN ? "requis" : "off"}`);
  setTimeout(() => runCycle("démarrage"), 8000);
  setInterval(() => runCycle("intervalle"), INTERVAL_MIN * 60 * 1000);
});
