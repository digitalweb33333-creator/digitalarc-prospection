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
// Detecte aussi les BOUNCES / NDR (mailer-daemon, postmaster, objets de retour) :
//   - retrouve le destinataire en echec dans le corps du NDR
//   - l'ajoute a la liste de suppression, passe la fiche en email_status="bounced"
//     et neutralise ses relances ; un resume unique est envoye a NOTIFY_EMAIL.
//
// Dedup par Message-ID (data/crm/replies-processed.json) : une reponse OU un
// bounce n'est traite qu'une fois, meme si le script tourne en boucle.
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

// Detection des bounces / NDR (non-delivery reports). On reconnait l'expediteur
// systeme (mailer-daemon/postmaster) OU un objet typique de retour.
const BOUNCE_FROM_RE = /mailer-daemon|postmaster|mail delivery (sub)?system|delivery subsystem/i;
const BOUNCE_SUBJ_RE = /undeliver|delivery (failed|status|incomplete|notification)|returned (mail|to sender)|failure notice|mail delivery failed|non[- ]?remis|message could not be delivered/i;

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

// Source complete d'un message (les NDR mettent le destinataire en echec dans
// une partie message/delivery-status, hors du 1er bloc texte).
async function fullSource(client, uid) {
  try {
    const msg = await client.fetchOne(uid, { source: true }, { uid: true });
    return msg && msg.source ? msg.source.toString("utf8") : "";
  } catch {
    return "";
  }
}

// Depuis le corps d'un NDR, retrouve le(s) destinataire(s) en echec qui font
// partie de nos prospects contactes (byEmail). Priorise les en-tetes standard,
// avec repli sur toute adresse contactee presente dans le corps.
function extractFailedRecipients(body, byEmail) {
  const found = new Set();
  const re = /(?:final-recipient|original-recipient|x-failed-recipients|failed recipient)\s*:?\s*(?:rfc822\s*;)?\s*<?([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})>?/gi;
  let m;
  while ((m = re.exec(body))) {
    const a = m[1].toLowerCase();
    if (byEmail.has(a)) found.add(a);
  }
  if (!found.size) {
    const low = body.toLowerCase();
    for (const a of byEmail.keys()) if (a && low.includes(a)) found.add(a);
  }
  return [...found];
}

async function scanMailbox(account, crm, byEmail, processed, alerts, bounces) {
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
    const bounceCands = [];
    for await (const m of client.fetch({ since }, { uid: true, envelope: true })) {
      scanned++;
      const env = m.envelope || {};
      const from = (env.from && env.from[0] && env.from[0].address || "").toLowerCase();
      const subject = env.subject || "";
      const msgId = env.messageId || `${account.user}:${m.uid}`;
      if (processed.set.has(msgId)) continue;
      const date = env.date ? new Date(env.date).toISOString() : "";
      // Bounce/NDR : expediteur systeme, ou objet de retour venant d'un non-prospect.
      const isBounce = BOUNCE_FROM_RE.test(from) || (BOUNCE_SUBJ_RE.test(subject) && !byEmail.has(from));
      if (isBounce) {
        bounceCands.push({ uid: m.uid, msgId, from, subject, date });
        continue;
      }
      if (!from) continue;
      const prospect = byEmail.get(from);
      if (!prospect) continue;
      matches.push({ uid: m.uid, msgId, prospect, subject: subject || "(sans objet)", date, from });
    }
    // PASSE 2 : telechargement des corps APRES la boucle fetch
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
    // PASSE 2bis : NDR -> on retrouve le(s) destinataire(s) en echec
    for (const bc of bounceCands) {
      const src = await fullSource(client, bc.uid);
      const emails = extractFailedRecipients(src, byEmail);
      bounces.push({ msgId: bc.msgId, mailbox: account.user, ndrFrom: bc.from, subject: bc.subject, date: bc.date, emails });
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
  const bounces = [];
  for (const acc of accounts) {
    try {
      const n = await withTimeout(
        scanMailbox(acc, crm, byEmail, processed, alerts, bounces),
        35000,
        acc.user
      );
      log.ok(`  ${acc.user} : ${n} messages scannes`);
    } catch (e) {
      log.error(`  ${acc.user} : ${e.message}`);
    }
  }

  if (!alerts.length && !bounces.length) {
    log.ok("Aucune nouvelle reponse ni bounce.");
    return;
  }

  const { from, tx } = alertTransport();

  // --- Reponses de prospects ---
  if (alerts.length) {
    log.step(`${alerts.length} reponse(s) de prospect detectee(s)`);
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
  }

  // --- Bounces / NDR : auto-suppression + statut "bounced" + relances stoppees ---
  const bouncedEmails = [];
  if (bounces.length) {
    log.step(`${bounces.length} NDR/bounce(s) detecte(s)`);
    for (const b of bounces) {
      if (DRY) {
        log.info(`  [DRY] BOUNCE via ${b.ndrFrom} -> ${b.emails.join(", ") || "(non rattache a un prospect)"}`);
        continue;
      }
      for (const email of b.emails) {
        addSuppression(email);
        const prospect = byEmail.get(email);
        if (prospect && ["sent", "followed_up"].includes(prospect.email_status)) {
          prospect.email_status = "bounced";
          prospect.bounced_at = b.date || new Date().toISOString();
          if (Array.isArray(prospect.followups)) prospect.followups.forEach((f) => { f.sent = true; });
          await pushToMake({ ...prospect, event: "bounced" }, MAKE_WEBHOOK);
        }
        bouncedEmails.push(email);
        log.warn(`  BOUNCE : ${email} -> suppression (${b.ndrFrom})`);
      }
      processed.set.add(b.msgId); // meme un NDR non rattache est marque traite
    }
    // Resume unique a NOTIFY (evite 1 mail par bounce)
    if (bouncedEmails.length && !DRY) {
      try {
        await tx.sendMail({
          from: `"Digitalarc Alertes" <${from}>`,
          to: NOTIFY,
          subject: `[BOUNCES] ${bouncedEmails.length} adresse(s) retiree(s) automatiquement`,
          text: `Ces adresses ont bounce (NDR recu) et ont ete ajoutees a la liste de suppression — elles ne seront plus relancees :\n\n- ${bouncedEmails.join("\n- ")}`,
        });
        log.ok(`  Resume bounces envoye -> ${NOTIFY}`);
      } catch (e) {
        log.error(`  Echec resume bounces : ${e.message}`);
      }
    }
  }

  if (!DRY) {
    saveCrm(crm);
    fs.writeFileSync(processed.f, JSON.stringify([...processed.set], null, 2), "utf8");
  }
  log.step("Termine");
  log.ok(`Reponses : ${DRY ? 0 : alerts.length} | Bounces : ${bouncedEmails.length} | dedup store : ${processed.set.size} msg`);
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
