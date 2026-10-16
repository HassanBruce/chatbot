import fs from 'node:fs';
import path from 'node:path';

// Tiny .env loader (no dependency). Real env vars win over .env.
const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const num = (k, d) => Number(env(k, d));
const bool = (k, d) => String(env(k, d)).toLowerCase() === 'true';

export const config = {
  production: env('NODE_ENV', 'development') === 'production',
  port: num('PORT', 3000),
  domain: env('DOMAIN', ''),
  dataDir: env('DATA_DIR', './data'),
  businessesDir: env('BUSINESSES_DIR', './businesses'),
  timezone: env('TZ_BUSINESS', 'Asia/Karachi'),

  // WhatsApp Cloud API
  verifyToken: env('WA_VERIFY_TOKEN', ''),
  appSecret: env('WA_APP_SECRET', ''),          // verifies webhook signatures + embedded signup code exchange
  waToken: env('WA_ACCESS_TOKEN', ''),          // default token; business file / onboarded account can override
  graphVersion: env('WA_GRAPH_VERSION', 'v23.0'),
  graphBase: env('WA_GRAPH_BASE', 'https://graph.facebook.com'),

  // Embedded Signup (client connects their own number, incl. coexistence with the WhatsApp Business app)
  metaAppId: env('META_APP_ID', ''),
  esConfigId: env('ES_CONFIG_ID', ''),

  // Owner alerts outside the 24h window need an approved template (1 body variable {{1}})
  ownerAlertTemplate: env('OWNER_ALERT_TEMPLATE', ''),
  ownerAlertTemplateLang: env('OWNER_ALERT_TEMPLATE_LANG', 'en'),

  // AI (any OpenAI-compatible endpoint; default = Gemini)
  aiBaseUrl: env('AI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/openai'),
  aiApiKey: env('AI_API_KEY', ''),
  aiModel: env('AI_MODEL', 'gemini-2.5-flash-lite'),
  aiTimeoutMs: num('AI_TIMEOUT_MS', 25000),
  historyLimit: num('HISTORY_LIMIT', 16),

  // Behaviour
  debounceMs: num('DEBOUNCE_MS', 2500),          // wait for the customer to finish typing several short messages
  maxMsgsPerHour: num('MAX_MSGS_PER_HOUR', 40),  // per customer; protects your AI bill from spam
  handoffPauseHours: num('HANDOFF_PAUSE_HOURS', 6),
  ownerReplyPauseHours: num('OWNER_REPLY_PAUSE_HOURS', 12), // owner replied from the app → bot stays quiet
  resumeMarker: env('BOT_RESUME_MARKER', '🤖'),  // owner ends an app message with this → bot takes over again
  mediaDownload: bool('MEDIA_DOWNLOAD', 'true'),
  mediaMaxBytes: num('MEDIA_MAX_MB', 16) * 1024 * 1024,

  // Admin dashboard
  adminPassword: env('ADMIN_PASSWORD', ''),
  backupKeepDays: num('BACKUP_KEEP_DAYS', 14),
};

/** Refuses to boot in production with unsafe/missing settings. Returns a list of problems. */
export function configProblems(c = config) {
  const p = [];
  if (!c.appSecret) p.push('WA_APP_SECRET is empty (webhook signatures cannot be verified)');
  if (!c.verifyToken || c.verifyToken === 'change-me-random-string') p.push('WA_VERIFY_TOKEN is not set to a random value');
  if (!c.adminPassword || c.adminPassword.length < 12 || c.adminPassword.startsWith('change-me')) p.push('ADMIN_PASSWORD must be at least 12 characters and not the example value');
  if (!c.aiApiKey) p.push('AI_API_KEY is empty');
  return p;
}
