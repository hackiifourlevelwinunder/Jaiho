// server.js — Final ChaCha20 RNG version
import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));

// ---- ChaCha20 RNG Implementation ----
function rotl(v, c) { return ((v << c) | (v >>> (32 - c))) >>> 0; }
function quarterRound(state, a, b, c, d) {
  state[a] = (state[a] + state[b]) >>> 0; state[d] = rotl(state[d] ^ state[a], 16);
  state[c] = (state[c] + state[d]) >>> 0; state[b] = rotl(state[b] ^ state[c], 12);
  state[a] = (state[a] + state[b]) >>> 0; state[d] = rotl(state[d] ^ state[a], 8);
  state[c] = (state[c] + state[d]) >>> 0; state[b] = rotl(state[b] ^ state[c], 7);
}
function chacha20Block(key32, counter, nonce12) {
  const constants = [0x61707865,0x3320646e,0x79622d32,0x6b206574];
  const k = []; for (let i=0;i<8;i++) k.push(key32.readUInt32LE(i*4));
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

function generateDigit() {
  const block = chacha20Block(chacha.key, chacha.counter, chacha.nonce);
  chacha.counter++;
  const digit = block.readUInt16LE(0) % 10;
  return { digit, provider: "chacha20" };
}

// ---- Scheduling ----
function scheduleNextRound() {
  const now = new Date();
  const nextMinute = new Date(Math.ceil((now.getTime() + 1000) / 60000) * 60000);

  const { digit, provider } = generateDigit();

  // Preview 40s before
  const previewAt = new Date(nextMinute.getTime() - 40000);
  const delayToPreview = previewAt.getTime() - now.getTime();
  setTimeout(() => {
    io.emit("preview", {
      minuteBoundary: nextMinute.toISOString(),
      digit,
      provider,
    });
    console.log("Preview:", digit, "provider:", provider, "for", nextMinute.toISOString());
  }, Math.max(0, delayToPreview));

  // Reveal at :00
  const delayToReveal = nextMinute.getTime() - now.getTime();
  setTimeout(() => {
    io.emit("reveal", {
      minuteBoundary: nextMinute.toISOString(),
      digit,
      provider,
    });
    console.log("Reveal:", digit, "provider:", provider, "for", nextMinute.toISOString());

    scheduleNextRound(); // अगला round
  }, Math.max(0, delayToReveal));
}

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  socket.on("disconnect", () => console.log("Client disconnected:", socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
  scheduleNextRound();
});
