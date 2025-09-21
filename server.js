// server.js - World RNG Mix (OpenSSL, ChaCha20, Fortuna-like, NIST beacon, drand)
// Produces a final 0-9 digit per minute, emits preview at :20 (40s before) and reveal at :00.
import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

// --- Fortuna-like AES-CTR ---
const fortuna = { key: crypto.randomBytes(32), counter: Buffer.alloc(16, 0), requests: 0 };
function incrementCounter(buf) {
  for (let i = 15; i >= 0; i--) {
    buf[i] = (buf[i] + 1) & 0xff;
    if (buf[i] !== 0) break;
  }
}
function aesCtrNext(key, counter, nbytes = 32) {
  const cipher = crypto.createCipheriv("aes-256-ctr", key, counter);
  const out = cipher.update(Buffer.alloc(nbytes));
  incrementCounter(counter);
  return out;
}
function maybeReseedFortuna() {
  fortuna.requests++;
  if (fortuna.requests % 100 === 0) {
    const extra = crypto.randomBytes(32);
    const h = crypto.createHmac("sha256", fortuna.key).update(extra).digest();
    fortuna.key = h;
  }
}

// --- ChaCha20 block (RFC-like) ---
function rotl(v, c) { return ((v << c) | (v >>> (32 - c))) >>> 0; }
function quarterRound(state, a, b, c, d) {
  state[a] = (state[a] + state[b]) >>> 0; state[d] = rotl(state[d] ^ state[a], 16);
  state[c] = (state[c] + state[d]) >>> 0; state[b] = rotl(state[b] ^ state[c], 12);
  state[a] = (state[a] + state[b]) >>> 0; state[d] = rotl(state[d] ^ state[a], 8);
  state[c] = (state[c] + state[d]) >>> 0; state[b] = rotl(state[b] ^ state[c], 7);
}
function chacha20Block(key32, counter, nonce12) {
  const constants = [0x61707865,0x3320646e,0x79622d32,0x6b206574];
  const k = [];
  for (let i = 0; i < 8; i++) k.push(key32.readUInt32LE(i*4));
  const state = new Uint32Array(16);
  state[0]=constants[0]; state[1]=constants[1]; state[2]=constants[2]; state[3]=constants[3];
  for (let i=0;i<8;i++) state[4+i]=k[i];
  state[12] = counter >>> 0;
  state[13] = nonce12.readUInt32LE(0);
  state[14] = nonce12.readUInt32LE(4);
  state[15] = nonce12.readUInt32LE(8);

  const working = new Uint32Array(state);
  for (let i=0;i<10;i++) {
    quarterRound(working,0,4,8,12);
    quarterRound(working,1,5,9,13);
    quarterRound(working,2,6,10,14);
    quarterRound(working,3,7,11,15);
    quarterRound(working,0,5,10,15);
    quarterRound(working,1,6,11,12);
    quarterRound(working,2,7,8,13);
    quarterRound(working,3,4,9,14);
  }

  const out = Buffer.alloc(64);
  for (let i=0;i<16;i++) {
    const v = (working[i] + state[i]) >>> 0;
    out.writeUInt32LE(v, i*4);
  }
  return out;
}
const chacha = { key: crypto.randomBytes(32), nonce: crypto.randomBytes(12), counter: 1 };

// --- Fetch helpers with timeout ---
async function fetchWithTimeout(url, ms=5000) {
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), ms);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) throw new Error("bad response");
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function fetchNIST() {
  try {
    const url = "https://beacon.nist.gov/beacon/2.0/pulse/last";
    const j = await fetchWithTimeout(url, 5000);
    return j?.pulse?.outputValue || null;
  } catch (e) { return null; }
}
async function fetchDrand() {
  // try Cloudflare drand and fallback to drand API
  const urls = ["https://drand.cloudflare.com/public/latest", "https://api.drand.sh/public/latest"];
  for (const u of urls) {
    const j = await fetchWithTimeout(u, 4000);
    if (j && (j.round || j.signature || j.crypto_hash)) return j?.random || j?.round?.toString() || (j?.signature || null);
  }
  return null;
}

// --- Combine providers to final digit ---
async function computeMixedDigit(minuteBoundaryMs) {
  // collect parts
  const parts = [];

  // 1) NIST beacon (async)
  const nist = await fetchNIST();
  if (nist) parts.push("nist:" + nist.slice(0,64));

  // 2) drand
  const dr = await fetchDrand();
  if (dr) parts.push("drand:" + String(dr).slice(0,64));

  // 3) OpenSSL (crypto.randomBytes)
  const opensslBuf = crypto.randomBytes(32);
  parts.push("openssl:" + opensslBuf.toString("hex"));

  // 4) Fortuna-like AES-CTR output
  maybeReseedFortuna();
  const fortunaOut = aesCtrNext(fortuna.key, fortuna.counter, 32);
  parts.push("fortuna:" + fortunaOut.toString("hex"));

  // 5) ChaCha20 block
  const chachaBlock = chacha20Block(chacha.key, chacha.counter, chacha.nonce);
  chacha.counter++;
  parts.push("chacha20:" + chachaBlock.toString("hex"));

  // 6) timestamp
  parts.push("ts:" + new Date(minuteBoundaryMs).toISOString());

  const combined = parts.join("|");
  const hash = crypto.createHash("sha256").update(combined).digest("hex");
  const first16 = hash.slice(0,16);
  const digit = Number(BigInt('0x' + first16) % 10n);

  return { digit, hash, parts };
}

// state and stats
let lastScheduled = null;
const stats = { openssl:0, fortuna:0, chacha20:0, nist:0, drand:0 };

function msUntilNextPreview() {
  const now = Date.now();
  const nextMinute = Math.ceil(now/60000)*60000;
  const previewTime = nextMinute - 40000; // :20
  return previewTime - now;
}

async function scheduleLoop() {
  const ms = msUntilNextPreview();
  const wait = Math.max(0, ms);
  console.log("Scheduling next preview in", wait, "ms");
  setTimeout(async () => {
    const nextMinuteBoundary = Math.ceil(Date.now()/60000)*60000;
    const minuteBoundaryISO = new Date(nextMinuteBoundary).toISOString();

    // compute mixed digit (collects multiple providers)
    const mixed = await computeMixedDigit(nextMinuteBoundary);

    // decide primary provider for stats: choose provider that contributed (prefer NIST, drand, openssl, fortuna, chacha)
    let primary = "openssl";
    if (mixed.parts.some(p=>p.startsWith("nist:"))) primary = "nist";
    else if (mixed.parts.some(p=>p.startsWith("drand:"))) primary = "drand";
    else if (mixed.parts.some(p=>p.startsWith("openssl:"))) primary = "openssl";
    else if (mixed.parts.some(p=>p.startsWith("fortuna:"))) primary = "fortuna";
    else if (mixed.parts.some(p=>p.startsWith("chacha20:"))) primary = "chacha20";

    stats[primary] = (stats[primary] || 0) + 1;

    // publish preview immediately (preview time)
    const previewPayload = { minuteBoundary: minuteBoundaryISO, previewAt: new Date(nextMinuteBoundary-40000).toISOString(), digit: mixed.digit, hash: mixed.hash };
    io.emit("preview", previewPayload);
    console.log("Preview:", previewPayload);

    // schedule reveal at minuteBoundary
    const delayToReveal = nextMinuteBoundary - Date.now();
    setTimeout(() => {
      const revealPayload = { minuteBoundary: minuteBoundaryISO, revealAt: new Date(nextMinuteBoundary).toISOString(), digit: mixed.digit, hash: mixed.hash };
      io.emit("reveal", revealPayload);
      io.emit("stats", stats);
      console.log("Reveal:", revealPayload);
    }, Math.max(0, delayToReveal));

    // loop
    scheduleLoop();
  }, wait+10);
}

io.on("connection", (socket) => {
  socket.emit("state", { stats });
  console.log("Client connected:", socket.id);
});

// stats endpoint
app.get("/api/stats", (req, res) => res.json(stats));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server listening on", PORT);
  scheduleLoop();
});
