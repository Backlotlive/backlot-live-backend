const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Serve the full compiled Expo app
app.use(express.static(path.join('/Users/jamiedorward/.openclaw/workspace/backlot-live-app/dist')));

const DB_FILE =         path.join(__dirname, 'crew_db.json');
const RECEIPTS_FILE =   path.join(__dirname, 'receipts_db.json');
const CATERING_FILE =   path.join(__dirname, 'catering_db.json');
const TIMESHEETS_FILE = path.join(__dirname, 'timesheets_db.json');
const PAYROLL_FILE =    path.join(__dirname, 'payroll_batches.json');
const INCIDENTS_FILE =  path.join(__dirname, 'incidents_db.json');
const ASSETS_FILE =     path.join(__dirname, 'assets_db.json');

[DB_FILE, RECEIPTS_FILE, CATERING_FILE, TIMESHEETS_FILE, PAYROLL_FILE, INCIDENTS_FILE, ASSETS_FILE].forEach(f => {
  if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify([]));
});

let crew          = JSON.parse(fs.readFileSync(DB_FILE));
let receipts      = JSON.parse(fs.readFileSync(RECEIPTS_FILE));
let catering      = JSON.parse(fs.readFileSync(CATERING_FILE));
let timesheets    = JSON.parse(fs.readFileSync(TIMESHEETS_FILE));
let payrollBatches= JSON.parse(fs.readFileSync(PAYROLL_FILE));
let incidents     = JSON.parse(fs.readFileSync(INCIDENTS_FILE));
let assets        = JSON.parse(fs.readFileSync(ASSETS_FILE));
let activeRequests = [];

// ─── OVERTIME ENGINE ──────────────────────────────────────────────────────────

// MEAA 2024 base rate used when no custom hourly rate is set
// Source: MEAA Motion Picture Production Agreement 2024
const MEAA_BASE_HOURLY = 58.50; // MEAA 2024 standard crew minimum

const MEAA_RATES = {
  ordinary: MEAA_BASE_HOURLY,                    // $58.50/hr
  overtime_1: MEAA_BASE_HOURLY * 1.5,            // $87.75/hr (1.5x after 10hrs)
  overtime_2: MEAA_BASE_HOURLY * 2.0,            // $117.00/hr (2x after 12hrs)
  seventh_day: MEAA_BASE_HOURLY * 2.0,           // $117.00/hr (7th day)
  meal_penalty_per_event: 14.05,                  // MEAA 2024 meal penalty
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

// ─── PAYROLL ──────────────────────────────────────────────────────────────────

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
    const dayOfWeek = new Date(ts.timestamp).getDay();
    const isSeventhDay = ts.isSeventhDay === true; // Only when explicitly flagged
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

app.post('/payroll/batch', (req, res) => {
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
  const entry = { ...req.body, id: Date.now(), timestamp: new Date().toISOString(), status: 'OPEN' };
  incidents.push(entry);
  fs.writeFileSync(INCIDENTS_FILE, JSON.stringify(incidents, null, 2));
  console.log(`🚨 INCIDENT: ${entry.severity} — ${entry.description}`);
  io.emit('new_incident', entry);
  res.json({ success: true });
});

app.get('/incidents', (req, res) => res.json(incidents));

app.patch('/incidents/:id', (req, res) => {
  const idx = incidents.findIndex(i => i.id == req.params.id);
  if (idx >= 0) { incidents[idx] = { ...incidents[idx], ...req.body }; fs.writeFileSync(INCIDENTS_FILE, JSON.stringify(incidents, null, 2)); }
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

app.get('/status', (req, res) => res.json({ status: 'OK', crew: crew.length, receipts: receipts.length, incidents: incidents.filter(i => i.status === 'OPEN').length }));

app.get('/crew/lookup', (req, res) => {
  const { phone, name } = req.query;
  const match = crew.find(c => (phone && c.phone?.replace(/\s/g,'') === phone.replace(/\s/g,'')) || (name && c.name?.toLowerCase() === name.toLowerCase()));
  res.json(match || null);
});

app.post('/onboard', (req, res) => {
  const entry = { ...req.body, timestamp: new Date().toISOString() };
  const idx = crew.findIndex(c => c.phone?.replace(/\s/g,'') === (entry.phone||'').replace(/\s/g,''));
  if (idx >= 0) crew[idx] = { ...crew[idx], ...entry, lastSeen: new Date().toISOString() };
  else crew.push(entry);
  fs.writeFileSync(DB_FILE, JSON.stringify(crew, null, 2));
  io.emit('new_crew', entry); io.emit('sync_crew', crew);
  res.json({ success: true });
});

app.get('/crew', (req, res) => res.json(crew));

app.patch('/crew/revoke', (req, res) => {
  const { phone, name, revoked } = req.body;
  const idx = crew.findIndex(c =>
    (phone && c.phone?.replace(/\s/g,'') === phone?.replace(/\s/g,'')) ||
    (name && c.name?.toLowerCase() === name?.toLowerCase())
  );
  if (idx >= 0) {
    crew[idx] = { ...crew[idx], passRevoked: revoked, revokedAt: revoked ? new Date().toISOString() : null };
    fs.writeFileSync(DB_FILE, JSON.stringify(crew, null, 2));
    io.emit('sync_crew', crew);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Crew member not found' });
  }
});

app.post('/timesheets', (req, res) => {
  const entry = { ...req.body, id: Date.now(), timestamp: new Date().toISOString() };
  timesheets.push(entry);
  fs.writeFileSync(TIMESHEETS_FILE, JSON.stringify(timesheets, null, 2));
  io.emit('new_timesheet', entry);
  res.json({ success: true });
});

app.get('/timesheets', (req, res) => res.json(timesheets));

app.post('/receipts', (req, res) => {
  const entry = { ...req.body, id: Date.now(), timestamp: new Date().toISOString() };
  receipts.push(entry);
  fs.writeFileSync(RECEIPTS_FILE, JSON.stringify(receipts, null, 2));
  io.emit('new_receipt', entry); io.emit('sync_receipts', receipts);
  res.json({ success: true });
});

app.get('/receipts', (req, res) => res.json(receipts));

app.post('/catering', (req, res) => {
  const entry = { ...req.body, id: Date.now(), timestamp: new Date().toISOString() };
  catering.push(entry);
  fs.writeFileSync(CATERING_FILE, JSON.stringify(catering, null, 2));
  io.emit('new_catering', entry);
  res.json({ success: true });
});

app.get('/catering', (req, res) => res.json(catering));

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
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, '0.0.0.0', () => console.log(`🎬 Backlot Live Backend v2 — http://0.0.0.0:${PORT}`));
