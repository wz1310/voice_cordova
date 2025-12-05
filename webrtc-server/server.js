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
  allowEIO3: true,
});

// Force engine to send CORS on polling endpoints
io.engine.on("headers", (headers) => {
  headers["Access-Control-Allow-Origin"] = "*";
  headers["Access-Control-Allow-Credentials"] = "false";
  headers["Access-Control-Allow-Headers"] = "*";
});

// ROOM STATE: slotNumber -> user object
const NUM_SLOTS = 8;
const slots = {}; // e.g. slots[1] = { id:'u123', name:'User', avatar:'...', mic:'on', slot:1, socketId:'...' }

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // optional identify
  socket.on("identify", (user) => {
    socket.data.user = user;
  });

  // get full room state
  socket.on("get_room_state", () => {
    io.to(socket.id).emit("room_state", { slots });
  });

  // join voice slot
  socket.on("join_voice", ({ slot, user }) => {
    if (typeof slot !== "number" || slot < 1 || slot > NUM_SLOTS) {
      socket.emit("join_failed", { slot, reason: "invalid_slot" });
      return;
    }

    // remove user from previous slot (if any)
    for (const s in slots) {
      if (slots[s] && slots[s].id === user.id) {
        delete slots[s];
        io.emit("user_left_voice", { slot: Number(s) });
      }
    }

    // if slot occupied by different user -> fail
    if (slots[slot] && slots[slot].id !== user.id) {
      socket.emit("join_failed", { slot, reason: "occupied" });
      return;
    }

    // assign slot
    slots[slot] = {
      ...user,
      mic: "on",
      slot: Number(slot),
      socketId: socket.id,
      speaking: false,
    };

    // notify all clients
    io.emit("user_joined_voice", { slot, user: slots[slot] });

    // prepare existing peers list for the new joiner
    const existing = [];
    for (const s in slots) {
      const u = slots[s];
      if (u.socketId && u.socketId !== socket.id) existing.push({ slot: Number(s), socketId: u.socketId });
    }
    io.to(socket.id).emit("existing_peers", existing);

    console.log("User joined slot:", slot, slots[slot]);
  });

  // leave voice slot
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

  // user speaking indicator (broadcast to others)
  socket.on("user_speaking", ({ userId, speaking }) => {
    for (const s in slots) {
      if (slots[s] && slots[s].id === userId) slots[s].speaking = speaking;
    }
    socket.broadcast.emit("user_speaking", { userId, speaking });
  });

  // user chat (typing / live text)
  socket.on("user_chat", ({ userId, message }) => {
    io.emit("user_chat", { userId, message });
  });

  // kick user (only remove target user and notify)
  socket.on("kick_user", ({ userId }) => {
    console.log("Kick requested for:", userId);

    let kickedSlot = null;
    let kickedSocketId = null;

    for (const s in slots) {
      if (slots[s] && slots[s].id === userId) {
        kickedSlot = Number(s);
        kickedSocketId = slots[s].socketId;
        delete slots[s];
        break; // user IDs unique, stop after found
      }
    }

    if (kickedSlot !== null) {
      // notify everyone slot emptied (clients handle UI update)
      io.emit("user_left_voice", { slot: kickedSlot });
    } else {
      // defensive: send update_slots if nothing found
      io.emit("update_slots", slots);
    }

    if (kickedSocketId) {
      // send 'kicked' only to target socket
      io.to(kickedSocketId).emit("kicked");
      console.log("Sent 'kicked' to:", kickedSocketId);
      // NOTE: we do not forcibly disconnect server-side here to allow client cleanup flow.
    }
  });

  // ---------------- WebRTC signaling ----------------
  socket.on("webrtc-offer", ({ toSocketId, fromSocketId, sdp }) => {
    if (!toSocketId) return;
    io.to(toSocketId).emit("webrtc-offer", { fromSocketId, sdp });
  });

  socket.on("webrtc-answer", ({ toSocketId, fromSocketId, sdp }) => {
    if (!toSocketId) return;
    io.to(toSocketId).emit("webrtc-answer", { fromSocketId, sdp });
  });

  socket.on("webrtc-ice", ({ toSocketId, candidate, fromSocketId }) => {
    if (!toSocketId) return;
    io.to(toSocketId).emit("webrtc-ice", { fromSocketId, candidate });
  });

  // disconnect cleanup
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
    for (const s in slots) {
      if (slots[s] && slots[s].socketId === socket.id) {
        delete slots[s];
        io.emit("user_left_voice", { slot: Number(s) });
      }
    }
  });
});

server.listen(5000, () => {
  console.log("Voice server running on port 5000");
});