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
import { addSuppression } from "./lib/crm.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const PORT = Number(process.env.PORT || 10000);
const CRON_TOKEN = process.env.CRON_TOKEN || "";
const INTERVAL_MIN = Number(process.env.REPLY_INTERVAL_MIN || 15);
const FOLLOWUP_HOUR = Number(process.env.FOLLOWUP_HOUR || 8); // heure UTC mini pour les relances
// Relances portées par la tâche Windows planifiée (voir RUNBOOK.md), PAS par Render,
// pour éviter un double déclenchement le même jour. Mettre FOLLOWUPS_ON_RENDER=true
// pour réactiver le cycle automatique côté Render. L'endpoint /followups reste
// toujours disponible pour un déclenchement manuel ponctuel.
const FOLLOWUPS_ON_RENDER = String(process.env.FOLLOWUPS_ON_RENDER || "false") === "true";
// BODACC hebdo : jour (0=dim ... 1=lun) et heure UTC mini de declenchement.
const BODACC_DAY = Number(process.env.BODACC_DAY ?? 1);  // lundi par defaut
const BODACC_HOUR = Number(process.env.BODACC_HOUR ?? 7); // 7h UTC par defaut

let running = false;
let lastRun = null, lastResult = null, runs = 0;
let lastFollowupDay = null, lastFollowupRun = null, lastFollowupResult = null;
let lastBodaccDay = null, lastBodaccRun = null, lastBodaccResult = null;

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

// BODACC est-il à lancer (1x/semaine, le jour BODACC_DAY dès BODACC_HOUR UTC) ?
// Dédup par jour : ne se déclenche que le bon jour, et une seule fois ce jour-là.
function bodaccDue() {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (now.getUTCDay() !== BODACC_DAY) return false; // pas le bon jour
  if (now.getUTCHours() < BODACC_HOUR) return false; // trop tôt
  if (lastBodaccDay === day) return false; // déjà fait aujourd'hui
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
    if (opts.followups || (FOLLOWUPS_ON_RENDER && followupsDue())) {
      console.log("[server] relances quotidiennes (J+3 / J+7 / J+14)");
      fu = await spawnNode(["src/email/followups.js", "--send"]);
      lastFollowupDay = new Date().toISOString().slice(0, 10);
      lastFollowupRun = new Date().toISOString();
      lastFollowupResult = fu.code ?? null;
    }

    // BODACC hebdomadaire (lundi 7h UTC) : nouvelles créations FR -> CRM (needs_contact).
    // Lancé ICI, entre pull et push, pour que les leads ajoutés soient persistés
    // dans le repo privé. N'envoie aucun email (upsert, statut needs_contact).
    let bo = null;
    if (opts.bodacc || bodaccDue()) {
      console.log("[server] BODACC hebdomadaire (créations FR)");
      bo = await spawnNode(["src/scraping/bodacc.js"]);
      lastBodaccDay = new Date().toISOString().slice(0, 10);
      lastBodaccRun = new Date().toISOString();
      lastBodaccResult = bo.code ?? null;
    }

    await push(console); // persiste anti-doublon + opt-out + statuts + relances envoyées
    console.log(`[server] cycle terminé (auto-reply ${lastResult}${fu ? `, relances ${lastFollowupResult}` : ""}${bo ? `, bodacc ${lastBodaccResult}` : ""})`);
    return { auto_reply: ar, followups: fu, bodacc: bo };
  } catch (e) {
    console.error(`[server] erreur cycle : ${e.message}`);
    return { error: e.message };
  } finally {
    running = false;
    lastRun = new Date().toISOString();
  }
}

// -- Désinscription publique (/stop) -----------------------------------------
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Lit le corps d'une requête (form-urlencoded ou JSON), borné à 8 Ko.
function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 8192) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

// Extrait un email d'un corps POST (JSON {email} ou form email=...).
function emailFromBody(body, contentType = "") {
  if (!body) return "";
  try {
    if (/application\/json/i.test(contentType)) return String(JSON.parse(body).email || "");
  } catch { /* pas du JSON valide */ }
  const m = body.match(/(?:^|&)email=([^&]*)/i);
  return m ? decodeURIComponent(m[1].replace(/\+/g, " ")) : "";
}

// Page HTML de désinscription (confirmation / formulaire / erreur).
function stopPage(kind, email = "") {
  const wrap = (title, inner, color) => `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Digitalarc</title>
<style>body{font-family:Arial,Helvetica,sans-serif;background:#f4f7fb;color:#1c2530;margin:0;padding:0}
.card{max-width:520px;margin:8vh auto;background:#fff;border-radius:10px;box-shadow:0 6px 24px rgba(15,42,71,.12);padding:34px 32px}
h1{font-size:20px;color:${color};margin:0 0 12px}p{line-height:1.6;font-size:15px}
.muted{color:#6b7a8d;font-size:13px;margin-top:22px}input{width:100%;padding:11px;border:1px solid #c9d4e0;border-radius:6px;font-size:15px;box-sizing:border-box}
button{margin-top:12px;background:#2c7be5;color:#fff;border:0;padding:11px 18px;border-radius:6px;font-size:15px;cursor:pointer}
a{color:#2c7be5}</style></head><body><div class="card">${inner}
<p class="muted">Digitalarc — <a href="https://digitalarc.fr">digitalarc.fr</a></p></div></body></html>`;

  if (kind === "ok")
    return wrap("Désinscription confirmée",
      `<h1>✓ Vous êtes désinscrit</h1><p>L'adresse <strong>${email}</strong> a bien été retirée de notre liste de prospection. Vous ne recevrez plus aucun message de notre part.</p><p>Si vous avez fait cette demande par erreur, écrivez-nous à <a href="mailto:contact@digitalarc.fr">contact@digitalarc.fr</a>.</p>`,
      "#1f9d55");
  if (kind === "invalid")
    return wrap("Adresse invalide",
      `<h1>Adresse e-mail invalide</h1><p>L'adresse fournie n'est pas valide. Réessayez ci-dessous&nbsp;:</p>
<form method="POST" action="/stop"><input type="email" name="email" placeholder="votre@email.fr" required><button type="submit">Me désinscrire</button></form>`,
      "#c0392b");
  // form (email manquant)
  return wrap("Se désinscrire",
    `<h1>Se désinscrire</h1><p>Indiquez l'adresse e-mail à retirer de notre liste de prospection&nbsp;:</p>
<form method="POST" action="/stop"><input type="email" name="email" placeholder="votre@email.fr" required><button type="submit">Me désinscrire</button></form>`,
    "#0f2a47");
}

// Traite une demande de désinscription : suppression + persistance immédiate.
async function handleStop(email) {
  addSuppression(email); // -> data/crm/suppression.json
  // Persiste tout de suite vers le repo privé : sinon le pull() du prochain
  // cycle (FS Render éphémère) écraserait l'ajout. Best-effort.
  if (syncConfigured()) {
    try { await push(console); } catch (e) { console.error(`[stop] push: ${e.message}`); }
  }
  console.log(`[stop] désinscription enregistrée : ${email}`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };
  const html = (code, body) => {
    res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  };
  const authed = () => !CRON_TOKEN || url.searchParams.get("token") === CRON_TOKEN;

  // Désinscription publique (RGPD) — AUCUN token : un prospect doit pouvoir
  // se désinscrire librement. Accepte GET ?email=... ou POST (form/JSON).
  if (url.pathname === "/stop") {
    const run = async () => {
      let email = (url.searchParams.get("email") || "").trim();
      if (!email && req.method === "POST")
        email = emailFromBody(await readBody(req), req.headers["content-type"] || "").trim();
      if (!email) return html(200, stopPage("form"));
      email = email.toLowerCase();
      if (!EMAIL_RE.test(email)) return html(400, stopPage("invalid"));
      await handleStop(email);
      return html(200, stopPage("ok", email));
    };
    run().catch((e) => { console.error(`[stop] ${e.message}`); html(500, stopPage("form")); });
    return;
  }

  if (url.pathname === "/health" || url.pathname === "/") {
    return json(200, {
      ok: true, service: "digitalarc-autoreply", running, runs, lastRun, lastResult,
      sync: syncConfigured(), crm: crmStats(),
      followups: { lastRun: lastFollowupRun, lastResult: lastFollowupResult, lastDay: lastFollowupDay },
      bodacc: { lastRun: lastBodaccRun, lastResult: lastBodaccResult, lastDay: lastBodaccDay, day: BODACC_DAY, hour: BODACC_HOUR },
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
  console.log(`[server] intervalle ${INTERVAL_MIN} min | relances auto Render ${FOLLOWUPS_ON_RENDER ? `ON dès ${FOLLOWUP_HOUR}h UTC` : "OFF (tâche Windows)"} | BODACC jour ${BODACC_DAY} dès ${BODACC_HOUR}h UTC | token ${CRON_TOKEN ? "requis" : "off"}`);
  setTimeout(() => runCycle("démarrage"), 8000);
  setInterval(() => runCycle("intervalle"), INTERVAL_MIN * 60 * 1000);
});
