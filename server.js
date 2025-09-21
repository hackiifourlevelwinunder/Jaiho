// server.js — Fixed Final Version
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

function scheduleNextRound() {
  const now = new Date();
  const nextMinute = new Date(Math.ceil((now.getTime() + 1000) / 60000) * 60000);

  // Digit generate सिर्फ़ एक बार
  const buf = crypto.randomBytes(4);
  const digit = buf.readUInt32BE(0) % 10;

  // Preview emit 40s पहले
  const previewAt = new Date(nextMinute.getTime() - 40000);
  const delayToPreview = previewAt.getTime() - now.getTime();
  setTimeout(() => {
    io.emit("preview", {
      minuteBoundary: nextMinute.toISOString(),
      digit,
    });
    console.log("Preview:", digit, "for", nextMinute.toISOString());
  }, Math.max(0, delayToPreview));

  // Reveal emit 00s पर (same digit)
  const delayToReveal = nextMinute.getTime() - now.getTime();
  setTimeout(() => {
    io.emit("reveal", {
      minuteBoundary: nextMinute.toISOString(),
      digit,
    });
    console.log("Reveal:", digit, "for", nextMinute.toISOString());

    // अगला round schedule
    scheduleNextRound();
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
