// ============================================================
// Envoi avec rotation des 4 boites SMTP Hostinger
// ------------------------------------------------------------
// Securites integrees :
//   - cap global DAILY_EMAIL_CAP (400) + cap par boite PER_MAILBOX_DAILY (warm-up)
//   - liste de suppression (opt-out RGPD) verifiee avant chaque envoi
//   - DRY-RUN par defaut ; --send pour envoyer reellement ; --test pour s'auto-envoyer
//   - journal d'envoi horodate (preuve conformite + respect du cap)
//   - planifie les relances J+3 / J+7 / J+14 a l'envoi
//
// Usage :
//   node src/email/send.js --verify     (teste la connexion des 4 boites)
//   node src/email/send.js --test       (envoie 1 email de demo a TEST_RECIPIENT)
//   node src/email/send.js              (DRY-RUN : montre ce qui serait envoye)
//   node src/email/send.js --send       (envoi reel, dans la limite des caps)
//   node src/email/send.js --send --limit=20
// ============================================================
import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import { log } from "../lib/logger.js";
import { dataDir, ROOT, parseArgs } from "../lib/config.js";
import {
  loadCrm, saveCrm, loadSuppression, recordSend, sentToday, pushToMake,
} from "../lib/crm.js";

const args = parseArgs();
const SEND = Boolean(args.send);
const TEST = Boolean(args.test);
const VERIFY = Boolean(args.verify);
const LIMIT = args.limit ? Number(args.limit) : Infinity;

const DAILY_CAP = Number(process.env.DAILY_EMAIL_CAP || 400);
const PER_MAILBOX = Number(process.env.PER_MAILBOX_DAILY || 25);
const MAKE_WEBHOOK = process.env.MAKE_WEBHOOK_CRM || "";

// -- Construit les 4 transporteurs SMTP --------------------------------------
function mailboxes() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE || "true") === "true";
  const boxes = [];
  for (let i = 1; i <= 4; i++) {
    const user = process.env[`SMTP${i}_USER`];
    const pass = process.env[`SMTP${i}_PASS`];
    if (!user || !pass) continue;
    boxes.push({
      user,
      transport: nodemailer.createTransport({ host, port, secure, auth: { user, pass } }),
    });
  }
  return boxes;
}

const replyTo = process.env.SENDER_REPLY_TO || process.env.SMTP1_USER;
const senderName = process.env.SENDER_NAME || "Digitalarc";

async function verify(boxes) {
  log.step("Verification des connexions SMTP");
  for (const b of boxes) {
    try {
      await b.transport.verify();
      log.ok(`  ${b.user} : OK`);
    } catch (e) {
      log.error(`  ${b.user} : ${e.message}`);
    }
  }
}

function readEmailFiles(placeId) {
  const safe = placeId.replace(/[^a-z0-9]/gi, "_");
  const dir = dataDir("emails");
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${safe}.json`), "utf8"));
  const out = {
    subject: meta.subject,
    html: fs.readFileSync(path.join(dir, `${safe}.html`), "utf8"),
    text: fs.readFileSync(path.join(dir, `${safe}.txt`), "utf8"),
    attachments: [],
  };
  // Logo Digitalarc integre dans le HTML via cid:logo
  const logoPath = path.join(ROOT, "assets", "logo.png");
  if (fs.existsSync(logoPath))
    out.attachments.push({ filename: "digitalarc.png", path: logoPath, cid: "logo" });
  // Screenshot preuve IA integre dans le HTML via cid:proofshot
  if (meta.screenshot) {
    const shotPath = path.join(ROOT, meta.screenshot);
    if (fs.existsSync(shotPath))
      out.attachments.push({ filename: "preuve-ia.png", path: shotPath, cid: "proofshot" });
  }
  return out;
}

function scheduleFollowups(p) {
  const base = Date.now();
  const day = 86400000;
  p.followups = [
    { stage: 1, due: new Date(base + 3 * day).toISOString().slice(0, 10), sent: false },
    { stage: 2, due: new Date(base + 7 * day).toISOString().slice(0, 10), sent: false },
    { stage: 3, due: new Date(base + 14 * day).toISOString().slice(0, 10), sent: false },
  ];
}

async function main() {
  const boxes = mailboxes();
  if (!boxes.length) {
    log.error("Aucune boite SMTP configuree dans .env");
    process.exit(1);
  }

  if (VERIFY) return verify(boxes);

  if (TEST) {
    await verify(boxes);
    const to = process.env.TEST_RECIPIENT;
    if (!to) return log.error("TEST_RECIPIENT manquant dans .env");
    log.step(`Envoi de test -> ${to}`);
    const info = await boxes[0].transport.sendMail({
      from: `"${senderName}" <${boxes[0].user}>`,
      to,
      replyTo,
      subject: "Test Digitalarc - systeme de prospection OK",
      text: "Ceci est un email de test envoye par le systeme de prospection Digitalarc. La rotation SMTP fonctionne.",
    });
    log.ok(`Envoye via ${boxes[0].user} (id: ${info.messageId})`);
    return;
  }

  // -- Campagne ---------------------------------------------------------------
  const crm = loadCrm();
  const suppression = loadSuppression();
  const today = sentToday();
  const totalToday = Object.values(today).reduce((a, b) => a + b, 0);

  let queue = [...crm.values()]
    .filter((p) => p.email_status === "email_generated")
    .filter((p) => p.email_to && p.email_to.includes("@"))
    .filter((p) => !suppression.has(p.email_to.toLowerCase()))
    .slice(0, LIMIT);

  log.step(`Campagne (${SEND ? "ENVOI REEL" : "DRY-RUN"})`);
  log.info(`Cap global ${DAILY_CAP}/j | par boite ${PER_MAILBOX}/j | deja envoyes aujourd'hui : ${totalToday}`);
  log.info(`File d'attente : ${queue.length} emails`);
  if (!queue.length) return log.warn("Rien a envoyer. Generer les emails d'abord (npm run email:gen).");

  let rr = 0; // round-robin
  let sent = 0;
  const perBox = { ...today };

  for (const p of queue) {
    if (totalToday + sent >= DAILY_CAP) {
      log.warn("Cap global quotidien atteint. Stop.");
      break;
    }
    // choisit une boite sous son cap
    let box = null;
    for (let k = 0; k < boxes.length; k++) {
      const cand = boxes[(rr + k) % boxes.length];
      if ((perBox[cand.user] || 0) < PER_MAILBOX) {
        box = cand;
        rr = (rr + k + 1) % boxes.length;
        break;
      }
    }
    if (!box) {
      log.warn("Toutes les boites ont atteint leur cap journalier. Stop.");
      break;
    }

    const { subject, html, text, attachments } = readEmailFiles(p.place_id);
    if (!SEND) {
      const shot = attachments.length ? " +screenshot" : "";
      log.info(`  [DRY] ${box.user} -> ${p.email_to} | "${subject}"${shot}`);
      sent++;
      perBox[box.user] = (perBox[box.user] || 0) + 1;
      continue;
    }

    try {
      const info = await box.transport.sendMail({
        from: `"${senderName}" <${box.user}>`,
        to: p.email_to,
        replyTo,
        subject,
        text,
        html,
        attachments,
      });
      p.email_status = "sent";
      p.sent_at = new Date().toISOString();
      p.mailbox_used = box.user;
      p.followup_stage = 0;
      scheduleFollowups(p);
      recordSend(box.user);
      perBox[box.user] = (perBox[box.user] || 0) + 1;
      sent++;
      log.ok(`  ${box.user} -> ${p.email_to} (id ${info.messageId})`);
      await pushToMake({ ...p, event: "sent" }, MAKE_WEBHOOK);
      // petit delai anti-spam
      await new Promise((r) => setTimeout(r, 1500));
    } catch (e) {
      p.email_status = "error";
      p.last_error = e.message;
      log.error(`  ECHEC ${p.email_to} : ${e.message}`);
    }
  }

  saveCrm(crm);
  log.step("Resultat");
  log.ok(`${SEND ? "Envoyes" : "Simules (dry-run)"} : ${sent}`);
  if (!SEND) log.warn("DRY-RUN. Ajouter --send pour envoyer reellement.");
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
