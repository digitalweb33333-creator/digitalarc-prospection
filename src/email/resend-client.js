// ============================================================
// Client Resend (API HTTP) - sans dependance, fetch natif Node >=20
// ------------------------------------------------------------
// Envoi des reponses automatiques aux prospects depuis contact@digitalarc.fr.
// Le domaine digitalarc.fr doit etre verifie dans Resend (SPF/DKIM) pour
// une bonne delivrabilite.
//
// Variables .env utilisees :
//   RESEND_API_KEY   (obligatoire pour l'envoi reel)
//   RESEND_FROM      (defaut : "Joachim - Digitalarc <contact@digitalarc.fr>")
// ============================================================
const RESEND_ENDPOINT = "https://api.resend.com/emails";

export function resendConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

export function defaultFrom() {
  return (
    process.env.RESEND_FROM ||
    `${process.env.SENDER_NAME || "Joachim - Digitalarc"} <contact@digitalarc.fr>`
  );
}

// Envoie un email via Resend. Renvoie { ok, id } ou { ok:false, error }.
// headers : objet optionnel (ex. threading In-Reply-To / References).
export async function sendViaResend({ to, subject, text, html, replyTo, headers, from }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: "RESEND_API_KEY manquant" };

  const payload = {
    from: from || defaultFrom(),
    to: Array.isArray(to) ? to : [to],
    subject,
    ...(text ? { text } : {}),
    ...(html ? { html } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(headers ? { headers } : {}),
  };

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data?.message || `HTTP ${res.status}`, status: res.status };
    }
    return { ok: true, id: data?.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
