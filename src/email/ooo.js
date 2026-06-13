// ============================================================
// Detection des auto-repondeurs d'absence (Out Of Office / OOO)
// ------------------------------------------------------------
// Partage entre watch-replies.js et auto-reply.js pour eviter toute
// divergence. Un OOO N'EST PAS une vraie reponse de prospect : il ne doit
// ni stopper les relances, ni declencher une reponse auto / escalade.
//
// Detection en 3 couches (la plus fiable d'abord) :
//   1) en-tetes standard (RFC 3834) : Auto-Submitted, X-Autoreply, etc.
//   2) objet (FR / EN / DE)
//   3) corps (FR / EN)
//
// NB : l'appelant doit TOUJOURS tester STOP/desinscription AVANT l'OOO,
// pour que l'opt-out (RGPD) prime sur un eventuel "absent + STOP".
// ============================================================

export const OOO_HEADER_RE = /^(?:auto-submitted\s*:\s*auto-(?:replied|generated|notified)|x-autoreply\s*:\s*yes|x-autorespond\s*:|x-auto-response-suppress\s*:|precedence\s*:\s*(?:auto_reply|auto-reply|bulk))/im;
export const OOO_SUBJ_RE = /\b(?:absence|absent|out[ -]of[ -]office|automatic reply|auto[ -]?reply|autoreply|r[ée]ponse automatique|message automatique|notification d'absence|en cong[ée]s?|en d[ée]placement|on (?:annual )?leave|vacation (?:reply|responder)|abwesenheit)\b/i;
export const OOO_BODY_RE = /\b(?:actuellement (?:absent|en d[ée]placement|en cong[ée]s?)|je suis absent|de retour le|sera trait[ée](?:e)? (?:le|a mon retour|des mon retour)|reprise de mes mails|currently (?:out of (?:the )?office|away|on leave)|i am (?:currently )?(?:out of (?:the )?office|away)|back (?:on|in the office)|will be back)\b/i;

// Renvoie true si le message ressemble a un auto-repondeur d'absence.
export function isAutoResponder({ subject = "", body = "", headers = "" } = {}) {
  return OOO_HEADER_RE.test(headers) || OOO_SUBJ_RE.test(subject) || OOO_BODY_RE.test(body);
}
