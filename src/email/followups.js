// ============================================================
// Relances automatiques J+3 / J+7 / J+14
// ------------------------------------------------------------
// A lancer une fois par jour (Task Scheduler Windows, cron, ou Make).
// Parcourt le CRM, trouve les prospects dont une relance est due,
// envoie un message de relance plus court via la rotation SMTP,
// dans le respect des memes caps et de la suppression (opt-out).
//
// Un prospect qui a repondu (email_status = "replied") ou s'est
// desinscrit n'est jamais relance.
//
// Usage :
//   node src/email/followups.js            (DRY-RUN)
//   node src/email/followups.js --send     (envoi reel)
// ============================================================
import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import { log } from "../lib/logger.js";
import { parseArgs, ROOT, professions } from "../lib/config.js";
import {
  loadCrm, saveCrm, loadSuppression, recordSend, sentToday, pushToMake,
} from "../lib/crm.js";

const args = parseArgs();
const SEND = Boolean(args.send);
const DAILY_CAP = Number(process.env.DAILY_EMAIL_CAP || 400);
const PER_MAILBOX = Number(process.env.PER_MAILBOX_DAILY || 25);
const MAKE_WEBHOOK = process.env.MAKE_WEBHOOK_CRM || "";
const senderName = process.env.SENDER_NAME || "Digitalarc";
const replyTo = process.env.SENDER_REPLY_TO || process.env.SMTP1_USER;

function mailboxes() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = String(process.env.SMTP_SECURE || "true") === "true";
  const boxes = [];
  for (let i = 1; i <= 4; i++) {
    const user = process.env[`SMTP${i}_USER`];
    const pass = process.env[`SMTP${i}_PASS`];
    if (user && pass)
      boxes.push({ user, transport: nodemailer.createTransport({ host, port, secure, auth: { user, pass } }) });
  }
  return boxes;
}

const profById = Object.fromEntries(professions.map((p) => [p.id, p]));

// Corps de relance selon l'etape
function followupBody(p, stage) {
  const site = process.env.SENDER_WEBSITE || "https://digitalarc.fr";
  const link = site.replace(/^https?:\/\//, "");
  const optoutUrl = `${site}/stop?e=${encodeURIComponent(p.email_to)}`;
  const ville = p.locality || "votre ville";
  const sig = `Joachim\nDigitalarc — ${link}`;

  // Variables metier dynamiques (memes valeurs que le mail initial)
  const prof = profById[p.profession] || {};
  const metierSing = prof.label_singular || (prof.label ? prof.label.toLowerCase() : "professionnel");
  const clientNoun = prof.client_noun || "clients";
  const article = prof.article_indef || "un";

  // Corps du message (sans signature) - [NOM]=p.title, [VILLE]=p.locality
  const messages = {
    1: `Bonjour,\n\nJe n'ai pas eu de retour, je comprends que vous êtes occupé.\n\nSachez juste que chaque semaine sans présence en ligne complète, c'est des ${clientNoun} qui cherchent ${article} ${metierSing} à ${ville} sur Google ou sur ChatGPT et qui tombent sur votre concurrent plutôt que sur vous.\n\nUn "OUI" et je vous montre ce que ça donnerait concrètement pour votre activité.`,
    2: `Bonjour,\n\nDernier message de ma part.\n\nJ'ai pris 10 minutes pour préparer un aperçu de votre futur site — structure, design, prise de rendez-vous en ligne.\n\nJe vous l'envoie ou je laisse tomber ?`,
    3: `Bonjour,\n\nJe clôture votre dossier de mon côté pour ne pas vous importuner.\n\nSi un jour vous voulez être enfin visible en ligne (et cité par les assistants IA), ma porte reste ouverte : répondez simplement à cet email.\n\nBien à vous,`,
  };
  const subjects = {
    1: `${p.title} : vos patients partent chez vos concurrents`,
    2: `${p.title} : dernier message de ma part`,
    3: `${p.title} : je clôture votre dossier`,
  };

  const body = messages[stage];
  const footer = `Pour ne plus être contacté : répondez STOP ou ${optoutUrl}`;
  const text = `${body}\n\n${sig}\n\n---\n${footer}`;

  // Version HTML : paragraphes + logo juste au-dessus de la signature
  const para = (s) => s.split("\n\n").map((blk) => `<p>${blk.replace(/\n/g, "<br>")}</p>`).join("\n");
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;line-height:1.55;max-width:600px">
${para(body)}
<p><img src="cid:logo" alt="Digitalarc" width="210" style="width:210px;height:auto;border-radius:8px;display:block"></p>
<p>Joachim<br>Digitalarc — <a href="${site}">${link}</a></p>
<hr style="border:none;border-top:1px solid #eee">
<p style="font-size:11px;color:#999">Pour ne plus etre contacte : repondez STOP ou <a href="${optoutUrl}">cliquez ici</a>.</p>
</body></html>`;

  return { subject: subjects[stage], text, html };
}

async function main() {
  const boxes = mailboxes();
  if (!boxes.length) return log.error("Aucune boite SMTP configuree.");

  // Logo Digitalarc (cid:logo) attache a chaque relance HTML
  const logoPath = path.join(ROOT, "assets", "logo.png");
  const logoAttachments = fs.existsSync(logoPath)
    ? [{ filename: "digitalarc.png", path: logoPath, cid: "logo" }]
    : [];

  const crm = loadCrm();
  const suppression = loadSuppression();
  const today = new Date().toISOString().slice(0, 10);
  const perBox = { ...sentToday() };
  let totalToday = Object.values(perBox).reduce((a, b) => a + b, 0);

  // Trouve les relances dues
  const due = [];
  for (const p of crm.values()) {
    if (p.email_status !== "sent" && p.email_status !== "followed_up") continue;
    if (suppression.has((p.email_to || "").toLowerCase())) continue;
    if (!Array.isArray(p.followups)) continue;
    const next = p.followups.find((f) => !f.sent && f.due <= today);
    if (next) due.push({ p, fu: next });
  }

  log.step(`Relances dues : ${due.length} (${SEND ? "ENVOI REEL" : "DRY-RUN"})`);
  if (!due.length) return log.ok("Aucune relance a envoyer aujourd'hui.");

  let rr = 0,
    sent = 0;
  for (const { p, fu } of due) {
    if (totalToday + sent >= DAILY_CAP) {
      log.warn("Cap global atteint. Stop.");
      break;
    }
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
      log.warn("Boites au cap. Stop.");
      break;
    }

    const { subject, text, html } = followupBody(p, fu.stage);
    if (!SEND) {
      log.info(`  [DRY] J+relance${fu.stage} ${box.user} -> ${p.email_to} | "${subject}"`);
      sent++;
      perBox[box.user] = (perBox[box.user] || 0) + 1;
      continue;
    }
    try {
      await box.transport.sendMail({
        from: `"${senderName}" <${box.user}>`,
        to: p.email_to,
        replyTo,
        subject,
        text,
        html,
        attachments: logoAttachments,
      });
      fu.sent = true;
      fu.sent_at = new Date().toISOString();
      p.followup_stage = fu.stage;
      p.email_status = "followed_up";
      recordSend(box.user);
      perBox[box.user] = (perBox[box.user] || 0) + 1;
      sent++;
      log.ok(`  Relance ${fu.stage} -> ${p.email_to} via ${box.user}`);
      await pushToMake({ ...p, event: `followup_${fu.stage}` }, MAKE_WEBHOOK);
      await new Promise((r) => setTimeout(r, 1500));
    } catch (e) {
      log.error(`  ECHEC relance ${p.email_to} : ${e.message}`);
    }
  }

  saveCrm(crm);
  log.step("Resultat");
  log.ok(`Relances ${SEND ? "envoyees" : "simulees"} : ${sent}`);
  if (!SEND) log.warn("DRY-RUN. Ajouter --send pour envoyer.");
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
