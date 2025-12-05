// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// CORS minimal (DevTunnel friendly)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});

// Socket.IO: polling (DevTunnel) for stability
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"], allowedHeaders: ["*"] },
  transports: ["polling"],
  allowEIO3: true
});

// Force engine to send CORS on polling endpoints
io.engine.on("headers", (headers) => {
  headers["Access-Control-Allow-Origin"] = "*";
  headers["Access-Control-Allow-Credentials"] = "false";
  headers["Access-Control-Allow-Headers"] = "*";
});

// ROOM STATE: slots map slotNumber -> user object (include socketId)
const NUM_SLOTS = 8;
const slots = {}; // e.g. slots[1] = { id: 'u123', name:'User', avatar:'...', mic:'on', slot:1, socketId:'abcd' }

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // identify user (client sends user info)
  socket.on("identify", (user) => {
    socket.data.user = user; // keep user info if needed
  });

  // client asks full room snapshot
  socket.on("get_room_state", () => {
    io.to(socket.id).emit("room_state", { slots });
  });

  // join voice (slot)
  socket.on("join_voice", ({ slot, user }) => {
    // remove user from any previous slot (auto-move)
    for (const s in slots) {
      if (slots[s].id === user.id) {
        delete slots[s];
        io.emit("user_left_voice", { slot: Number(s) });
      }
    }

    // if slot occupied by other, reject
    if (slots[slot] && slots[slot].id !== user.id) {
      socket.emit("join_failed", { slot, reason: "occupied" });
      return;
    }

    // save user with socketId to be used in signaling
    slots[slot] = {
      ...user,
      mic: "on",
      slot: Number(slot),
      socketId: socket.id
    };

    // notify everyone user joined
    io.emit("user_joined_voice", { slot, user: slots[slot] });

    // inform the new joiner about existing peers (socketIds)
    const existing = [];
    for (const s in slots) {
      const u = slots[s];
      if (u.socketId && u.socketId !== socket.id) existing.push({ slot: Number(s), socketId: u.socketId });
    }
    // send list only to the newly joined socket
    io.to(socket.id).emit("existing_peers", existing);

    console.log("User joined slot:", slot, slots[slot]);
  });

  // leave voice
  socket.on("leave_voice", ({ slot, userId }) => {
    if (slots[slot] && slots[slot].id === userId) {
      delete slots[slot];
      io.emit("user_left_voice", { slot });
    }
  });

  // toggle mic
  socket.on("toggle_mic", ({ slot, userId }) => {
    if (slots[slot] && slots[slot].id === userId) {
      slots[slot].mic = slots[slot].mic === "on" ? "off" : "on";
      io.emit("mic_status_changed", { slot, status: slots[slot].mic });
    }
  });

  // ---------------- Signaling events ----------------
  // offer from A to B
  socket.on("webrtc-offer", ({ toSocketId, fromSocketId, sdp }) => {
    io.to(toSocketId).emit("webrtc-offer", { fromSocketId, sdp });
  });

  // answer from B to A
  socket.on("webrtc-answer", ({ toSocketId, fromSocketId, sdp }) => {
    io.to(toSocketId).emit("webrtc-answer", { fromSocketId, sdp });
  });

  // ice candidate
  socket.on("webrtc-ice", ({ toSocketId, candidate, fromSocketId }) => {
    io.to(toSocketId).emit("webrtc-ice", { fromSocketId, candidate });
  });

  // disconnect cleanup: if user had a slot, free it and notify
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    for (const s in slots) {
      if (slots[s].socketId === socket.id) {
        delete slots[s];
        io.emit("user_left_voice", { slot: Number(s) });
      }
    }
  });
});

server.listen(3000, () => {
  console.log("Voice server running on port 3000");
});
