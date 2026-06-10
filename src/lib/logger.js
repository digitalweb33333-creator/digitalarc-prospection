// Logger minimal horodate, sans dependance.
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

export const log = {
  info: (...a) => console.log(`[${ts()}] [INFO]`, ...a),
  warn: (...a) => console.warn(`[${ts()}] [WARN]`, ...a),
  error: (...a) => console.error(`[${ts()}] [ERR ]`, ...a),
  ok: (...a) => console.log(`[${ts()}] [ OK ]`, ...a),
  step: (...a) => console.log(`\n[${ts()}] === ${a.join(" ")} ===`),
};
