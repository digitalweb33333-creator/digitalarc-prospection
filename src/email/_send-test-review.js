// ============================================================
// SCRIPT DE TEST (review) - n'altere PAS le CRM ni le sendlog.
// Envoie les 3 emails (initial + relance 1 + relance 2) pour un
// faux prospect "Dr Martin" vers une adresse de relecture, en
// version HTML (avec logo) + texte. Les fonctions sont copiees
// VERBATIM des modules de prod (generate-emails.js / followups.js)
// pour que le rendu soit identique a l'envoi reel.
// Usage : node src/email/_send-test-review.js
// ============================================================
import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import { offers, defaultOffer, professions, ROOT } from "../lib/config.js";
import { humanize } from "./humanize.js";

const REVIEW_TO = "joachim33333@outlook.fr";

const sender = {
  name: process.env.SENDER_NAME || "Joachim - Digitalarc",
  company: process.env.SENDER_COMPANY || "Digitalarc",
  website: process.env.SENDER_WEBSITE || "https://digitalarc.fr",
  replyTo: process.env.SENDER_REPLY_TO || "contact@digitalarc.fr",
};
const profById = Object.fromEntries(professions.map((p) => [p.id, p]));

// --- copie verbatim de generate-emails.js ---------------------------------
function problemsSentence(detail = {}) {
  const map = {
    pas_de_site: "vous n'avez pas encore de site web visible",
    pas_https: "votre site n'affiche pas le cadenas de sécurité (HTTPS)",
    site_avant_2020: "votre site actuel n'est plus optimisé pour mobile",
    absent_chatgpt: "les assistants IA (ChatGPT, Perplexity) ne vous citent pas quand on cherche un professionnel comme vous",
    gmb_incomplet: "votre fiche Google n'est pas complète",
    intention_achat: "votre activité vient d'être créée, c'est le moment idéal pour bien démarrer en ligne",
  };
  return Object.keys(detail).filter((k) => detail[k] && map[k]).map((k) => map[k]);
}

function subjectFor(p) {
  if (p.absent_chatgpt) return `${p.title} : ChatGPT ne vous trouve pas`;
  if (p.score_detail?.pas_de_site) return `${p.title} : vos patients vous cherchent en ligne`;
  return `${p.title} : votre visibilite en ligne`;
}

function buildBody(p) {
  const prof = profById[p.profession] || { angle: "vos clients vous cherchent en ligne", label: "professionnel" };
  const offer = offers[p.profession] || defaultOffer; // (conserve, non utilise dans le template actuel)
  const problems = problemsSentence(p.score_detail);
  const optoutToken = encodeURIComponent(p.email_to || p.place_id);
  const optoutUrl = `${sender.website}/stop?e=${optoutToken}`;
  const link = sender.website.replace(/^https?:\/\//, "");
  const hasShot = Boolean(p.screenshot_url);
  const metier = prof.label.toLowerCase();
  const metierSing = prof.label_singular || metier;

  const intro = `Je suis Joachim de Digitalarc, j'aide les ${metier} comme vous à attirer de nouveaux clients grâce à une présence complète en ligne (exemples sur ${link}).`;
  const context = `Aujourd'hui, un client choisit son ${metierSing} selon sa visibilité et ses avis en ligne.`;
  const probLine = problems.length ? `Concrètement pour ${p.title} : ${problems.join(" ; ")}.` : "";
  const bullets = [
    "Site livré en 7 à 14 jours, prise de rendez-vous en ligne intégrée",
    "Visible sur Google et par les IA (ChatGPT, Perplexity...)",
    "Orienté vers vos services les plus rentables",
  ];
  const offerIntro = "Nous pouvons régler ça efficacement :";
  const offerOutro = "Sans engagement, vous gardez la pleine propriété — ou nous gérons tout si vous préférez.";
  const cta = `Si cela vous intéresse, répondez juste "OUI" et je vous envoie un exemple concret pour votre activité.`;

  const H = (s) => humanize(s).text;
  const b = {
    intro: H(intro), context: H(context), prob: H(probLine),
    offerIntro: H(offerIntro), offerOutro: H(offerOutro), cta: H(cta),
  };

  const text = humanize(
    `Bonjour,

${b.intro}

${b.context}${b.prob ? " " + b.prob : ""}

${b.offerIntro}
${bullets.map((x) => "- " + x).join("\n")}

${b.offerOutro}

${b.cta}

Bien à vous,
Joachim
Digitalarc — ${link}

---
Vous recevez cet email car votre activité est référencée publiquement.
Pour ne plus être contacté : répondez STOP ou ${optoutUrl}
${sender.company}`
  ).text;

  const proofImg = hasShot
    ? `<p><em>Preuve : voici ce qu'une IA répond quand on cherche ${p.title} :</em></p>
<img src="cid:proofshot" alt="Preuve invisibilite IA" style="max-width:100%;border:1px solid #ddd;border-radius:6px">`
    : "";
  const bulletsHtml = `<ul>${bullets.map((x) => `<li>${x}</li>`).join("")}</ul>`;

  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;line-height:1.55;max-width:600px">
<p>Bonjour,</p>
<p>${b.intro.replace(link, `<a href="${sender.website}">${link}</a>`)}</p>
<p>${b.context}${b.prob ? " " + b.prob : ""}</p>
${proofImg}
<p>${b.offerIntro}</p>
${bulletsHtml}
<p>${b.offerOutro}</p>
<p>${b.cta}</p>
<p>Bien à vous,</p>
<p><img src="cid:logo" alt="Digitalarc" width="210" style="width:210px;height:auto;border-radius:8px;display:block"></p>
<p>Joachim<br>Digitalarc — <a href="${sender.website}">${link}</a></p>
<hr style="border:none;border-top:1px solid #eee">
<p style="font-size:11px;color:#999">Vous recevez cet email car votre activite est referencee publiquement.
Pour ne plus etre contacte : repondez STOP ou <a href="${optoutUrl}">cliquez ici</a>.<br>${sender.company}</p>
</body></html>`;

  return { subject: subjectFor(p), text, html };
}

// --- copie verbatim de followups.js ---------------------------------------
function followupBody(p, stage) {
  const site = process.env.SENDER_WEBSITE || "https://digitalarc.fr";
  const link = site.replace(/^https?:\/\//, "");
  const optoutUrl = `${site}/stop?e=${encodeURIComponent(p.email_to)}`;
  const ville = p.locality || "votre ville";
  const sig = `Joachim\nDigitalarc — ${link}`;
  const prof = profById[p.profession] || {};
  const metierSing = prof.label_singular || (prof.label ? prof.label.toLowerCase() : "professionnel");
  const clientNoun = prof.client_noun || "clients";
  const article = prof.article_indef || "un";
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
  const p = {
    place_id: "TEST_DR_MARTIN",
    title: "Dr Martin",
    profession: "dentistes",
    country: "FR",
    locality: "Paris",
    email_to: REVIEW_TO,
    absent_chatgpt: false,
    score: 8,
    score_detail: { pas_de_site: true },
    screenshot_url: null,
  };

  const initial = buildBody(p);
  p.email_subject = initial.subject;
  const r1 = followupBody(p, 1);
  const r2 = followupBody(p, 2);

  const logoPath = path.join(ROOT, "assets", "logo.png");
  const attachments = fs.existsSync(logoPath)
    ? [{ filename: "digitalarc.png", path: logoPath, cid: "logo" }]
    : [];
  if (!attachments.length) console.warn("ATTENTION: assets/logo.png introuvable - emails sans logo.");

  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true") === "true",
    auth: { user: process.env.SMTP1_USER, pass: process.env.SMTP1_PASS },
  });

  const from = `"${sender.name}" <${process.env.SMTP1_USER}>`;
  const emails = [
    { tag: "MAIL INITIAL", ...initial },
    { tag: "RELANCE 1 (J+3)", ...r1 },
    { tag: "RELANCE 2 (J+7)", ...r2 },
  ];

  for (const e of emails) {
    const note = `(Email de relecture - ${e.tag} - faux prospect Dr Martin)`;
    const info = await transport.sendMail({
      from,
      to: REVIEW_TO,
      replyTo: sender.replyTo,
      subject: `[TEST RELECTURE] ${e.subject}`,
      text: `${note}\n\n----------------------------------------\n\n${e.text}`,
      html: `<p style="color:#999;font-size:12px">${note}</p><hr>${e.html}`,
      attachments,
    });
    console.log(`OK  ${e.tag}  ->  ${REVIEW_TO}  | sujet: "${e.subject}"  | id: ${info.messageId}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log("\n3 emails de relecture envoyes (HTML + logo). CRM et sendlog NON modifies.");
}

main().catch((e) => {
  console.error("ECHEC:", e.message);
  process.exit(1);
});
