// ============================================================
// Reponse automatique aux prospects qui repondent (detect -> classe -> repond -> notifie)
// ------------------------------------------------------------
// Boucle complete, autonome (ne modifie aucun fichier existant) :
//   1. Polling IMAP des 4 boites Hostinger (contact@/pro@/hello@/team@)
//   2. Match avec un prospect du CRM (par email) + telechargement du corps
//   3. Classification de la reponse (interested / price_objection /
//      bad_timing / info_request / unsubscribe / not_interested / unknown)
//   4. Envoi d'une reponse auto au prospect via Resend (contact@digitalarc.fr)
//   5. Notification a NOTIFY_EMAIL (Joachim) avec le contexte + le texte envoye
//
// Garde-fous :
//   - STOP / desinscription : opt-out honore, AUCUNE reponse marketing
//   - prospect deja en liste de suppression : ignore
//   - confiance insuffisante / categorie inconnue : ESCALADE (notif a Joachim,
//     pas de reponse auto) -> on n'envoie jamais une reponse a cote
//   - dedup par Message-ID (data/crm/auto-replies-processed.json)
//   - cap par execution (AUTO_REPLY_MAX_PER_RUN)
//   - DRY-RUN par defaut : --send pour envoyer reellement
//
// Usage :
//   node src/email/auto-reply.js             (DRY-RUN : classe + simule)
//   node src/email/auto-reply.js --send      (envoi reel des reponses + notifs)
//   node src/email/auto-reply.js --dry-run   (force la simulation)
//
// A planifier toutes les ~15 min (cron / Task Scheduler), idealement
// EN REMPLACEMENT de watch-replies.js (sinon dedup separe : voir README).
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { log } from "../lib/logger.js";
import { dataDir, parseArgs } from "../lib/config.js";
import { loadCrm, saveCrm, addSuppression, loadSuppression } from "../lib/crm.js";
import { classifyReply, AUTO_REPLY_CATEGORIES, CATEGORIES } from "./reply-classifier.js";
import { buildReply } from "./reply-templates.js";
import { sendViaResend, resendConfigured } from "./resend-client.js";
import { sendNotification } from "./notify.js";

const args = parseArgs();
const SEND = Boolean(args.send) && !args["dry-run"];

const IMAP_HOST = process.env.IMAP_HOST || "imap.hostinger.com";
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const SCAN_DAYS = Number(process.env.REPLY_SCAN_DAYS || 7);
const MAX_PER_RUN = Number(process.env.AUTO_REPLY_MAX_PER_RUN || 100);
const MIN_CONF = (process.env.AUTO_REPLY_MIN_CONFIDENCE || "medium").toLowerCase();
const PROSPECT_REPLY_TO = process.env.SENDER_REPLY_TO || "contact@digitalarc.fr";

const CONF_RANK = { none: 0, low: 1, medium: 2, high: 3 };

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

// Store de dedup propre a ce systeme (ne touche pas a celui de watch-replies)
function loadProcessed() {
  const f = path.join(dataDir("crm"), "auto-replies-processed.json");
  const set = new Set(fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")) : []);
  return { f, set };
}

async function downloadBody(client, uid) {
  try {
    const { content } = await client.download(uid, "TEXT", { uid: true });
    const chunks = [];
    for await (const c of content) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8").slice(0, 8000);
  } catch {
    return "";
  }
}

// Scan d'une boite : renvoie les messages entrants correspondant a un prospect.
async function scanMailbox(account, byEmail, processed, out) {
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
  client.on("error", () => {});
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  let scanned = 0;
  try {
    const since = new Date(Date.now() - SCAN_DAYS * 86400000);
    // Passe 1 : envelopes (ne pas lancer d'autre commande IMAP pendant le fetch)
    const matches = [];
    for await (const m of client.fetch({ since }, { uid: true, envelope: true })) {
      scanned++;
      const env = m.envelope || {};
      const from = ((env.from && env.from[0] && env.from[0].address) || "").toLowerCase();
      const msgId = env.messageId || `${account.user}:${m.uid}`;
      if (!from || processed.set.has(msgId)) continue;
      const prospect = byEmail.get(from);
      if (!prospect) continue;
      matches.push({
        uid: m.uid,
        msgId,
        from,
        subject: env.subject || "(sans objet)",
        date: env.date ? new Date(env.date).toISOString() : "",
        prospect,
      });
    }
    // Passe 2 : corps (apres la boucle fetch)
    for (const mt of matches) {
      const body = await downloadBody(client, mt.uid);
      out.push({ ...mt, body, mailbox: account.user });
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return scanned;
}

async function main() {
  const accounts = mailboxAccounts();
  if (!accounts.length) {
    log.error("Aucune boite SMTP/IMAP configuree (SMTP1_USER...). Stop.");
    process.exit(1);
  }
  if (SEND && !resendConfigured()) {
    log.error("RESEND_API_KEY manquant : impossible d'envoyer. Lance sans --send pour simuler.");
    process.exit(1);
  }

  const crm = loadCrm();
  const suppression = loadSuppression();

  // Index des prospects deja contactes (on veut capter leurs reponses)
  const byEmail = new Map();
  for (const p of crm.values()) {
    if (p.email_to && ["sent", "followed_up", "replied"].includes(p.email_status))
      byEmail.set(p.email_to.toLowerCase(), p);
  }

  log.step(`Auto-reponse IMAP (${accounts.length} boites, ${SCAN_DAYS}j) ${SEND ? "[ENVOI REEL]" : "[DRY-RUN]"}`);
  log.info(`${byEmail.size} prospects contactes a surveiller | seuil confiance: ${MIN_CONF}`);
  if (!byEmail.size) return log.warn("Aucun prospect contacte. (Envoyez d'abord des emails.)");

  const processed = loadProcessed();
  const incoming = [];
  for (const acc of accounts) {
    try {
      const n = await withTimeout(scanMailbox(acc, byEmail, processed, incoming), 35000, acc.user);
      log.ok(`  ${acc.user} : ${n} messages scannes`);
    } catch (e) {
      log.error(`  ${acc.user} : ${e.message}`);
    }
  }

  if (!incoming.length) return log.ok("Aucune nouvelle reponse de prospect.");
  log.step(`${incoming.length} reponse(s) de prospect a traiter`);

  const seen = new Set();
  let sentCount = 0;
  const stats = { auto_replied: 0, escalated: 0, unsubscribed: 0, skipped: 0, failed: 0 };

  for (const inc of incoming) {
    if (seen.has(inc.msgId)) continue;
    seen.add(inc.msgId);

    const p = inc.prospect;
    const cls = classifyReply({ subject: inc.subject, body: inc.body });
    const ctx = {
      from: inc.from,
      subject: inc.subject,
      date: inc.date,
      mailbox: inc.mailbox,
    };

    // --- 1. Opt-out (STOP) : on honore, jamais de reponse marketing ---
    if (cls.isStop) {
      stats.unsubscribed++;
      log.warn(`  STOP : ${p.email_to} -> suppression`);
      if (SEND) {
        addSuppression(p.email_to);
        p.email_status = "unsubscribed";
        p.replied_at = inc.date;
        p.reply_category = CATEGORIES.UNSUBSCRIBE;
        await sendNotification({ prospect: p, classification: cls, action: "suppressed", incoming: ctx, reply: null });
        processed.set.add(inc.msgId);
      }
      continue;
    }

    // --- 2. Deja desinscrit : on ignore ---
    if (suppression.has((p.email_to || "").toLowerCase())) {
      stats.skipped++;
      log.info(`  ${p.email_to} en liste de suppression -> ignore`);
      if (SEND) processed.set.add(inc.msgId);
      continue;
    }

    // --- 3. Eligibilite a une reponse auto ---
    const confOk = (CONF_RANK[cls.confidence] || 0) >= (CONF_RANK[MIN_CONF] || 2);
    const capOk = sentCount < MAX_PER_RUN;
    const eligible = AUTO_REPLY_CATEGORIES.has(cls.category) && confOk && capOk;

    if (eligible) {
      const reply = buildReply(cls.category, p, { incomingSubject: inc.subject });
      if (!SEND) {
        stats.auto_replied++;
        log.info(`  [DRY] ${cls.category} (${cls.confidence}) -> repondrait a ${p.email_to} | "${reply.subject}"`);
        continue;
      }
      const headers = inc.msgId.startsWith("<")
        ? { "In-Reply-To": inc.msgId, References: inc.msgId }
        : undefined;
      const res = await sendViaResend({
        to: p.email_to,
        subject: reply.subject,
        text: reply.text,
        html: reply.html,
        replyTo: PROSPECT_REPLY_TO,
        headers,
      });
      if (!res.ok) {
        stats.failed++;
        log.error(`  ECHEC Resend -> ${p.email_to} : ${res.error} (re-essai au prochain run)`);
        continue; // pas de dedup : on retentera
      }
      sentCount++;
      stats.auto_replied++;
      p.email_status = "replied";
      p.replied_at = inc.date;
      p.reply_category = cls.category;
      p.auto_reply_category = cls.category;
      p.auto_reply_at = new Date().toISOString();
      p.auto_reply_status = "sent";
      p.auto_reply_id = res.id || null;
      log.ok(`  Auto-reponse ${cls.category} -> ${p.email_to} (resend ${res.id || "?"})`);
      await sendNotification({ prospect: p, classification: cls, action: "auto_replied", incoming: ctx, reply });
      processed.set.add(inc.msgId);
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }

    // --- 4. Escalade : un humain a repondu mais on ne repond pas auto ---
    stats.escalated++;
    const why = !capOk ? "cap atteint" : !confOk ? `confiance ${cls.confidence}` : cls.category;
    log.info(`  [ESCALADE] ${p.email_to} (${why}) -> notif a Joachim`);
    if (SEND) {
      p.email_status = "replied"; // un humain a repondu -> stoppe les relances
      p.replied_at = inc.date;
      p.reply_category = cls.category;
      await sendNotification({ prospect: p, classification: cls, action: "escalate", incoming: ctx, reply: null });
      processed.set.add(inc.msgId);
    }
  }

  if (SEND) {
    saveCrm(crm);
    fs.writeFileSync(processed.f, JSON.stringify([...processed.set], null, 2), "utf8");
  }

  log.step("Resultat");
  log.ok(
    `Auto-reponses: ${stats.auto_replied} | escalades: ${stats.escalated} | ` +
      `STOP: ${stats.unsubscribed} | ignores: ${stats.skipped} | echecs: ${stats.failed}`
  );
  if (!SEND) log.warn("DRY-RUN : rien n'a ete envoye ni enregistre. Ajoutez --send pour agir.");
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
