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

const DB_FILE = path.join(__dirname, 'crew_db.json');
const RECEIPTS_FILE = path.join(__dirname, 'receipts_db.json');
const CATERING_FILE = path.join(__dirname, 'catering_db.json');

// Seed data so admin always has records
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify([
    { name: "Jamie Dorward", role: "Producer", phone: "0400 000 000", department: "PRODUCTION", timestamp: new Date().toISOString() },
    { name: "Sarah Jones", role: "Set Nurse", phone: "0411 111 111", department: "MEDICAL", timestamp: new Date().toISOString() }
  ], null, 2));
}
if (!fs.existsSync(RECEIPTS_FILE)) fs.writeFileSync(RECEIPTS_FILE, JSON.stringify([]));
if (!fs.existsSync(CATERING_FILE)) fs.writeFileSync(CATERING_FILE, JSON.stringify([]));

let crew = JSON.parse(fs.readFileSync(DB_FILE));
let receipts = JSON.parse(fs.readFileSync(RECEIPTS_FILE));
let catering = JSON.parse(fs.readFileSync(CATERING_FILE));
let activeRequests = [];

app.get('/status', (req, res) => res.json({ status: 'OK', crew: crew.length, receipts: receipts.length }));

// ONBOARDING - save immediately to disk and broadcast
app.post('/onboard', (req, res) => {
  const entry = { ...req.body, timestamp: new Date().toISOString() };
  crew.push(entry);
  fs.writeFileSync(DB_FILE, JSON.stringify(crew, null, 2));
  console.log(`✅ ONBOARDED: ${entry.name}`);
  io.emit('new_crew', entry);
  io.emit('sync_crew', crew);
  res.json({ success: true });
});

app.get('/crew', (req, res) => res.json(crew));

// RECEIPTS
app.post('/receipts', (req, res) => {
  const entry = { ...req.body, id: Date.now(), timestamp: new Date().toISOString() };
  receipts.push(entry);
  fs.writeFileSync(RECEIPTS_FILE, JSON.stringify(receipts, null, 2));
  console.log(`💰 RECEIPT: ${entry.shop} - ${entry.amount}`);
  io.emit('new_receipt', entry);
  io.emit('sync_receipts', receipts);
  res.json({ success: true });
});

app.get('/receipts', (req, res) => res.json(receipts));

// CATERING
app.post('/catering', (req, res) => {
  const entry = { ...req.body, id: Date.now(), timestamp: new Date().toISOString() };
  catering.push(entry);
  fs.writeFileSync(CATERING_FILE, JSON.stringify(catering, null, 2));
  console.log(`🍽️ CATERING: ${entry.dept} - ${entry.total} pax`);
  io.emit('new_catering', entry);
  res.json({ success: true });
});

app.get('/catering', (req, res) => res.json(catering));

// SOCKET - always sync full state on connect
io.on('connection', (socket) => {
  console.log('📱 Connected:', socket.id);
  socket.emit('sync_crew', crew);
  socket.emit('sync_receipts', receipts);
  socket.emit('sync_catering', catering);
  socket.emit('sync_requests', activeRequests);

  socket.on('broadcast_set_status', (status) => io.emit('set_status_update', status));
  
  socket.on('request_swing', (data) => {
    const req = { id: Date.now(), ...data, time: new Date().toLocaleTimeString(), status: 'Waiting' };
    activeRequests.push(req);
    io.emit('new_request', req);
    io.emit('sync_requests', activeRequests);
  });

  socket.on('disconnect', () => console.log('Disconnected:', socket.id));
});

server.listen(4000, '0.0.0.0', () => console.log('🎬 Backlot Live Backend on http://0.0.0.0:4000'));
