// Message Assistant: runtime configuration from the environment (install.sh writes /etc/messageassistant/env).
// No secrets live here unless the admin chooses to put AI keys in the env file (they are imported once, encrypted).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(here, '..');
export const VERSION = fs.readFileSync(path.join(APP_DIR, 'VERSION'), 'utf8').trim();
export const PRODUCT = 'Message Assistant';

const env = process.env;
const int = (v, d) => { const n = parseInt(v ?? '', 10); return Number.isFinite(n) ? n : d; };
export const cfg = {
  dataDir: env.MSA_DATA_DIR || '/var/lib/messageassistant',
  port: int(env.MSA_PORT, 8788),
  host: env.MSA_HOST || '127.0.0.1',
  publicUrl: (env.MSA_PUBLIC_URL || 'http://127.0.0.1:8788').replace(/\/+$/, ''),
  testMode: env.MSA_TEST_MODE === '1',
  mockModule: env.MSA_MOCK_MODULE || '',
  geminiBase: env.MSA_GEMINI_BASE || '',          // test override
  cloudflareBase: env.MSA_CLOUDFLARE_BASE || '',  // test override (ends in /client/v4)
  searchBase: env.MSA_SEARCH_BASE || '',          // test override for web_search
  // Google Messages channel: 'web' = the real Playwright driver; 'mock' = in-memory (tests); 'off'
  channel: env.MSA_CHANNEL || 'web',
  gmUrl: (env.MSA_GM_URL || 'https://messages.google.com/web').replace(/\/+$/, ''),
  chromium: env.MSA_CHROMIUM || '',               // path to a Chromium; blank = Playwright's own (PLAYWRIGHT_BROWSERS_PATH)
  pollMs: int(env.MSA_POLL_MS, 4000),             // how often the conversation list is read (gentle)
  healthMs: int(env.MSA_HEALTH_MS, 30000),
  tickMs: int(env.MSA_TICK_MS, 20000),            // reminders
  countryCode: env.MSA_COUNTRY_CODE || '1',       // for numbers written without +
};
export function isHttps() { return cfg.publicUrl.startsWith('https://'); }
