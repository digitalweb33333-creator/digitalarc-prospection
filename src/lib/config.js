// Chargement centralise de la config + .env
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..", "..");

const readJson = (rel) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/^﻿/, "")); // strip BOM

export const professions = readJson("config/professions.json").professions;
export const regions = readJson("config/regions.json").countries;
export const scoring = readJson("config/scoring.json");
const offersFile = readJson("config/offers.json");
export const offers = offersFile.offers;
export const defaultOffer = offersFile.default;

export const env = {
  apifyToken: process.env.APIFY_TOKEN,
  apifyActor: process.env.APIFY_GMAPS_ACTOR || "compass/crawler-google-places",
  maxPlacesPerSearch: Number(process.env.APIFY_MAX_PLACES_PER_SEARCH || 50),
  minScore: Number(process.env.MIN_SCORE || 7),
};

// Cree un dossier sous data/ et renvoie son chemin absolu.
export function dataDir(sub) {
  const dir = path.join(ROOT, "data", sub);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Petit parseur d'arguments CLI : --flag ou --key=value
export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (const a of argv) {
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      args[k] = v === undefined ? true : v;
    } else {
      args._.push(a);
    }
  }
  return args;
}
