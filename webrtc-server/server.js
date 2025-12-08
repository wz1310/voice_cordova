// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const twilio = require("twilio");

// === Ganti dengan SID dan AUTH token Twilio mu (ENV recommended) ===
const TWILIO_SID = "AC450e442565433adc3daefeab1155b172"; // SID Twilio mu
const TWILIO_AUTH = "19780bcdb59a4ae2a8895bc48db4d9be"; // Auth Token Twilio mu

const twilioClient = twilio(TWILIO_SID, TWILIO_AUTH);

const app = express();
const server = http.createServer(app);

// CORS minimal (DevTunnel friendly)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});

// small health endpoint
app.get("/", (req, res) => res.send("Voice server alive"));

// Twilio NTS token endpoint
app.get("/turn-token", async (req, res) => {
  try {
    // twilio.tokens.create() returns object with ice_servers (or iceServers)
    const token = await twilioClient.tokens.create();
    // return the token object directly (client will read ice_servers)
    res.json(token);
  } catch (err) {
    console.error("Twilio Error:", err && err.message ? err.message : err);
    res
      .status(500)
      .json({ error: "twilio_failed", message: err.message || String(err) });
  }
});

// Socket.IO: polling for DevTunnel stability
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

  // User menghentikan screen share
  socket.on("stop_screen_share", ({ toSocketId, fromSocketId }) => {
    if (toSocketId) {
      // Kirim ke user target
      io.to(toSocketId).emit("stop_screen_share", { fromSocketId });
    } else {
      // Jika tidak ada target spesifik, broadcast ke semua kecuali sender
      socket.broadcast.emit("stop_screen_share", { fromSocketId });
    }
  });

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
      if (u.socketId && u.socketId !== socket.id)
        existing.push({ slot: Number(s), socketId: u.socketId });
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
  socket.on("toggle_mic", ({ slot, userId, status }) => {
    if (slots[slot] && slots[slot].id === userId) {
      slots[slot].mic = status;
      io.emit("mic_status_changed", { slot, status });
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

  // kick user
  socket.on("kick_user", ({ userId }) => {
    console.log("Kick requested for:", userId);

    let kickedSlot = null;
    let kickedSocketId = null;

    for (const s in slots) {
      if (slots[s] && slots[s].id === userId) {
        kickedSlot = Number(s);
        kickedSocketId = slots[s].socketId;
        delete slots[s];
        break;
      }
    }

    if (kickedSlot !== null) {
      io.emit("user_left_voice", { slot: kickedSlot });
    } else {
      io.emit("update_slots", slots);
    }

    if (kickedSocketId) {
      io.to(kickedSocketId).emit("kicked");
      console.log("Sent 'kicked' to:", kickedSocketId);
    }
  });

  // WebRTC signaling
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

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Voice server running on port ${PORT}`);
});
