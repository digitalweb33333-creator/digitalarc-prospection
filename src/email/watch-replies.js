// ============================================================
// Detection des reponses prospects (IMAP) + alerte instantanee
// ------------------------------------------------------------
// Surveille les 4 boites Hostinger. Quand un email entrant provient
// d'un prospect a qui on a ecrit (match sur email_to du CRM) :
//   - envoie une ALERTE a NOTIFY_EMAIL avec le contexte complet
//     (nom, profession, ville, score, sujet envoye, historique)
//   - passe le prospect en email_status="replied" (stoppe les relances)
//   - si le corps contient STOP/desinscription -> liste de suppression
//
// Dedup par Message-ID (data/crm/replies-processed.json) : une reponse
// n'alerte qu'une fois, meme si le script tourne en boucle.
//
// A lancer periodiquement (Task Scheduler / cron, ex: toutes les 15 min).
//
// Usage :
//   node src/email/watch-replies.js            (scan + alertes reelles)
//   node src/email/watch-replies.js --dry-run  (montre sans alerter ni modifier)
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import { log } from "../lib/logger.js";
import { dataDir, parseArgs } from "../lib/config.js";
import { loadCrm, saveCrm, addSuppression, pushToMake } from "../lib/crm.js";

const args = parseArgs();
const DRY = Boolean(args["dry-run"]);
const IMAP_HOST = process.env.IMAP_HOST || "imap.hostinger.com";
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const NOTIFY = process.env.NOTIFY_EMAIL;
const SCAN_DAYS = Number(process.env.REPLY_SCAN_DAYS || 7);
const MAKE_WEBHOOK = process.env.MAKE_WEBHOOK_CRM || "";

const STOP_RE = /\b(stop|d[ée]sinscri|d[ée]sabonn|unsubscribe|ne plus.{0,15}contact)/i;

// Garde-fou : empeche une boite lente/injoignable de bloquer tout le scan
const withTimeout = (p, ms, label) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout (${label})`)), ms)),
  ]);

function mailboxAccounts() {
  const boxes = [];
  for (let i = 1; i <= 4; i++) {
    const user = process.env[`SMTP${i}_USER`];
    const pass = process.env[`SMTP${i}_PASS`];
    if (user && pass) boxes.push({ user, pass });
  }
  return boxes;
}

// Store de dedup (Message-ID deja traites)
function loadProcessed() {
  const f = path.join(dataDir("crm"), "replies-processed.json");
  const set = new Set(fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : []);
  return { f, set };
}

// Transporteur pour l'alerte (1ere boite)
function alertTransport() {
  const u = process.env.SMTP1_USER,
    p = process.env.SMTP1_PASS;
  return {
    from: u,
    tx: nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),
      secure: String(process.env.SMTP_SECURE || "true") === "true",
      auth: { user: u, pass: p },
    }),
  };
}

function buildAlert(prospect, msg) {
  const fmt = (v) => v || "-";
  const lines = [
    `Un prospect vient de REPONDRE a votre prospection.`,
    ``,
    `Entreprise : ${fmt(prospect.title)}`,
    `Profession : ${fmt(prospect.profession)}`,
    `Ville      : ${fmt(prospect.locality)} (${fmt(prospect.country)})`,
    `Score      : ${fmt(prospect.score)}/10`,
    `Email      : ${fmt(prospect.email_to)}`,
    `Telephone  : ${fmt(prospect.phone)}`,
    `Site / Maps: ${fmt(prospect.website || prospect.maps_url)}`,
    ``,
    `--- Sa reponse ---`,
    `De     : ${msg.from}`,
    `Objet  : ${msg.subject}`,
    `Recu   : ${msg.date}`,
    `Boite  : ${msg.mailbox}`,
    ``,
    `--- Historique ---`,
    `Email envoye : "${fmt(prospect.email_subject)}" le ${fmt(prospect.sent_at)} via ${fmt(prospect.mailbox_used)}`,
    `Relances     : etape ${fmt(prospect.followup_stage)}`,
    ``,
    `Repondez-lui vite depuis ${msg.mailbox}.`,
  ];
  return {
    subject: `[PROSPECT REPOND] ${prospect.title} (${prospect.locality})`,
    text: lines.join("\n"),
  };
}

// Extrait un apercu texte d'un message (pour detection STOP)
async function snippet(client, uid) {
  try {
    const { content } = await client.download(uid, "TEXT", { uid: true });
    const chunks = [];
    for await (const c of content) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8").slice(0, 2000);
  } catch {
    return "";
  }
}

async function scanMailbox(account, crm, byEmail, processed, alerts) {
  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user: account.user, pass: account.pass },
    logger: false,
    greetingTimeout: 8000,
    socketTimeout: 30000,
    disableAutoIdle: true,
  });
  client.on("error", () => {}); // evite le crash sur 'error' non gere
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  let scanned = 0;
  try {
    const since = new Date(Date.now() - SCAN_DAYS * 86400000);
    // PASSE 1 : collecte des correspondances (NE PAS lancer d'autre commande
    // IMAP pendant l'iteration fetch -> imapflow serialise, sinon deadlock)
    const matches = [];
    for await (const m of client.fetch({ since }, { uid: true, envelope: true })) {
      scanned++;
      const env = m.envelope || {};
      const from = (env.from && env.from[0] && env.from[0].address || "").toLowerCase();
      const msgId = env.messageId || `${account.user}:${m.uid}`;
      if (!from || processed.set.has(msgId)) continue;
      const prospect = byEmail.get(from);
      if (!prospect) continue;
      matches.push({
        uid: m.uid,
        msgId,
        prospect,
        subject: env.subject || "(sans objet)",
        date: env.date ? new Date(env.date).toISOString() : "",
        from,
      });
    }
    // PASSE 2 : telechargement des corps APRES la boucle fetch (STOP detection)
    for (const mt of matches) {
      const body = await snippet(client, mt.uid);
      const isStop = STOP_RE.test(mt.subject) || STOP_RE.test(body);
      alerts.push({
        prospect: mt.prospect,
        msg: { from: mt.from, subject: mt.subject, date: mt.date, mailbox: account.user },
        isStop,
        msgId: mt.msgId,
      });
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return scanned;
}

async function main() {
  if (!NOTIFY) {
    log.error("NOTIFY_EMAIL manquant dans .env");
    process.exit(1);
  }
  const accounts = mailboxAccounts();
  const crm = loadCrm();

  // Index des prospects contactes par email
  const byEmail = new Map();
  for (const p of crm.values()) {
    if (p.email_to && ["sent", "followed_up", "replied"].includes(p.email_status))
      byEmail.set(p.email_to.toLowerCase(), p);
  }
  log.step(`Scan IMAP des reponses (${accounts.length} boites, ${SCAN_DAYS}j)`);
  log.info(`${byEmail.size} prospects contactes a surveiller`);
  if (!byEmail.size) {
    log.warn("Aucun prospect contacte pour l'instant. (Envoie des emails d'abord.)");
    return;
  }

  const processed = loadProcessed();
  const alerts = [];
  for (const acc of accounts) {
    try {
      const n = await withTimeout(
        scanMailbox(acc, crm, byEmail, processed, alerts),
        35000,
        acc.user
      );
      log.ok(`  ${acc.user} : ${n} messages scannes`);
    } catch (e) {
      log.error(`  ${acc.user} : ${e.message}`);
    }
  }

  if (!alerts.length) {
    log.ok("Aucune nouvelle reponse de prospect.");
    return;
  }

  log.step(`${alerts.length} reponse(s) de prospect detectee(s)`);
  const { from, tx } = alertTransport();

  for (const a of alerts) {
    const { prospect, msg, isStop, msgId } = a;
    if (DRY) {
      log.info(`  [DRY] ${prospect.title} a repondu (${msg.from})${isStop ? " [STOP]" : ""}`);
      continue;
    }
    // Marque l'etat
    if (isStop) {
      addSuppression(prospect.email_to);
      prospect.email_status = "unsubscribed";
      log.warn(`  STOP : ${prospect.email_to} -> suppression`);
    } else {
      prospect.email_status = "replied";
    }
    prospect.replied_at = msg.date;

    // Alerte
    const { subject, text } = buildAlert(prospect, msg);
    try {
      await tx.sendMail({
        from: `"Digitalarc Alertes" <${from}>`,
        to: NOTIFY,
        replyTo: prospect.email_to,
        subject: isStop ? `[STOP] ${prospect.title}` : subject,
        text,
      });
      log.ok(`  Alerte envoyee -> ${NOTIFY} : ${prospect.title}`);
      await pushToMake({ ...prospect, event: isStop ? "unsubscribed" : "replied" }, MAKE_WEBHOOK);
    } catch (e) {
      log.error(`  Echec alerte ${prospect.title} : ${e.message}`);
    }
    processed.set.add(msgId);
  }

  saveCrm(crm);
  fs.writeFileSync(processed.f, JSON.stringify([...processed.set], null, 2), "utf8");
  log.step("Termine");
  log.ok(`Alertes : ${alerts.filter((a) => !DRY).length} | dedup store : ${processed.set.size} msg`);
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
