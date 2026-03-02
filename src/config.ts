import * as fs from "fs";
import * as path from "path";

const CONFIG_DIR = path.join(process.cwd(), "config");

function loadMarkdown(filename: string): string {
  const filePath = path.join(CONFIG_DIR, filename);
  try {
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    console.warn(`[config] Warning: could not load ${filePath}`);
    return "";
  }
}

export interface BotConfig {
  businessInfo: string;
  services: string;
  pricing: string;
  faq: string;
  personaStyle: string;
}

export function loadConfig(): BotConfig {
  return {
    businessInfo: loadMarkdown("business.md"),
    services: loadMarkdown("services.md"),
    pricing: loadMarkdown("pricing.md"),
    faq: loadMarkdown("faq.md"),
    personaStyle: loadMarkdown("persona.md"),
  };
}
