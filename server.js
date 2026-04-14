const Sentry = require('@sentry/node');
Sentry.init({
  dsn: 'https://31da2b9952ea872e1bbb45f89e0fb165@o4511182949187584.ingest.us.sentry.io/4511182964064256',
  environment: process.env.NODE_ENV || 'production',
  tracesSampleRate: 0.2,
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
// Load .env manually (no dotenv dependency needed)
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
    });
  }
} catch {}
const https = require('https');

const GOOGLE_PLACES_KEY = process.env.GOOGLE_PLACES_KEY || 'AIzaSyBeVC6nzT8jsBk7qsjUCpRE2DPpV8YdpyY';

// ── WEB PUSH ─────────────────────────────────────────────────────────────────
const webpush = require('web-push');
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BEB7qxizcZPZZThVWHfUtHbc98rsiYJ6RoT15EoFQYJBuRojwm_eTDZK6tUAqmBfsiTgUTTOYT505E4_nWXf5l8';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try {
    webpush.setVapidDetails('mailto:info@backlotlive.com.au', VAPID_PUBLIC, VAPID_PRIVATE);
    console.log('✅ Push notifications enabled');
  } catch (e) {
    console.warn('⚠️  Push notification setup failed:', e.message);
  }
} else {
  console.warn('⚠️  VAPID keys not set — push notifications disabled');
}

// In-memory push subscription store (keyed by driverName)
let pushSubscriptions = {}; // { driverName: { subscription, vehicle, phone } }

// In-memory assigned moves store
let assignedMoves = {}; // { driverName: moveDetails }

// In-memory vehicle locations (live GPS)
let vehicleLocations = {}; // { driverName: { lat, lng, vehicle, timestamp } }

// In-memory key handovers { driverName: { keyLocation, keyPhoto, vehicleId, timestamp } }
let keyHandovers = {};

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ── CORS — restrict to known origins ────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://backlot-live-app.vercel.app',
  'https://backlotlive.com.au',
  'https://www.backlotlive.com.au',
  'http://localhost:8081',
  'http://localhost:4000',
  'http://192.168.0.184:8081',
  'http://192.168.0.251:8081',
];
app.use(cors({ origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin)) }));
app.use(express.json({ limit: '10mb' }));

// ── ADMIN AUTH MIDDLEWARE ─────────────────────────────────────────────────────
const ADMIN_KEY = process.env.ADMIN_KEY || 'backlot-admin-2026';
const requireAdmin = (req, res, next) => {
  const key = req.headers['x-admin-key'] || req.query.adminKey;
  if (key === ADMIN_KEY) return next();
  res.status(401).json({ error: 'Admin authentication required' });
};

// ── SENSITIVE FIELD STRIP ─────────────────────────────────────────────────────
const SENSITIVE_FIELDS = ['tfn', 'bsb', 'acc', 'bankAccountName', 'bankName', 'licencePhoto', 'idPhoto', 'signatureDataUrl', 'profilePhoto'];
const stripSensitive = (obj) => { const c = { ...obj }; SENSITIVE_FIELDS.forEach(f => delete c[f]); return c; };

// Serve the full compiled Expo app
const APP_DIST = process.env.APP_DIST || path.join('/Users/jamiedorward/.openclaw/workspace/backlot-live-app/dist');
const FRONTEND = process.env.FRONTEND_PATH || path.join('/Users/jamiedorward/Desktop/BasecampLive_Prototypes_and_Blueprint/frontend');
// Static file serving
const serveAppStatic = express.static(APP_DIST, { fallthrough: true, extensions: ['html'] });
const serveFrontendStatic = express.static(FRONTEND, { fallthrough: true, extensions: ['html'] });
app.use((req, res, next) => {
  serveAppStatic(req, res, () => serveFrontendStatic(req, res, next));
});

// ── DB FILE PATHS ─────────────────────────────────────────────────────────────
const CATERING_PREFS_FILE = path.join(__dirname, 'catering_preferences.json');
const PRODUCTION_FILE     = path.join(__dirname, 'production_db.json');
const DB_FILE             = path.join(__dirname, 'crew_db.json');
const RECEIPTS_FILE       = path.join(__dirname, 'receipts_db.json');
const CATERING_FILE       = path.join(__dirname, 'catering_db.json');
const TIMESHEETS_FILE     = path.join(__dirname, 'timesheets_db.json');
const PAYROLL_FILE        = path.join(__dirname, 'payroll_batches.json');
const INCIDENTS_FILE      = path.join(__dirname, 'incidents_db.json');
const ASSETS_FILE         = path.join(__dirname, 'assets_db.json');
const DPR_FILE            = path.join(__dirname, 'dpr_db.json');
const PRODUCTIONS_REGISTRY_FILE = path.join(__dirname, 'productions_registry.json');

[DB_FILE, RECEIPTS_FILE, CATERING_FILE, CATERING_PREFS_FILE, TIMESHEETS_FILE, PAYROLL_FILE, INCIDENTS_FILE, ASSETS_FILE, DPR_FILE].forEach(f => {
  if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify([]));
});
if (!fs.existsSync(PRODUCTION_FILE)) fs.writeFileSync(PRODUCTION_FILE, JSON.stringify({}));

// ── PRODUCTIONS REGISTRY ──────────────────────────────────────────────────────
if (!fs.existsSync(PRODUCTIONS_REGISTRY_FILE)) {
  fs.writeFileSync(PRODUCTIONS_REGISTRY_FILE, JSON.stringify([
    {
      id: 'DEMO01',
      code: 'DEMO01',
      title: 'BACKLOT LIVE — DEMO PRODUCTION',
      company: 'Backlot Live',
      createdAt: '2026-04-14T00:00:00Z',
      createdBy: 'Jamie Dorward',
      isDemo: true,
      active: true,
    }
  ], null, 2));
}
let productionsRegistry = JSON.parse(fs.readFileSync(PRODUCTIONS_REGISTRY_FILE));

// ── LEGACY GLOBAL VARS (used by payroll, catering cron, socket.io) ─────────────
let production   = JSON.parse(fs.readFileSync(PRODUCTION_FILE));
let cateringPrefs= JSON.parse(fs.readFileSync(CATERING_PREFS_FILE));
let crew         = JSON.parse(fs.readFileSync(DB_FILE));
let receipts     = JSON.parse(fs.readFileSync(RECEIPTS_FILE));
let catering     = JSON.parse(fs.readFileSync(CATERING_FILE));
let timesheets   = JSON.parse(fs.readFileSync(TIMESHEETS_FILE));
let payrollBatches = JSON.parse(fs.readFileSync(PAYROLL_FILE));
let incidents    = JSON.parse(fs.readFileSync(INCIDENTS_FILE));
let assets       = JSON.parse(fs.readFileSync(ASSETS_FILE));
let dprs         = JSON.parse(fs.readFileSync(DPR_FILE));
let musterEvents  = [];
let musterResponses = [];
let activeRequests = [];

// ── MULTI-PRODUCTION HELPERS ──────────────────────────────────────────────────
// For DEMO01 we use root-level files so payroll/socket/legacy code keeps working.
// All other productions get their own productions/{CODE}/ directory.

function getProductionFilePath(code, filename) {
  const safeCode = (code || 'DEMO01').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 10);

  if (safeCode === 'DEMO01') {
    const rootMap = {
      'crew_db.json': DB_FILE,
      'timesheets_db.json': TIMESHEETS_FILE,
      'receipts_db.json': RECEIPTS_FILE,
      'catering_preferences.json': CATERING_PREFS_FILE,
      'incidents_db.json': INCIDENTS_FILE,
      'production_db.json': PRODUCTION_FILE,
      'dpr_db.json': DPR_FILE,
    };
    if (rootMap[filename]) return rootMap[filename];
  }

  const dir = path.join(__dirname, 'productions', safeCode);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filepath = path.join(dir, filename);
  if (!fs.existsSync(filepath)) {
    const defaults = {
      'crew_db.json': [],
      'timesheets_db.json': [],
      'receipts_db.json': [],
      'catering_preferences.json': [],
      'incidents_db.json': [],
      'dpr_db.json': [],
    };
    const defaultVal = defaults[filename] !== undefined ? defaults[filename] : {};
    fs.writeFileSync(filepath, JSON.stringify(defaultVal, null, 2));
  }
  return filepath;
}

function readProductionDb(code, filename) {
  return JSON.parse(fs.readFileSync(getProductionFilePath(code, filename), 'utf8'));
}

function writeProductionDb(code, filename, data) {
  fs.writeFileSync(getProductionFilePath(code, filename), JSON.stringify(data, null, 2));
  // Keep legacy global vars in sync for DEMO01 (so payroll, socket.io, catering cron work)
  const safeCode = (code || 'DEMO01').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 10);
  if (safeCode === 'DEMO01') {
    if (filename === 'crew_db.json')            crew          = data;
    else if (filename === 'timesheets_db.json') timesheets    = data;
    else if (filename === 'receipts_db.json')   receipts      = data;
    else if (filename === 'catering_preferences.json') cateringPrefs = data;
    else if (filename === 'incidents_db.json')  incidents     = data;
    else if (filename === 'production_db.json') production    = data;
  }
}

function saveProductionsRegistry() {
  fs.writeFileSync(PRODUCTIONS_REGISTRY_FILE, JSON.stringify(productionsRegistry, null, 2));
}

function generateProductionCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (productionsRegistry.some(p => p.code === code));
  return code;
}

// ── DEMO01 SEED (20 realistic Australian film crew) ───────────────────────────
// Only seeds if crew_db.json is empty on first run.
(function seedDEMO01() {
  const existing = readProductionDb('DEMO01', 'crew_db.json');
  if (existing.length > 0) return; // already seeded — don't overwrite

  const now = new Date().toISOString();
  const demoProduction = {
    id: 'prod_demo_2026',
    title: 'BACKLOT LIVE — DEMO PRODUCTION',
    role: '',
    department: '',
    joinedAt: now,
    studio: 'Village Roadshow Studios, Gold Coast QLD',
  };

  const seedCrew = [
    { name: 'Sarah Chen',       phone: '0412 100 001', role: 'Director of Photography',     department: 'CAMERA',              email: 'sarah.chen@filmmail.com.au',       tshirtSize: 'S',  dietary: 'Vegetarian' },
    { name: 'Marcus Webb',      phone: '0412 100 002', role: 'Gaffer',                       department: 'LIGHTING & ELECTRICAL', email: 'marcus.webb@filmmail.com.au',      tshirtSize: 'XL', dietary: 'None / No Requirements' },
    { name: 'Jade Prentice',    phone: '0412 100 003', role: 'Art Director',                 department: 'ART DEPARTMENT',        email: 'jade.prentice@filmmail.com.au',    tshirtSize: 'M',  dietary: 'None / No Requirements' },
    { name: 'Tom Falconer',     phone: '0412 100 004', role: 'Sound Recordist',              department: 'SOUND',                 email: 'tom.falconer@filmmail.com.au',     tshirtSize: 'L',  dietary: 'None / No Requirements' },
    { name: 'Rosa Nguyen',      phone: '0412 100 005', role: 'Key Hair & Makeup',            department: 'HAIR & MAKEUP',         email: 'rosa.nguyen@filmmail.com.au',      tshirtSize: 'XS', dietary: 'Vegan' },
    { name: 'Darren Oakes',     phone: '0412 100 006', role: 'Transport Captain',            department: 'TRANSPORT',             email: 'darren.oakes@filmmail.com.au',     tshirtSize: 'XXL',dietary: 'None / No Requirements' },
    { name: 'Kelli Morrison',   phone: '0412 100 007', role: 'Props Master',                 department: 'ART DEPARTMENT',        email: 'kelli.morrison@filmmail.com.au',   tshirtSize: 'S',  dietary: 'Gluten Free' },
    { name: 'Owen Beattie',     phone: '0412 100 008', role: 'Best Boy Electric',            department: 'LIGHTING & ELECTRICAL', email: 'owen.beattie@filmmail.com.au',     tshirtSize: 'L',  dietary: 'None / No Requirements' },
    { name: 'Amelia Tan',       phone: '0412 100 009', role: 'Costume Designer',             department: 'WARDROBE & COSTUME',    email: 'amelia.tan@filmmail.com.au',       tshirtSize: 'S',  dietary: 'None / No Requirements' },
    { name: 'Jake Swanson',     phone: '0412 100 010', role: 'Key Grip',                     department: 'GRIP',                  email: 'jake.swanson@filmmail.com.au',     tshirtSize: 'XL', dietary: 'None / No Requirements' },
    { name: 'Priya Sharma',     phone: '0412 100 011', role: 'Line Producer',                department: 'PRODUCTION',            email: 'priya.sharma@filmmail.com.au',     tshirtSize: 'M',  dietary: 'Halal' },
    { name: 'Michael Donellan', phone: '0412 100 012', role: '1st Assistant Director',       department: 'DIRECTING',             email: 'michael.donellan@filmmail.com.au', tshirtSize: 'XL', dietary: 'None / No Requirements' },
    { name: 'Fiona Blake',      phone: '0412 100 013', role: '2nd Assistant Director',       department: 'DIRECTING',             email: 'fiona.blake@filmmail.com.au',      tshirtSize: 'S',  dietary: 'None / No Requirements' },
    { name: 'Curtis Hall',      phone: '0412 100 014', role: 'Camera Operator',              department: 'CAMERA',                email: 'curtis.hall@filmmail.com.au',      tshirtSize: 'L',  dietary: 'None / No Requirements' },
    { name: 'Renee Castillo',   phone: '0412 100 015', role: 'Script Supervisor',            department: 'DIRECTING',             email: 'renee.castillo@filmmail.com.au',   tshirtSize: 'M',  dietary: 'Pescatarian' },
    { name: 'Aaron Nguyen',     phone: '0412 100 016', role: 'Boom Operator',                department: 'SOUND',                 email: 'aaron.nguyen@filmmail.com.au',     tshirtSize: 'M',  dietary: 'None / No Requirements' },
    { name: 'Leila Fontaine',   phone: '0412 100 017', role: 'Set Decorator',                department: 'ART DEPARTMENT',        email: 'leila.fontaine@filmmail.com.au',   tshirtSize: 'XS', dietary: 'None / No Requirements' },
    { name: 'Ben Whitmore',     phone: '0412 100 018', role: 'Swing Driver',                 department: 'TRANSPORT',             email: 'ben.whitmore@filmmail.com.au',     tshirtSize: 'L',  dietary: 'None / No Requirements' },
    { name: 'Mei Ling',         phone: '0412 100 019', role: 'Catering Manager',             department: 'CATERING',              email: 'mei.ling@filmmail.com.au',         tshirtSize: 'XS', dietary: 'None / No Requirements' },
    { name: 'Sophie Grant',     phone: '0412 100 020', role: 'Production Coordinator',       department: 'PRODUCTION',            email: 'sophie.grant@filmmail.com.au',     tshirtSize: 'S',  dietary: 'None / No Requirements' },
  ];

  const seeded = seedCrew.map((c, i) => ({
    ...c,
    employmentType: i < 11 ? 'PAYG Employee' : 'Contractor / ABN',
    isDemo: true,
    timestamp: now,
    invitedAt: now,
    onboardedAt: now,
    contractSignedAt: now,
    firstLoginAt: now,
    lastSeen: now,
    passRevoked: false,
    productionHistory: [{ ...demoProduction, role: c.role, department: c.department }],
  }));

  writeProductionDb('DEMO01', 'crew_db.json', seeded);
  console.log(`🎬 DEMO01 seeded with ${seeded.length} crew members`);
})();

// ── DEMO01 production_db.json seed ─────────────────────────────────────────────
(function seedDEMO01Production() {
  const existing = readProductionDb('DEMO01', 'production_db.json');
  if (existing && Object.keys(existing).length > 0) return;
  const prod = {
    title: 'BACKLOT LIVE — DEMO PRODUCTION',
    productionCompany: 'Backlot Live Pty Ltd',
    genre: 'Feature Film — Drama',
    format: 'ARRI ALEXA 35 — 4K',
    shootStart: '14/04/2026',
    shootEnd: '30/06/2026',
    totalShootDays: '40',
    currentDay: '1',
    generalCall: '07:00',
    studio: 'Village Roadshow Studios Stage 5',
    state: 'QLD',
    unitBase: 'Village Roadshow Studios Stage 5, Gold Coast QLD',
    unitBaseAddress: 'Pacific Motorway, Oxenford QLD 4210',
    nearestHospital: 'Gold Coast University Hospital',
    hospitalDistance: '12 mins',
    nearestPolice: 'Oxenford Police Station — Siganto Drive, Helensvale',
    setAddress: 'Stage 5, Village Roadshow Studios, Pacific Motorway, Oxenford QLD',
    meetingPoint: 'Main entrance gate — beside the camera truck',
    parkingInfo: 'Crew park in Lot C. Enter via Gate 2 on Pacific Motorway.',
    director: 'Available on Request',
    producer: 'Demo Producer',
    safetyCode: '0412 100 001',
    weather: 'Fine, 26°C, light SE breeze',
    isDemo: true,
    updatedAt: new Date().toISOString(),
  };
  writeProductionDb('DEMO01', 'production_db.json', prod);
  console.log('🎬 DEMO01 production_db seeded');
})();

// ─── OVERTIME ENGINE ──────────────────────────────────────────────────────────
const MEAA_BASE_HOURLY = 58.50;
const MEAA_RATES = {
  ordinary: MEAA_BASE_HOURLY,
  overtime_1: MEAA_BASE_HOURLY * 1.5,
  overtime_2: MEAA_BASE_HOURLY * 2.0,
  seventh_day: MEAA_BASE_HOURLY * 2.0,
  meal_penalty_per_event: 14.05,
};

function calculatePay(hours, isSeventhDay, mealPenalties, rateConfig) {
  const rate = rateConfig || MEAA_RATES;
  if (isSeventhDay) return { ordinary: 0, ot1: 0, ot2: hours, mealPenalties, gross: hours * rate.seventh_day + mealPenalties * rate.meal_penalty_per_event };
  const ordinary = Math.min(hours, 10);
  const ot1 = Math.max(0, Math.min(hours - 10, 2));
  const ot2 = Math.max(0, hours - 12);
  const gross = ordinary * rate.ordinary + ot1 * rate.overtime_1 + ot2 * rate.overtime_2 + mealPenalties * rate.meal_penalty_per_event;
  return { ordinary, ot1, ot2, mealPenalties, gross };
}

function parseHoursFromTotal(totalStr) {
  if (!totalStr) return 0;
  const parts = totalStr.split(':').map(Number);
  return (parts[0] || 0) + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600;
}

function getWeekRange(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - (day === 0 ? 6 : day - 1));
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { start: monday, end: sunday };
}

function isInWeek(dateStr, { start, end }) {
  const d = new Date(dateStr);
  return d >= start && d <= end;
}

// ─── PRODUCTIONS MANAGEMENT ────────────────────────────────────────────────────

// GET /productions — list all productions
app.get('/productions', (req, res) => {
  res.json(productionsRegistry.filter(p => p.active));
});

// POST /productions/create — create new production
app.post('/productions/create', (req, res) => {
  const { title, company, createdBy } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const code = generateProductionCode();
  const entry = {
    id: code,
    code,
    title: title.toUpperCase(),
    company: company || '',
    createdAt: new Date().toISOString(),
    createdBy: createdBy || 'Unknown',
    isDemo: false,
    active: true,
  };
  productionsRegistry.push(entry);
  saveProductionsRegistry();

  // Create directory + seed empty files
  const dir = path.join(__dirname, 'productions', code);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const initFiles = {
    'crew_db.json': [],
    'timesheets_db.json': [],
    'receipts_db.json': [],
    'catering_preferences.json': [],
    'incidents_db.json': [],
    'dpr_db.json': [],
    'production_db.json': { title: entry.title, productionCompany: company || '', isDemo: false, createdAt: entry.createdAt },
  };
  Object.entries(initFiles).forEach(([fname, data]) => {
    fs.writeFileSync(path.join(dir, fname), JSON.stringify(data, null, 2));
  });

  console.log(`🎬 NEW PRODUCTION: ${entry.title} (${code})`);
  io.emit('new_production', entry);
  res.json({ success: true, code, id: code, title: entry.title });
});

// GET /productions/:code — get production details
app.get('/productions/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const entry = productionsRegistry.find(p => p.code === code);
  if (!entry) return res.status(404).json({ error: 'Production not found' });

  let crewCount = 0;
  try { crewCount = readProductionDb(code, 'crew_db.json').length; } catch {}

  res.json({ ...entry, crewCount });
});

// POST /productions/:code/reset — wipe crew/timesheets/catering for a production
app.post('/productions/:code/reset', (req, res) => {
  const key = req.headers['x-admin-key'] || req.body.adminKey;
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Admin key required' });
  const code = req.params.code.toUpperCase();
  const entry = productionsRegistry.find(p => p.code === code);
  if (!entry) return res.status(404).json({ error: 'Production not found' });

  writeProductionDb(code, 'crew_db.json', []);
  writeProductionDb(code, 'timesheets_db.json', []);
  writeProductionDb(code, 'receipts_db.json', []);
  writeProductionDb(code, 'catering_preferences.json', []);
  writeProductionDb(code, 'incidents_db.json', []);

  console.log(`♻️  PRODUCTION RESET: ${code}`);
  io.emit('production_reset', { code });
  res.json({ success: true, code, message: `${code} has been reset` });
});

// GET /owner/productions — owner dashboard (requires admin key)
app.get('/owner/productions', (req, res) => {
  const key = req.query.key || req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Admin key required' });

  const stats = productionsRegistry.map(p => {
    let crewCount = 0, lastActivity = p.createdAt;
    try {
      const c = readProductionDb(p.code, 'crew_db.json');
      crewCount = c.length;
      const latest = c.map(m => m.lastSeen || m.timestamp).filter(Boolean).sort().reverse()[0];
      if (latest) lastActivity = latest;
    } catch {}
    return { ...p, crewCount, lastActivity };
  });

  res.json(stats);
});

// ─── PAYROLL ──────────────────────────────────────────────────────────────────
// Payroll reads from legacy global vars (DEMO01 data kept in sync via writeProductionDb)
app.get('/payroll/weekly', (req, res) => {
  const week = getWeekRange(req.query.date ? new Date(req.query.date) : new Date());
  const weekLabel = `${week.start.toLocaleDateString('en-AU')} — ${week.end.toLocaleDateString('en-AU')}`;
  const weekTimesheets = timesheets.filter(t => isInWeek(t.timestamp || t.date, week));
  const weekReceipts   = receipts.filter(r => isInWeek(r.timestamp, week));
  const crewMap = {};

  weekTimesheets.forEach(ts => {
    const key = ts.name;
    if (!crewMap[key]) {
      const crewRecord = crew.find(c => c.name === key);
      crewMap[key] = {
        name: ts.name, role: ts.role || 'CREW', department: ts.department || 'GENERAL',
        hourlyRate: crewRecord?.hourlyRate || null,
        rateMode: crewRecord?.rateMode || 'MEAA',
        days: [], totalOrdinary: 0, totalOT1: 0, totalOT2: 0,
        receipts: [], totalReimbursements: 0, grossPay: 0,
      };
    }
    const hours = parseHoursFromTotal(ts.total);
    const isSeventhDay = ts.isSeventhDay === true;
    const rateConfig = crewMap[key].rateMode === 'MEAA' ? null : {
      ordinary: crewMap[key].hourlyRate || MEAA_BASE_HOURLY,
      overtime_1: (crewMap[key].hourlyRate || MEAA_BASE_HOURLY) * 1.5,
      overtime_2: (crewMap[key].hourlyRate || MEAA_BASE_HOURLY) * 2.0,
      seventh_day: (crewMap[key].hourlyRate || MEAA_BASE_HOURLY) * 2.0,
      meal_penalty_per_event: MEAA_RATES.meal_penalty_per_event,
    };
    const pay = calculatePay(hours, isSeventhDay, ts.mealPenalties || 0, rateConfig);
    crewMap[key].days.push({ date: ts.date, clockIn: ts.clockIn, clockOut: ts.clockOut, hours: hours.toFixed(2), ...pay });
    crewMap[key].totalOrdinary += pay.ordinary;
    crewMap[key].totalOT1 += pay.ot1;
    crewMap[key].totalOT2 += pay.ot2;
    crewMap[key].grossPay += pay.gross;
  });

  weekReceipts.forEach(r => {
    const name = r.submittedBy;
    if (!name) return;
    if (!crewMap[name]) crewMap[name] = { name, role: r.submittedByRole || 'CREW', department: r.submittedByDept || 'GENERAL', days: [], totalOrdinary: 0, totalOT1: 0, totalOT2: 0, receipts: [], totalReimbursements: 0, grossPay: 0 };
    const amount = parseFloat((r.amount || '$0').replace(/[^0-9.]/g, '')) || 0;
    crewMap[name].receipts.push({ date: r.timestamp ? new Date(r.timestamp).toLocaleDateString('en-AU') : 'Unknown', shop: r.shop, account: r.dept, amount: `$${amount.toFixed(2)}` });
    crewMap[name].totalReimbursements += amount;
  });

  const report = Object.values(crewMap).map((c) => ({
    ...c,
    totalHours: (c.totalOrdinary + c.totalOT1 + c.totalOT2).toFixed(2),
    totalOrdinary: c.totalOrdinary.toFixed(2),
    totalOT1: c.totalOT1.toFixed(2),
    totalOT2: c.totalOT2.toFixed(2),
    grossPay: `$${c.grossPay.toFixed(2)}`,
    totalReimbursements: `$${c.totalReimbursements.toFixed(2)}`,
    totalPayable: `$${(c.grossPay + c.totalReimbursements).toFixed(2)}`,
  }));

  res.json({ weekLabel, weekStart: week.start.toISOString(), weekEnd: week.end.toISOString(), generatedAt: new Date().toISOString(), totalCrew: report.length, report });
});

app.post('/payroll/batch', requireAdmin, (req, res) => {
  const batch = { ...req.body, id: Date.now(), sentAt: new Date().toISOString() };
  payrollBatches.push(batch);
  fs.writeFileSync(PAYROLL_FILE, JSON.stringify(payrollBatches, null, 2));
  console.log(`📊 PAYROLL BATCH: ${batch.weekLabel} — ${batch.totalCrew} crew`);
  io.emit('payroll_sent', batch);
  res.json({ success: true });
});

app.get('/payroll/batches', (req, res) => res.json(payrollBatches));

// ─── INCIDENT REPORTS ─────────────────────────────────────────────────────────
app.post('/incidents', (req, res) => {
  const code = req.query.code || req.body.code || 'DEMO01';
  const entry = { ...req.body, id: Date.now(), timestamp: new Date().toISOString(), status: 'OPEN' };
  delete entry.code;
  const data = readProductionDb(code, 'incidents_db.json');
  data.push(entry);
  writeProductionDb(code, 'incidents_db.json', data);
  console.log(`🚨 INCIDENT [${code}]: ${entry.severity} — ${entry.description}`);
  io.emit('new_incident', entry);
  res.json({ success: true });
});

app.get('/incidents', (req, res) => {
  const code = req.query.code || 'DEMO01';
  res.json(readProductionDb(code, 'incidents_db.json'));
});

app.patch('/incidents/:id', (req, res) => {
  const code = req.query.code || req.body.code || 'DEMO01';
  const data = readProductionDb(code, 'incidents_db.json');
  const idx = data.findIndex(i => i.id == req.params.id);
  if (idx >= 0) { data[idx] = { ...data[idx], ...req.body }; writeProductionDb(code, 'incidents_db.json', data); }
  res.json({ success: true });
});

// ─── ASSET TRACKER ────────────────────────────────────────────────────────────
app.post('/assets', (req, res) => {
  const entry = { ...req.body, id: Date.now(), status: 'available', timestamp: new Date().toISOString() };
  assets.push(entry);
  fs.writeFileSync(ASSETS_FILE, JSON.stringify(assets, null, 2));
  res.json({ success: true, id: entry.id });
});

app.get('/assets', (req, res) => res.json(assets));

app.patch('/assets/:id/checkout', (req, res) => {
  const idx = assets.findIndex(a => a.id == req.params.id);
  if (idx >= 0) {
    assets[idx] = { ...assets[idx], status: 'checked_out', checkedOutBy: req.body.name, checkedOutAt: new Date().toISOString() };
    fs.writeFileSync(ASSETS_FILE, JSON.stringify(assets, null, 2));
    io.emit('asset_update', assets[idx]);
  }
  res.json({ success: true });
});

app.patch('/assets/:id/return', (req, res) => {
  const idx = assets.findIndex(a => a.id == req.params.id);
  if (idx >= 0) {
    assets[idx] = { ...assets[idx], status: 'available', checkedOutBy: null, returnedAt: new Date().toISOString() };
    fs.writeFileSync(ASSETS_FILE, JSON.stringify(assets, null, 2));
    io.emit('asset_update', assets[idx]);
  }
  res.json({ success: true });
});

// ─── EXISTING ENDPOINTS ───────────────────────────────────────────────────────

// Google Places autocomplete proxy
app.get('/places/autocomplete', (req, res) => {
  const input = req.query.input;
  if (!input || input.length < 2) return res.json({ predictions: [] });
  const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input)}&components=country:au&types=geocode|establishment&key=${GOOGLE_PLACES_KEY}`;
  https.get(url, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try { res.json(JSON.parse(data)); }
      catch { res.json({ predictions: [] }); }
    });
  }).on('error', () => res.json({ predictions: [] }));
});

// ABN lookup & validation proxy
app.get('/abn/lookup', (req, res) => {
  const abn = (req.query.abn || '').replace(/\s/g, '');
  if (!/^\d{11}$/.test(abn)) return res.json({ valid: false, name: null });
  const weights = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const digits = abn.split('').map(Number);
  digits[0] -= 1;
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i], 0);
  if (sum % 89 !== 0) return res.json({ valid: false, name: null });
  const guid = process.env.ABR_GUID;
  if (!guid) return res.json({ valid: true, name: null });
  const url = `https://abr.business.gov.au/json/AbnDetails.aspx?abn=${abn}&callback=callback&guid=${guid}`;
  https.get(url, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const json = JSON.parse(data.replace(/^callback\(/, '').replace(/\)$/, ''));
        res.json({ valid: true, name: json.EntityName || null });
      } catch { res.json({ valid: true, name: null }); }
    });
  }).on('error', () => res.json({ valid: true, name: null }));
});

// Google Place Details proxy
app.get('/places/details', (req, res) => {
  const placeId = req.query.place_id;
  if (!placeId) return res.json({ result: {} });
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=formatted_address&key=${GOOGLE_PLACES_KEY}`;
  https.get(url, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try { res.json(JSON.parse(data)); }
      catch { res.json({ result: {} }); }
    });
  }).on('error', () => res.json({ result: {} }));
});

app.get('/status', (req, res) => {
  const code = req.query.code || 'DEMO01';
  let crewCount = 0, incidentCount = 0;
  try { crewCount = readProductionDb(code, 'crew_db.json').length; } catch {}
  try { incidentCount = readProductionDb(code, 'incidents_db.json').filter(i => i.status === 'OPEN').length; } catch {}
  res.json({ status: 'OK', production: code, crew: crewCount, receipts: receipts.length, incidents: incidentCount });
});

// ─── PRODUCTION SETUP ────────────────────────────────────────────────────────
app.get('/production', (req, res) => {
  const code = req.query.code || 'DEMO01';
  res.json(readProductionDb(code, 'production_db.json'));
});

app.post('/production', (req, res) => {
  const code = req.query.code || req.body.code || 'DEMO01';
  const existing = readProductionDb(code, 'production_db.json');
  const updated = { ...(Array.isArray(existing) ? {} : existing), ...req.body, updatedAt: new Date().toISOString() };
  delete updated.code;
  writeProductionDb(code, 'production_db.json', updated);
  io.emit('production_updated', updated);
  res.json({ success: true, production: updated });
});

// ─── CREW LOOKUP ─────────────────────────────────────────────────────────────
app.get('/crew/lookup', (req, res) => {
  const code = req.query.code || 'DEMO01';
  const { phone, name } = req.query;
  const crewData = readProductionDb(code, 'crew_db.json');
  const match = crewData.find(c => (phone && c.phone?.replace(/\s/g,'') === phone.replace(/\s/g,'')) || (name && c.name?.toLowerCase() === name.toLowerCase()));
  res.json(match || null);
});

// ─── ONBOARDING ──────────────────────────────────────────────────────────────
app.post('/onboard', (req, res) => {
  const code = req.query.code || req.body.code || 'DEMO01';
  const now = new Date().toISOString();
  const entry = { ...req.body, timestamp: now };
  delete entry.code;

  const crewData = readProductionDb(code, 'crew_db.json');
  const idx = crewData.findIndex(c => c.phone?.replace(/\s/g,'') === (entry.phone||'').replace(/\s/g,''));
  if (idx >= 0) {
    const existing = crewData[idx];
    crewData[idx] = {
      ...existing,
      ...entry,
      lastSeen: now,
      invitedAt: existing.invitedAt || now,
      onboardedAt: existing.onboardedAt || (entry.contractSigned ? now : null),
      contractSignedAt: entry.contractSigned ? (existing.contractSignedAt || now) : existing.contractSignedAt,
      firstLoginAt: existing.firstLoginAt || now,
    };
  } else {
    crewData.push({
      ...entry,
      invitedAt: now,
      onboardedAt: entry.contractSigned ? now : null,
      contractSignedAt: entry.contractSigned ? now : null,
      firstLoginAt: now,
      lastSeen: now,
      passRevoked: false,
    });
  }
  writeProductionDb(code, 'crew_db.json', crewData);
  io.emit('new_crew', entry);
  io.emit('sync_crew', crewData);
  res.json({ success: true });
});

// ─── CREW STATUS BOARD ───────────────────────────────────────────────────────
app.post('/crew/login', (req, res) => {
  const code = req.query.code || req.body.code || 'DEMO01';
  const { phone, name } = req.body;
  const now = new Date().toISOString();
  const crewData = readProductionDb(code, 'crew_db.json');
  const idx = crewData.findIndex(c =>
    (phone && c.phone?.replace(/\s/g,'') === phone.replace(/\s/g,'')) ||
    (name && c.name?.toLowerCase() === name?.toLowerCase())
  );
  if (idx >= 0) {
    crewData[idx] = { ...crewData[idx], lastSeen: now, firstLoginAt: crewData[idx].firstLoginAt || now };
    writeProductionDb(code, 'crew_db.json', crewData);
    io.emit('sync_crew', crewData);
    res.json({ success: true, crew: crewData[idx] });
  } else {
    res.status(404).json({ error: 'Crew member not found' });
  }
});

app.post('/crew/invite', requireAdmin, (req, res) => {
  const code = req.query.code || req.body.code || 'DEMO01';
  const { name, role, department, phone, email } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });
  const now = new Date().toISOString();
  const crewData = readProductionDb(code, 'crew_db.json');
  const existing = crewData.findIndex(c => c.phone?.replace(/\s/g,'') === phone.replace(/\s/g,''));
  if (existing >= 0) {
    crewData[existing] = { ...crewData[existing], invitedAt: now, inviteStatus: 'INVITED' };
  } else {
    crewData.push({ name, role, department, phone, email, invitedAt: now, inviteStatus: 'INVITED', timestamp: now });
  }
  writeProductionDb(code, 'crew_db.json', crewData);
  io.emit('sync_crew', crewData);
  res.json({ success: true });
});

app.get('/crew/status', (req, res) => {
  const code = req.query.code || 'DEMO01';
  const crewData = readProductionDb(code, 'crew_db.json');
  const summary = crewData.map(c => {
    let status = 'NOT_INVITED';
    if (c.invitedAt || c.inviteStatus === 'INVITED') status = 'INVITED';
    if (c.firstLoginAt || c.lastSeen) status = 'LOGGED_IN';
    if (c.contractSignedAt || c.contractSigned) status = 'CONTRACT_SIGNED';
    if (c.passRevoked) status = 'REVOKED';
    if ((c.contractSignedAt || c.contractSigned) && c.lastSeen) status = 'ACTIVE';
    if (c.passRevoked) status = 'REVOKED';
    return {
      name: c.name, role: c.role, department: c.department, phone: c.phone, email: c.email,
      status, invitedAt: c.invitedAt || null, contractSignedAt: c.contractSignedAt || null,
      firstLoginAt: c.firstLoginAt || null, lastSeen: c.lastSeen || null,
      passRevoked: c.passRevoked || false,
      productionCount: Array.isArray(c.productionHistory) ? c.productionHistory.length : null,
    };
  });
  res.json(summary);
});

app.get('/crew/history/:phone', (req, res) => {
  const code = req.query.code || 'DEMO01';
  const crewData = readProductionDb(code, 'crew_db.json');
  const member = crewData.find(c => c.phone?.replace(/\s/g,'') === req.params.phone.replace(/\s/g,''));
  if (!member) return res.status(404).json({ error: 'Not found' });
  res.json({
    name: member.name, role: member.role, department: member.department,
    productionHistory: member.productionHistory || [],
    productionCount: Array.isArray(member.productionHistory) ? member.productionHistory.length : 0,
  });
});

// Public /crew — sensitive fields stripped
app.get('/crew', (req, res) => {
  const code = req.query.code || 'DEMO01';
  const crewData = readProductionDb(code, 'crew_db.json');
  res.json(crewData.map(stripSensitive));
});

// Full /crew/full — admin only
app.get('/crew/full', requireAdmin, (req, res) => {
  const code = req.query.code || 'DEMO01';
  res.json(readProductionDb(code, 'crew_db.json'));
});

// DELETE test crew
app.delete('/crew/test-cleanup', requireAdmin, (req, res) => {
  const code = req.query.code || 'DEMO01';
  const crewData = readProductionDb(code, 'crew_db.json');
  const before = crewData.length;
  const filtered = crewData.filter(c => !c.phone?.replace(/\s/g,'').startsWith('04999000'));
  writeProductionDb(code, 'crew_db.json', filtered);
  io.emit('sync_crew', filtered);
  res.json({ success: true, removed: before - filtered.length, remaining: filtered.length });
});

app.patch('/crew/revoke', requireAdmin, (req, res) => {
  const code = req.query.code || req.body.code || 'DEMO01';
  const { phone, name, revoked } = req.body;
  const crewData = readProductionDb(code, 'crew_db.json');
  const idx = crewData.findIndex(c =>
    (phone && c.phone?.replace(/\s/g,'') === phone?.replace(/\s/g,'')) ||
    (name && c.name?.toLowerCase() === name?.toLowerCase())
  );
  if (idx >= 0) {
    crewData[idx] = { ...crewData[idx], passRevoked: revoked, revokedAt: revoked ? new Date().toISOString() : null };
    writeProductionDb(code, 'crew_db.json', crewData);
    io.emit('sync_crew', crewData);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Crew member not found' });
  }
});

app.patch('/crew/restore', requireAdmin, (req, res) => {
  const code = req.query.code || req.body.code || 'DEMO01';
  const { phone, name } = req.body;
  const crewData = readProductionDb(code, 'crew_db.json');
  const idx = crewData.findIndex(c =>
    (phone && c.phone?.replace(/\s/g,'') === phone?.replace(/\s/g,'')) ||
    (name && c.name?.toLowerCase() === name?.toLowerCase())
  );
  if (idx >= 0) {
    crewData[idx] = { ...crewData[idx], passRevoked: false, revokedAt: null, restoredAt: new Date().toISOString() };
    writeProductionDb(code, 'crew_db.json', crewData);
    io.emit('sync_crew', crewData);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Crew member not found' });
  }
});

// ─── TIMESHEETS ───────────────────────────────────────────────────────────────
app.post('/timesheets', (req, res) => {
  const code = req.query.code || req.body.code || 'DEMO01';
  const { phone, date, clockOut } = req.body;
  const entry = { ...req.body, id: Date.now(), timestamp: new Date().toISOString() };
  delete entry.code;

  const data = readProductionDb(code, 'timesheets_db.json');
  const existing = phone && date
    ? data.findIndex(t => t.phone === phone && t.date === date)
    : -1;
  if (existing >= 0 && clockOut) {
    data[existing] = { ...data[existing], ...req.body, updatedAt: new Date().toISOString() };
    delete data[existing].code;
  } else {
    data.push(entry);
  }
  writeProductionDb(code, 'timesheets_db.json', data);
  io.emit('new_timesheet', req.body);
  res.json({ success: true });
});

app.get('/timesheets', (req, res) => {
  const code = req.query.code || 'DEMO01';
  res.json(readProductionDb(code, 'timesheets_db.json'));
});

// ─── RECEIPTS ─────────────────────────────────────────────────────────────────
app.post('/receipts', (req, res) => {
  const code = req.query.code || req.body.code || 'DEMO01';
  const entry = { ...req.body, id: Date.now(), timestamp: new Date().toISOString() };
  delete entry.code;
  const data = readProductionDb(code, 'receipts_db.json');
  data.push(entry);
  writeProductionDb(code, 'receipts_db.json', data);
  io.emit('new_receipt', entry);
  io.emit('sync_receipts', data);
  res.json({ success: true });
});

app.get('/receipts', (req, res) => {
  const code = req.query.code || 'DEMO01';
  res.json(readProductionDb(code, 'receipts_db.json'));
});

// ─── CATERING PREFERENCES ────────────────────────────────────────────────────
const savePrefs = (code, data) => writeProductionDb(code, 'catering_preferences.json', data);

app.post('/catering/preference', (req, res) => {
  const code = req.query.code || req.body.code || 'DEMO01';
  const { date, phone, name, department, role, meal, allergies, note } = req.body;
  if (!date || !phone || !meal) return res.status(400).json({ error: 'date, phone, and meal required' });
  const entry = {
    date, phone: phone.replace(/\s/g, ''), name: name || '', department: department || '',
    role: role || '', meal, allergies: allergies || [], note: note || '',
    submittedAt: new Date().toISOString(), autoAssigned: false,
  };
  const data = readProductionDb(code, 'catering_preferences.json');
  const idx = data.findIndex(p => p.date === date && p.phone.replace(/\s/g,'') === entry.phone);
  if (idx >= 0) data[idx] = entry; else data.push(entry);
  savePrefs(code, data);
  console.log(`🍽️ CATERING PREF [${code}]: ${name} (${department}) — ${meal} for ${date}`);
  io.emit('catering_preference_submitted', entry);
  res.json({ success: true, entry });
});

app.get('/catering/preferences/:date', (req, res) => {
  const code = req.query.code || 'DEMO01';
  const data = readProductionDb(code, 'catering_preferences.json');
  res.json(data.filter(p => p.date === req.params.date));
});

app.get('/catering/my-preference/:date/:phone', (req, res) => {
  const code = req.query.code || 'DEMO01';
  const phone = req.params.phone.replace(/\s/g,'');
  const data = readProductionDb(code, 'catering_preferences.json');
  const pref = data.find(p => p.date === req.params.date && p.phone.replace(/\s/g,'') === phone);
  res.json(pref || null);
});

app.get('/catering/summary/:date', (req, res) => {
  const code = req.query.code || 'DEMO01';
  const data = readProductionDb(code, 'catering_preferences.json');
  const prefs = data.filter(p => p.date === req.params.date);
  const mealTotals = {}, allergyTotals = {}, deptBreakdown = {};
  prefs.forEach(p => {
    mealTotals[p.meal] = (mealTotals[p.meal] || 0) + 1;
    (p.allergies || []).forEach(a => { if (a && a !== 'None') allergyTotals[a] = (allergyTotals[a] || 0) + 1; });
    if (!deptBreakdown[p.department]) deptBreakdown[p.department] = [];
    deptBreakdown[p.department].push(p);
  });
  res.json({ date: req.params.date, total: prefs.length, mealTotals, allergyTotals, deptBreakdown, all: prefs });
});

app.get('/catering/dept-status/:date/:department', (req, res) => {
  const code = req.query.code || 'DEMO01';
  const dept = req.params.department.toUpperCase();
  const prefsData = readProductionDb(code, 'catering_preferences.json');
  const crewData  = readProductionDb(code, 'crew_db.json');
  const submitted = prefsData.filter(p => p.date === req.params.date && p.department.toUpperCase() === dept);
  const deptCrew = crewData.filter(c => (c.department || '').toUpperCase() === dept);
  const submittedPhones = submitted.map(p => p.phone.replace(/\s/g,''));
  const pending = deptCrew.filter(c => !submittedPhones.includes((c.phone || '').replace(/\s/g,'')));
  res.json({ date: req.params.date, department: dept, submitted, pending: pending.map(c => ({ name: c.name, phone: c.phone, role: c.role })), total: deptCrew.length, submittedCount: submitted.length });
});

app.get('/catering/meal-history/:phone', (req, res) => {
  const code = req.query.code || 'DEMO01';
  const phone = req.params.phone.replace(/\s/g,'');
  const data = readProductionDb(code, 'catering_preferences.json');
  const history = data
    .filter(p => p.phone.replace(/\s/g,'') === phone)
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const freq = {};
  history.forEach(p => { freq[p.meal] = (freq[p.meal] || 0) + 1; });
  const total = history.length;
  const freqPct = {};
  Object.entries(freq).forEach(([meal, count]) => { freqPct[meal] = Math.round(count / total * 100); });
  const skipCount = freq['Skip (not eating)'] || 0;
  const skipRate = total > 0 ? skipCount / total : 0;
  const wellnessFlag = skipRate >= 0.5 && total >= 3;
  res.json({ phone, history, freq, freqPct, total, wellnessFlag, skipRate: Math.round(skipRate * 100) });
});

app.get('/catering/predictions/:date', (req, res) => {
  const code = req.query.code || 'DEMO01';
  const data = readProductionDb(code, 'catering_preferences.json');
  const targetDate = new Date(req.params.date);
  const predictions = {};
  ['Full Meal','Vegetarian','Vegan','Gluten Free','Halal','Kosher','Pescatarian','Light Meal','Skip (not eating)'].forEach(m => {
    let count = 0;
    for (let i = 1; i <= 5; i++) {
      const d = new Date(targetDate);
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().split('T')[0];
      const dayPrefs = data.filter(p => p.date === ds);
      count += dayPrefs.filter(p => p.meal === m).length;
    }
    predictions[m] = Math.round(count / 5);
  });
  res.json({ date: req.params.date, predictions, basedOnDays: 5 });
});

app.post('/catering/auto-assign', requireAdmin, (req, res) => {
  // Auto-assign runs against DEMO01 (legacy global crew)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];
  let assigned = 0;
  const results = [];
  crew.forEach(c => {
    if (!c.phone) return;
    const phone = c.phone.replace(/\s/g,'');
    const already = cateringPrefs.find(p => p.date === tomorrowStr && p.phone.replace(/\s/g,'') === phone);
    if (already) return;
    const history = cateringPrefs
      .filter(p => p.phone.replace(/\s/g,'') === phone)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    const lastMeal = history[0]?.meal || 'Full Meal';
    const lastAllergies = history[0]?.allergies || [];
    const entry = {
      date: tomorrowStr, phone, name: c.name || '', department: c.department || '',
      role: c.role || '', meal: lastMeal, allergies: lastAllergies, note: '',
      submittedAt: new Date().toISOString(), autoAssigned: true,
    };
    cateringPrefs.push(entry);
    results.push(entry);
    assigned++;
  });
  writeProductionDb('DEMO01', 'catering_preferences.json', cateringPrefs);
  console.log(`🤖 AUTO-ASSIGN: ${assigned} crew for ${tomorrowStr}`);
  io.emit('catering_auto_assigned', { date: tomorrowStr, count: assigned, entries: results });
  res.json({ success: true, date: tomorrowStr, assigned, entries: results });
});

app.post('/catering/nudge', (req, res) => {
  const { date, department, nudgedBy } = req.body;
  io.emit('catering_nudge', { date, department, nudgedBy, timestamp: new Date().toISOString() });
  res.json({ success: true });
});

// ─── 9:55AM AUTO-ASSIGN CRON ─────────────────────────────────────────────────
const scheduleAutoAssign = () => {
  const now = new Date();
  const target = new Date();
  target.setHours(9, 55, 0, 0);
  if (now >= target) target.setDate(target.getDate() + 1);
  const delay = target.getTime() - now.getTime();
  console.log(`⏰ Auto-assign scheduled in ${Math.round(delay/60000)} minutes`);
  setTimeout(async () => {
    console.log('⏰ Running scheduled auto-assign...');
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    let assigned = 0;
    crew.forEach(c => {
      if (!c.phone) return;
      const phone = c.phone.replace(/\s/g,'');
      const already = cateringPrefs.find(p => p.date === tomorrowStr && p.phone.replace(/\s/g,'') === phone);
      if (already) return;
      const history = cateringPrefs
        .filter(p => p.phone.replace(/\s/g,'') === phone)
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      const lastMeal = history[0]?.meal || 'Full Meal';
      const lastAllergies = history[0]?.allergies || [];
      cateringPrefs.push({
        date: tomorrowStr, phone, name: c.name || '', department: c.department || '',
        role: c.role || '', meal: lastMeal, allergies: lastAllergies, note: '',
        submittedAt: new Date().toISOString(), autoAssigned: true,
      });
      assigned++;
    });
    if (assigned > 0) {
      writeProductionDb('DEMO01', 'catering_preferences.json', cateringPrefs);
      console.log(`🤖 Cron auto-assign: ${assigned} crew for ${tomorrowStr}`);
      io.emit('catering_auto_assigned', { date: tomorrowStr, count: assigned, cron: true });
    }
    scheduleAutoAssign();
  }, delay);
};
scheduleAutoAssign();

// ─── LEGACY CATERING (keep for backward compat) ────────────────────────────
app.post('/catering', (req, res) => {
  const entry = { ...req.body, id: Date.now(), timestamp: new Date().toISOString() };
  catering.push(entry);
  fs.writeFileSync(CATERING_FILE, JSON.stringify(catering, null, 2));
  io.emit('new_catering', entry);
  res.json({ success: true });
});

app.get('/catering', (req, res) => res.json(catering));

// ─── TIMESHEET HOD APPROVALS ──────────────────────────────────────────────────
app.patch('/timesheets/approve', requireAdmin, (req, res) => {
  const code = req.query.code || req.body.code || 'DEMO01';
  const { id, approvedBy } = req.body;
  const data = readProductionDb(code, 'timesheets_db.json');
  const idx = data.findIndex(t => t.id == id);
  if (idx >= 0) {
    data[idx] = { ...data[idx], approved: true, approvedBy, approvedAt: new Date().toISOString() };
    writeProductionDb(code, 'timesheets_db.json', data);
    io.emit('timesheet_approved', data[idx]);
    res.json({ success: true });
  } else res.status(404).json({ error: 'Not found' });
});

app.patch('/timesheets/query', requireAdmin, (req, res) => {
  const code = req.query.code || req.body.code || 'DEMO01';
  const { id, queryNote, queriedBy } = req.body;
  const data = readProductionDb(code, 'timesheets_db.json');
  const idx = data.findIndex(t => t.id == id);
  if (idx >= 0) {
    data[idx] = { ...data[idx], queried: true, queryNote, queriedBy, queriedAt: new Date().toISOString() };
    writeProductionDb(code, 'timesheets_db.json', data);
    res.json({ success: true });
  } else res.status(404).json({ error: 'Not found' });
});

// ─── EMERGENCY MUSTER ────────────────────────────────────────────────────────
app.post('/muster/call', requireAdmin, (req, res) => {
  const code = req.query.code || req.body.code || 'DEMO01';
  const event = { ...req.body, id: Date.now(), active: true, responses: [], timestamp: new Date().toISOString(), code };
  musterEvents.push(event);
  io.emit('emergency_muster', event);
  console.log(`🚨 MUSTER CALLED by ${req.body.calledBy} [${code}]`);
  res.json({ success: true, id: event.id });
});

app.post('/muster/confirm', (req, res) => {
  const response = { ...req.body, id: Date.now(), timestamp: new Date().toISOString() };
  musterResponses.push(response);
  io.emit('muster_response', response);
  res.json({ success: true });
});

app.get('/muster/responses', (req, res) => {
  const code = req.query.code || 'DEMO01';
  // Filter responses by code if present
  const filtered = musterResponses.filter(r => !r.code || r.code === code);
  res.json(filtered);
});

// GET /muster — current muster status for a production
app.get('/muster', (req, res) => {
  const code = req.query.code || 'DEMO01';
  const crewData = readProductionDb(code, 'crew_db.json');
  const activeEvent = musterEvents.filter(e => e.active && (!e.code || e.code === code)).slice(-1)[0] || null;
  const responses = musterResponses.filter(r => !r.code || r.code === code);
  res.json({
    active: !!activeEvent,
    event: activeEvent,
    crewCount: crewData.length,
    confirmedCount: responses.length,
    responses,
    unaccounted: crewData
      .filter(c => !responses.find(r => r.phone === c.phone || r.name === c.name))
      .map(c => ({ name: c.name, phone: c.phone, department: c.department })),
  });
});

app.post('/muster/clear', requireAdmin, (req, res) => {
  musterResponses = [];
  io.emit('muster_cleared', { clearedBy: req.body.clearedBy, timestamp: new Date().toISOString() });
  res.json({ success: true });
});

// ─── DAILY PRODUCTION REPORT ────────────────────────────────────────────────
app.post('/dpr', (req, res) => {
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'date is required' });
  const idx = dprs.findIndex(d => d.date === date);
  const now = new Date().toISOString();
  if (idx >= 0) {
    dprs[idx] = { ...dprs[idx], ...req.body, updatedAt: now };
    fs.writeFileSync(DPR_FILE, JSON.stringify(dprs, null, 2));
    io.emit('dpr_updated', dprs[idx]);
    console.log(`📋 DPR updated for ${date}`);
    return res.json({ success: true, dpr: dprs[idx] });
  }
  const entry = {
    ...req.body,
    id: require('crypto').randomUUID ? require('crypto').randomUUID() : `dpr-${Date.now()}`,
    createdAt: now,
    updatedAt: now,
  };
  dprs.push(entry);
  fs.writeFileSync(DPR_FILE, JSON.stringify(dprs, null, 2));
  io.emit('new_dpr', entry);
  console.log(`📋 DPR created for ${date}`);
  res.json({ success: true, dpr: entry });
});

app.get('/dpr', (req, res) => {
  const sorted = [...dprs].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  res.json(sorted);
});

app.get('/dpr/:date', (req, res) => {
  const dpr = dprs.find(d => d.date === req.params.date);
  if (!dpr) return res.status(404).json({ error: 'DPR not found' });
  res.json(dpr);
});

app.post('/dpr/:date/approve', requireAdmin, (req, res) => {
  const idx = dprs.findIndex(d => d.date === req.params.date);
  if (idx < 0) return res.status(404).json({ error: 'DPR not found' });
  dprs[idx].approved = true;
  dprs[idx].approvedBy = req.body.approvedBy || 'Admin';
  dprs[idx].approvedAt = new Date().toISOString();
  fs.writeFileSync(DPR_FILE, JSON.stringify(dprs, null, 2));
  io.emit('dpr_approved', dprs[idx]);
  console.log(`✅ DPR approved for ${req.params.date}`);
  res.json({ success: true, dpr: dprs[idx] });
});

io.on('connection', (socket) => {
  socket.emit('sync_crew', crew);
  socket.emit('sync_receipts', receipts);
  socket.emit('sync_catering', catering);
  socket.emit('sync_requests', activeRequests);
  socket.emit('sync_incidents', incidents.filter(i => i.status === 'OPEN'));
  socket.on('broadcast_set_status', (s) => io.emit('set_status_update', s));
  socket.on('request_swing', (data) => {
    const req = { id: Date.now(), ...data, time: new Date().toLocaleTimeString(), status: 'Waiting' };
    activeRequests.push(req);
    io.emit('new_request', req); io.emit('sync_requests', activeRequests);
  });

  socket.on('move_availability_request', (data) => {
    const moveReq = {
      ...data,
      moveId: data.moveId || Date.now(),
      status: 'pending',
      responses: [],
      createdAt: new Date().toISOString(),
    };
    if (!global.pendingMoves) global.pendingMoves = {};
    global.pendingMoves[moveReq.moveId] = moveReq;
    io.emit('move_availability_request', moveReq);
  });

  socket.on('move_driver_response', (data) => {
    if (!global.pendingMoves || !global.pendingMoves[data.moveId]) return;
    const move = global.pendingMoves[data.moveId];
    move.responses = move.responses.filter(r => r.driverName !== data.driverName);
    move.responses.push({ ...data, respondedAt: new Date().toISOString() });
    io.emit('move_responses_updated', { moveId: data.moveId, responses: move.responses });
  });

  socket.on('move_assign_driver', (data) => {
    if (global.pendingMoves && global.pendingMoves[data.moveId]) {
      global.pendingMoves[data.moveId].status = 'assigned';
      global.pendingMoves[data.moveId].assignedDriver = data.driverName;
    }
    io.emit('move_assigned', data);
  });

  if (global.pendingMoves) {
    const active = Object.values(global.pendingMoves).filter(m => m.status === 'pending');
    if (active.length > 0) socket.emit('sync_pending_moves', active);
  }
});

// ─── FLEET HUB ───────────────────────────────────────────────────────────────
const FLEET_FILE = path.join(__dirname, 'fleet_db.json');
if (!fs.existsSync(FLEET_FILE)) fs.writeFileSync(FLEET_FILE, JSON.stringify([]));
let fleet = JSON.parse(fs.readFileSync(FLEET_FILE));

if (fleet.length === 0) {
  fleet = [
    { id: 1, type: 'Hi-Ace Van',         rego: 'BDY 423', colour: 'White',  requiredClass: 'C',  unit: 'Unit 1', status: 'available', assignedDriver: null },
    { id: 2, type: 'Coaster Bus',        rego: 'TDM 891', colour: 'Silver', requiredClass: 'LR', unit: 'Unit 2', status: 'available', assignedDriver: null },
    { id: 3, type: 'Isuzu Camera Truck', rego: 'CAM 001', colour: 'Black',  requiredClass: 'MR', unit: 'Unit 3', status: 'available', assignedDriver: null },
    { id: 4, type: 'Honeywagon',         rego: 'HWY 555', colour: 'White',  requiredClass: 'HR', unit: 'Unit 4', status: 'available', assignedDriver: null },
    { id: 5, type: 'Generator Truck',    rego: 'GEN 302', colour: 'Yellow', requiredClass: 'HR', unit: 'Unit 5', status: 'available', assignedDriver: null },
    { id: 6, type: 'Star Trailer Tug',   rego: 'STR 099', colour: 'Red',    requiredClass: 'HR', unit: 'Unit 6', status: 'available', assignedDriver: null },
  ];
  fs.writeFileSync(FLEET_FILE, JSON.stringify(fleet, null, 2));
}

app.get('/fleet', (req, res) => res.json(fleet));

app.post('/fleet', (req, res) => {
  const vehicle = { ...req.body, id: Date.now(), status: 'available', assignedDriver: null };
  fleet.push(vehicle);
  fs.writeFileSync(FLEET_FILE, JSON.stringify(fleet, null, 2));
  io.emit('fleet_update', fleet);
  res.json({ success: true, vehicle });
});

app.patch('/fleet/assign', (req, res) => {
  const { vehicleId, driverName, driverPhone } = req.body;
  const idx = fleet.findIndex(v => v.id == vehicleId);
  if (idx >= 0) {
    fleet[idx] = { ...fleet[idx], assignedDriver: driverName, assignedDriverPhone: driverPhone, status: 'assigned', assignedAt: new Date().toISOString() };
    fs.writeFileSync(FLEET_FILE, JSON.stringify(fleet, null, 2));
    io.emit('fleet_update', fleet);
    res.json({ success: true });
  } else res.status(404).json({ error: 'Vehicle not found' });
});

app.patch('/fleet/unassign', (req, res) => {
  const { vehicleId } = req.body;
  const idx = fleet.findIndex(v => v.id == vehicleId);
  if (idx >= 0) {
    fleet[idx] = { ...fleet[idx], assignedDriver: null, assignedDriverPhone: null, status: 'available', assignedAt: null };
    fs.writeFileSync(FLEET_FILE, JSON.stringify(fleet, null, 2));
    io.emit('fleet_update', fleet);
    res.json({ success: true });
  } else res.status(404).json({ error: 'Vehicle not found' });
});

app.patch('/fleet/:id/status', (req, res) => {
  const idx = fleet.findIndex(v => v.id == req.params.id);
  if (idx >= 0) {
    fleet[idx] = { ...fleet[idx], ...req.body };
    fs.writeFileSync(FLEET_FILE, JSON.stringify(fleet, null, 2));
    io.emit('fleet_update', fleet);
    res.json({ success: true });
  } else res.status(404).json({ error: 'Not found' });
});

// ── PUSH NOTIFICATION SUBSCRIPTION ───────────────────────────────────────────
app.post('/push/subscribe', (req, res) => {
  const { driverName, subscription } = req.body;
  if (!driverName || !subscription) return res.status(400).json({ error: 'Missing fields' });
  pushSubscriptions[driverName] = { ...pushSubscriptions[driverName], subscription, driverName };
  res.json({ success: true, vapidPublic: VAPID_PUBLIC });
});

app.get('/push/vapid-public', (req, res) => res.json({ key: VAPID_PUBLIC }));

// ── ASSIGN MOVE TO DRIVER ────────────────────────────────────────────────────
app.post('/moves/assign', (req, res) => {
  const move = req.body;
  if (!move.driverName) return res.status(400).json({ error: 'driverName required' });
  assignedMoves[move.driverName] = { ...move, assignedAt: new Date().toISOString(), status: 'assigned', keyHandover: null };
  const sub = pushSubscriptions[move.driverName];
  if (sub?.subscription) {
    const payload = JSON.stringify({
      title: '🚚 LOCATION MOVE ASSIGNED',
      body: `${move.trailer} → ${move.to}`,
      data: { url: '/transport/driver' },
    });
    webpush.sendNotification(sub.subscription, payload).catch(err => {
      if (err.statusCode === 410) delete pushSubscriptions[move.driverName];
    });
  }
  io.emit('move_assigned_to_driver', { driverName: move.driverName, move: assignedMoves[move.driverName] });
  res.json({ success: true });
});

app.get('/moves/assigned/:driverName', (req, res) => {
  const move = assignedMoves[req.params.driverName];
  res.json(move || null);
});

app.get('/moves/all-assigned', (req, res) => res.json(assignedMoves));

// ── VEHICLE LOCATION ─────────────────────────────────────────────────────────
app.post('/vehicles/location', (req, res) => {
  const { driverName, vehicle, lat, lng } = req.body;
  if (!driverName || !lat || !lng) return res.status(400).json({ error: 'Missing fields' });
  vehicleLocations[driverName] = { driverName, vehicle, lat, lng, timestamp: new Date().toISOString() };
  io.emit('vehicle_location_update', vehicleLocations[driverName]);
  res.json({ success: true });
});

app.get('/vehicles/locations', (req, res) => res.json(Object.values(vehicleLocations)));

// ── KEY HANDOVER ─────────────────────────────────────────────────────────────
app.post('/moves/key-handover', (req, res) => {
  const { driverName, keyLocation, keyPhoto, vehicleId, moveId } = req.body;
  if (!driverName || !keyLocation) return res.status(400).json({ error: 'driverName and keyLocation required' });
  const handover = { driverName, keyLocation, keyPhoto: keyPhoto || null, vehicleId, moveId, timestamp: new Date().toISOString() };
  keyHandovers[driverName] = handover;
  if (assignedMoves[driverName]) {
    assignedMoves[driverName].status = 'parked';
    assignedMoves[driverName].keyHandover = handover;
  }
  io.emit('key_handover_complete', handover);
  res.json({ success: true });
});

app.get('/moves/key-handovers', (req, res) => res.json(Object.values(keyHandovers)));
app.get('/moves/key-handover/:driverName', (req, res) => res.json(keyHandovers[req.params.driverName] || null));

app.get('/moves/signoff-check/:driverName', (req, res) => {
  const move = assignedMoves[req.params.driverName];
  if (!move) return res.json({ clear: true });
  const needsHandover = move.status === 'assigned' || (move.status === 'parked' && !move.keyHandover);
  res.json({ clear: !needsHandover, move, needsHandover });
});

// ─── AI SUPPORT SYSTEM ────────────────────────────────────────────────────────
const KNOWLEDGE_BASE = require('./knowledge_base');
const SUPPORT_TICKETS_FILE = path.join(__dirname, 'support_tickets.json');
if (!fs.existsSync(SUPPORT_TICKETS_FILE)) fs.writeFileSync(SUPPORT_TICKETS_FILE, JSON.stringify([]));
let supportTickets = JSON.parse(fs.readFileSync(SUPPORT_TICKETS_FILE));

const SLA_HOURS = { studio: 1, production: 4, indie: 24 };

function nextTicketId() {
  const num = String(supportTickets.length + 1).padStart(4, '0');
  return `TKT-${num}`;
}

function saveTickets() {
  fs.writeFileSync(SUPPORT_TICKETS_FILE, JSON.stringify(supportTickets, null, 2));
}

async function callClaudeHaiku(messages, systemPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      system: systemPrompt,
      messages: messages.slice(-6).map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
      })),
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.content?.[0]?.text || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

function keywordFallback(message) {
  const m = message.toLowerCase();
  if (m.includes('onboard') || m.includes('sign up') || m.includes('join') || m.includes('get started'))
    return `Onboarding is a 5-step process on your phone:\n\n1. **Personal** — Name, DOB, phone, email, address\n2. **Your Role** — Department, role, employment type\n3. **Tax & Bank** — TFN, BSB, account number (all required)\n4. **Superannuation** — Select your fund (ABN, USI & address auto-fill for major funds)\n5. **Wellbeing** — Emergency contact, dietary, medical, t-shirt size\n\nYou also need to take a photo ID and scan your driver licence before you can proceed. The whole process takes about 3 minutes.`;
  if (m.includes('pric') || m.includes('cost') || m.includes('how much') || m.includes('plan'))
    return `Backlot Live has three plans:\n\n- **Indie** — $1,500/production (up to 25 crew)\n- **Production** — $3,500/production or $800/week (up to 150 crew)\n- **Studio** — $35,000/year, unlimited productions\n\nAll plans include the full feature set. Bundle deal: hire Backlot Trailers and get the app free. Active app subscribers get 15% off trailer hire.\n\nContact info@backlotlive.com.au to get started.`;
  if (m.includes('timesheet') || m.includes('payroll') || m.includes('overtime') || m.includes('meaa') || m.includes('clock'))
    return `Digital Timesheets work as follows:\n\n- Tap **Clock On** when you arrive on set\n- Log **NDB** (Non-Deductible Breakfast) start if applicable\n- Log **Lunch Break** start and end\n- Tap **Clock Off** at wrap\n\nMEAA 2024 rates are calculated automatically: $58.50/hr base rate, 1.5x after 10 hours, 2x after 12 hours. Meal penalty of $14.05 triggers if your break runs over 5.5 hours. HOD approves their department's timesheets before payroll is generated.`;
  if (m.includes('super') || m.includes('usi') || m.includes('fund'))
    return `Backlot Live includes a searchable database of 14+ major Australian super funds. When you select your fund, the **ABN**, **USI** (Unique Superannuation Identifier), and **fund postal address** all auto-fill — you don't need to look anything up.\n\nFor funds not in the list (SMSF, smaller funds), select "Other / Not Listed" and enter manually. Your USI can be found at superfundlookup.gov.au or on your annual statement.`;
  if (m.includes('pass') || m.includes('revok') || m.includes('access') || m.includes('lock'))
    return `The Studio Security Pass is generated automatically when onboarding is complete. It's a digital QR pass stored in the app.\n\nTo revoke a crew member's access: go to **Admin → Pass Management**, find the crew member, tap **REVOKE**. Their access is cut within 2 seconds across all their devices.\n\nTo restore access, tap **RESTORE** on the same screen.`;
  if (m.includes('fleet') || m.includes('driver') || m.includes('vehicle') || m.includes('licen'))
    return `Fleet Management assigns drivers only to vehicles that match their licence class:\n- C: Car/light vehicle\n- LR, MR, HR: Rigid trucks\n- HC: Semi/heavy combination\n- MC: B-double/multi-combination\n\nDrivers receive push notifications for assignments, and key handover is logged digitally with a photo sign-off. Live GPS tracks all vehicles in the Production Map.`;
  if (m.includes('receipt') || m.includes('petty cash') || m.includes('finance') || m.includes('accountant'))
    return `To submit a receipt: tap **Finance Hub** → **Add Receipt** → snap a photo → enter the amount and account code → submit.\n\nThe receipt instantly appears in the accountant's dashboard, categorised by Screen Australia account code. The petty cash limit per receipt is set by Admin (default $200). Anything above requires a purchase order.`;
  if (m.includes('muster') || m.includes('emergency') || m.includes('safety') || m.includes('roll call'))
    return `Emergency Muster works as follows:\n\n1. Admin taps **Emergency Muster** in the dashboard\n2. All crew receive an immediate push notification\n3. Crew tap **Confirm Safe** in the app\n4. Admin sees a live count of confirmed vs unaccounted\n\nThe muster list shows every crew member's status in real time. Admin can clear the muster once all crew are accounted for.`;
  if (m.includes('offline') || m.includes('no internet') || m.includes('no signal') || m.includes('remote'))
    return `Backlot Live is designed to work offline. The following features work without internet:\n\n- Studio Security Pass (cached locally)\n- Clock On/Off (timestamps stored, sync when online)\n- Receipt capture (photos stored locally, upload when online)\n- Incident reports\n- Crew directory\n\nEverything syncs automatically when your connection is restored.`;
  if (m.includes('hello') || m.includes('hi ') || m.includes('hey') || m.includes('help'))
    return `Hi! I'm Backlot AI — your 24/7 support assistant for Backlot Live. I can help with:\n\n- **Onboarding** — getting crew set up and through the Hard Gate\n- **Timesheets & Payroll** — MEAA rates, overtime, meal penalties\n- **Superannuation** — fund search and USI auto-fill\n- **Fleet** — driver assignments, licence classes\n- **Admin** — crew status board, production setup, pass management\n- **Pricing** — plans and the Backlot Trailers bundle deal\n\nWhat do you need help with?`;
  const topic = message.length > 60 ? message.substring(0, 57) + '...' : message;
  return `Thanks for your question about "${topic}".\n\nI'll escalate this to the Backlot Live team right now. You can also reach us directly at **info@backlotlive.com.au**. We typically respond within 24 hours for Indie, 4 hours for Production, and 1 hour for Studio plans.`;
}

app.post('/support/chat', async (req, res) => {
  const { message, history = [], name, phone, email, tier = 'indie', production: prod } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const prodContext = production?.title ? `\nCurrent production: ${production.title} (${production.studio || ''})` : '';
  const systemPrompt = KNOWLEDGE_BASE + prodContext;
  const messages = [...history, { role: 'user', content: message }];
  let reply = null, usedAI = false;
  try { reply = await callClaudeHaiku(messages, systemPrompt); if (reply) usedAI = true; } catch {}
  if (!reply) reply = keywordFallback(message);
  const needsEscalation = !usedAI || reply.toLowerCase().includes("i don't know") || reply.toLowerCase().includes("i'm not sure") || reply.toLowerCase().includes('escalat');
  let ticketId = null;
  if (needsEscalation && (name || phone || email)) {
    const slaHours = SLA_HOURS[tier] || 24;
    const ticket = { id: nextTicketId(), created: new Date().toISOString(), status: 'open', tier, slaHours, slaDeadline: new Date(Date.now() + slaHours * 3600000).toISOString(), production: prod || production?.title || '', name: name || '', phone: phone || '', email: email || '', messages: [...messages, { role: 'assistant', content: reply }], escalated: true, resolvedAt: null };
    supportTickets.push(ticket);
    saveTickets();
    ticketId = ticket.id;
    io.emit('new_support_ticket', ticket);
  }
  const slaHours = SLA_HOURS[tier] || 24;
  const responseTimeGuarantee = slaHours === 1 ? 'within 1 hour' : slaHours === 4 ? 'within 4 hours' : 'within 24 hours';
  res.json({ reply, escalated: needsEscalation && !!ticketId, ticketId, responseTimeGuarantee, model: usedAI ? 'claude-haiku-4-5' : 'keyword-fallback' });
});

app.post('/support/ticket', (req, res) => {
  const { name, phone, email, message, tier = 'indie', urgency = 'normal', production: prod } = req.body;
  const slaHours = urgency === 'critical' ? 1 : urgency === 'urgent' ? 2 : SLA_HOURS[tier] || 24;
  const ticket = { id: nextTicketId(), created: new Date().toISOString(), status: 'open', tier, urgency, slaHours, slaDeadline: new Date(Date.now() + slaHours * 3600000).toISOString(), production: prod || production?.title || '', name: name || '', phone: phone || '', email: email || '', messages: [{ role: 'user', content: message, timestamp: new Date().toISOString() }], escalated: true, resolvedAt: null };
  supportTickets.push(ticket);
  saveTickets();
  io.emit('new_support_ticket', ticket);
  res.json({ success: true, ticket });
});

app.get('/support/tickets', (req, res) => {
  const now = Date.now();
  const withStatus = supportTickets.map(t => ({ ...t, overSLA: t.status !== 'resolved' && new Date(t.slaDeadline).getTime() < now, minutesRemaining: Math.max(0, Math.round((new Date(t.slaDeadline).getTime() - now) / 60000)) }));
  res.json(withStatus);
});

app.patch('/support/ticket/:id', (req, res) => {
  const idx = supportTickets.findIndex(t => t.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Ticket not found' });
  const { status, reply } = req.body;
  supportTickets[idx] = { ...supportTickets[idx], status: status || supportTickets[idx].status, resolvedAt: status === 'resolved' ? new Date().toISOString() : supportTickets[idx].resolvedAt };
  if (reply) supportTickets[idx].messages.push({ role: 'assistant', content: reply, timestamp: new Date().toISOString() });
  saveTickets();
  io.emit('ticket_updated', supportTickets[idx]);
  res.json({ success: true, ticket: supportTickets[idx] });
});

// ── Catch-all: serve the Expo app ─────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/crew') || req.path.startsWith('/production') ||
      req.path.startsWith('/support') || req.path.startsWith('/timesheets') || req.path.startsWith('/receipts') ||
      req.path.startsWith('/fleet') || req.path.startsWith('/payroll') || req.path.startsWith('/incidents') ||
      req.path.startsWith('/places') || req.path.startsWith('/abn') || req.path.startsWith('/muster') ||
      req.path.startsWith('/dpr') || req.path.startsWith('/assets') || req.path.startsWith('/moves') ||
      req.path.startsWith('/vehicles') || req.path.startsWith('/push') || req.path.startsWith('/status') ||
      req.path.startsWith('/catering') || req.path.startsWith('/productions') || req.path.startsWith('/owner') ||
      req.path.startsWith('/leads') || req.path.startsWith('/socket.io')) {
    return next();
  }
  const frontendFile = path.join(FRONTEND, req.path);
  if (fs.existsSync(frontendFile) && fs.statSync(frontendFile).isFile()) {
    return res.sendFile(frontendFile);
  }
  res.sendFile('index.html', { root: APP_DIST }, (err) => { if (err) next(); });
});

// ── DEMO LEADS ────────────────────────────────────────────────────────────────
const LEADS_FILE = path.join(__dirname, 'leads_db.json');
if (!fs.existsSync(LEADS_FILE)) fs.writeFileSync(LEADS_FILE, JSON.stringify([]));
let leads = JSON.parse(fs.readFileSync(LEADS_FILE));

app.post('/leads', (req, res) => {
  const { name, company, email, phone, type, message } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });
  const lead = { id: `LEAD-${String(leads.length + 1).padStart(4, '0')}`, name, company: company || '', email, phone: phone || '', type: type || 'Unknown', message: message || '', source: 'website', createdAt: new Date().toISOString(), status: 'new' };
  leads.push(lead);
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
  console.log(`📥 NEW LEAD: ${name} (${company}) — ${email} — ${type}`);
  io.emit('new_lead', lead);
  res.json({ success: true, lead });
});

app.get('/leads', (req, res) => res.json(leads));

app.patch('/leads/:id', (req, res) => {
  const idx = leads.findIndex(l => l.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  leads[idx] = { ...leads[idx], ...req.body, updatedAt: new Date().toISOString() };
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
  res.json({ success: true, lead: leads[idx] });
});

// ─── OWNER PORTAL — SEND DEMO INVITE EMAIL ─────────────────────────────────
const nodemailer = require('nodemailer');

app.post('/owner/send-invite', async (req, res) => {
  const { adminKey, recipientName, recipientEmail, productionCode, productionTitle, emailUser, emailPass } = req.body;
  if (adminKey !== (process.env.ADMIN_KEY || 'backlot-admin-2026')) return res.status(403).json({ error: 'Forbidden' });
  if (!recipientEmail || !productionCode) return res.status(400).json({ error: 'Missing fields' });

  const firstName = (recipientName || 'there').split(' ')[0];
  const appUrl = 'https://backlot-live-app.vercel.app';
  const joinUrl = `${appUrl}?code=${productionCode}`;

  const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0a;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <!-- HEADER -->
        <tr><td style="background:#111;border-radius:16px 16px 0 0;padding:32px 40px;text-align:center;border-bottom:2px solid #b266ff;">
          <div style="font-size:11px;font-weight:900;letter-spacing:4px;color:#b266ff;margin-bottom:8px;">BACKLOT LIVE™</div>
          <div style="font-size:26px;font-weight:900;color:#fff;letter-spacing:1px;">PRODUCTION MANAGEMENT SYSTEM</div>
          <div style="font-size:12px;color:#666;margin-top:6px;letter-spacing:2px;">PRIVATE DEMO INVITATION</div>
        </td></tr>

        <!-- BODY -->
        <tr><td style="background:#0d0d0d;padding:40px;">
          <p style="color:#ccc;font-size:16px;line-height:1.7;margin:0 0 24px;">Hi ${firstName},</p>
          <p style="color:#ccc;font-size:16px;line-height:1.7;margin:0 0 24px;">
            I'd like to invite you to try <strong style="color:#fff;">Backlot Live™</strong> — the production management platform purpose-built for the Australian film and television industry.
          </p>
          <p style="color:#ccc;font-size:16px;line-height:1.7;margin:0 0 32px;">
            Your private demo gives you full access to the platform — including crew onboarding, digital timecards, catering management, transport dispatch, and more.
          </p>

          <!-- CODE BOX -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
            <tr><td style="background:#1a1a1a;border:2px solid #b266ff;border-radius:12px;padding:28px;text-align:center;">
              <div style="font-size:11px;font-weight:900;letter-spacing:3px;color:#b266ff;margin-bottom:12px;">YOUR PRIVATE ACCESS CODE</div>
              <div style="font-size:42px;font-weight:900;color:#fff;letter-spacing:8px;font-family:monospace;">${productionCode}</div>
              <div style="font-size:12px;color:#666;margin-top:10px;">Enter this code when you open the app</div>
            </td></tr>
          </table>

          <!-- CTA BUTTON -->
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
            <tr><td align="center">
              <a href="${joinUrl}" style="display:inline-block;background:#b266ff;color:#fff;font-size:15px;font-weight:900;letter-spacing:2px;padding:18px 48px;border-radius:10px;text-decoration:none;">OPEN BACKLOT LIVE →</a>
            </td></tr>
          </table>

          <p style="color:#888;font-size:14px;line-height:1.6;margin:0 0 16px;">
            Or open <a href="${appUrl}" style="color:#b266ff;">${appUrl}</a> and enter code <strong style="color:#fff;font-family:monospace;font-size:16px;">${productionCode}</strong>
          </p>

          <p style="color:#888;font-size:13px;line-height:1.6;margin:24px 0 0;border-top:1px solid #1a1a1a;padding-top:24px;">
            Works on any device — iPhone, Android, iPad, or desktop browser. No download required.
          </p>
        </td></tr>

        <!-- FOOTER -->
        <tr><td style="background:#111;border-radius:0 0 16px 16px;padding:28px 40px;border-top:1px solid #1a1a1a;">
          <table width="100%">
            <tr>
              <td>
                <div style="font-size:13px;font-weight:900;color:#fff;margin-bottom:4px;">Jamie Dorward</div>
                <div style="font-size:12px;color:#888;">Operations Manager — Backlot Live™</div>
                <div style="margin-top:8px;">
                  <a href="mailto:info@backlotlive.com.au" style="color:#b266ff;font-size:12px;text-decoration:none;">info@backlotlive.com.au</a><br>
                  <span style="color:#888;font-size:12px;">+61 419 485 88</span>
                </div>
              </td>
              <td align="right">
                <div style="font-size:10px;color:#333;letter-spacing:2px;">BACKLOT LIVE™<br>Production Technology</div>
              </td>
            </tr>
          </table>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  // If SMTP credentials provided, send directly
  if (emailUser && emailPass) {
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: emailUser, pass: emailPass },
      });
      await transporter.sendMail({
        from: `"Jamie Dorward — Backlot Live" <${emailUser}>`,
        to: recipientEmail,
        subject: `Your Backlot Live™ Demo Access — Code: ${productionCode}`,
        html: htmlBody,
      });
      return res.json({ success: true, method: 'smtp', to: recipientEmail });
    } catch (err) {
      return res.status(500).json({ error: 'Email send failed', detail: err.message });
    }
  }

  // Otherwise return the HTML for the client to open via mailto
  const subject = encodeURIComponent(`Your Backlot Live™ Demo Access — Code: ${productionCode}`);
  const plainBody = encodeURIComponent(`Hi ${firstName},\n\nYou're invited to try Backlot Live™ — the production management platform for film and TV.\n\nYour private access code: ${productionCode}\n\nOpen the app at: ${appUrl}\nOr click: ${joinUrl}\n\n— Jamie Dorward\nOperations Manager, Backlot Live™\ninfo@backlotlive.com.au | +61 419 485 88`);
  const mailtoLink = `mailto:${recipientEmail}?subject=${subject}&body=${plainBody}`;
  res.json({ success: true, method: 'mailto', mailtoLink, htmlBody, to: recipientEmail });
});

const PORT = process.env.PORT || 4000;
// Sentry error handler — must be after all routes
Sentry.setupExpressErrorHandler(app);

server.listen(PORT, '0.0.0.0', () => console.log(`🎬 Backlot Live Backend v3 (Multi-Production) — http://0.0.0.0:${PORT}`));
