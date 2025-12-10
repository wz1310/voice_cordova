// ==================================================
//  Imports & Setup
// ==================================================
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const twilio = require("twilio");

// --------------------------------------------------
//  Twilio Credentials (gunakan ENV pada production)
// --------------------------------------------------
const TWILIO_SID = "AC450e442565433adc3daefeab1155b172";
const TWILIO_AUTH = "a58b1391ecf34c18f9e4bbfffa180255";

const twilioClient = twilio(TWILIO_SID, TWILIO_AUTH);

const app = express();
const server = http.createServer(app);

// ==================================================
//  CORS (DevTunnel Friendly)
// ==================================================
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  next();
});

// ==================================================
//  Basic Health Check
// ==================================================
app.get("/", (req, res) => {
  res.send("Voice server alive");
});

// ==================================================
//  Twilio TURN Token Endpoint
// ==================================================
app.get("/turn-token", async (req, res) => {
  try {
    const token = await twilioClient.tokens.create();
    res.json(token);
  } catch (err) {
    console.error("Twilio Error:", err.message || err);
    res.status(500).json({
      error: "twilio_failed",
      message: err.message || String(err),
    });
  }
});

// ==================================================
//  Socket.IO Configuration
// ==================================================
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"], allowedHeaders: ["*"] },
  transports: ["polling"], // Lebih stabil untuk DevTunnel
  allowEIO3: true,
});

// Inject CORS ke polling header Socket.IO
io.engine.on("headers", (headers) => {
  headers["Access-Control-Allow-Origin"] = "*";
  headers["Access-Control-Allow-Credentials"] = "false";
  headers["Access-Control-Allow-Headers"] = "*";
});

// ==================================================
//  Voice Room State
// ==================================================
const NUM_SLOTS = 8;
const slots = {};
// Example: slots[1] = { id, name, mic, slot, socketId, speaking }

// ==================================================
//  Socket.IO Events
// ==================================================
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // ----------------------------
  //  Screen Share Started <-- BARU
  // ----------------------------
  socket.on("start_screen_share_signal", ({ fromSocketId }) => {
    // Kirim sinyal ke semua client lain KECUALI pengirim (User A)
    socket.broadcast.emit("start_screen_share_signal", {
      fromSocketId: fromSocketId, // Pastikan menggunakan ID pengirim dari klien
    });

    console.log(`[SIGNAL] Screen share signal sent by: ${fromSocketId}`);
  });

  // ----------------------------
  //  Screen Share Stopped
  // ----------------------------
  socket.on("stop_screen_share", ({ toSocketId, fromSocketId }) => {
    if (toSocketId) {
      io.to(toSocketId).emit("stop_screen_share", { fromSocketId });
    } else {
      socket.broadcast.emit("stop_screen_share", { fromSocketId });
    }
  });

  // ----------------------------
  //  Identity Attach
  // ----------------------------
  socket.on("identify", (user) => {
    socket.data.user = user;
  });

  // ----------------------------
  //  Get Room State
  // ----------------------------
  socket.on("get_room_state", () => {
    io.to(socket.id).emit("room_state", { slots });
  });

  // ----------------------------
  //  Join Voice Slot
  // ----------------------------
  socket.on("join_voice", ({ slot, user }) => {
    if (typeof slot !== "number" || slot < 1 || slot > NUM_SLOTS) {
      socket.emit("join_failed", { slot, reason: "invalid_slot" });
      return;
    }

    // Remove dari slot sebelumnya
    for (const s in slots) {
      if (slots[s]?.id === user.id) {
        delete slots[s];
        io.emit("user_left_voice", { slot: Number(s) });
      }
    }

    // Slot dipakai user lain
    if (slots[slot] && slots[slot].id !== user.id) {
      socket.emit("join_failed", { slot, reason: "occupied" });
      return;
    }

    // Assign user ke slot
    slots[slot] = {
      ...user,
      mic: user.mic || "on",
      webcam: user.webcam || "off",
      slot: Number(slot),
      socketId: socket.id,
      speaking: false,
    };

    io.emit("user_joined_voice", { slot, user: slots[slot] });

    // Kirim daftar peer lain ke user yang baru join
    const existing = Object.keys(slots)
      .filter((s) => slots[s].socketId !== socket.id)
      .map((s) => ({
        slot: Number(s),
        socketId: slots[s].socketId,
      }));

    io.to(socket.id).emit("existing_peers", existing);

    console.log("User joined slot:", slot, slots[slot]);
  });

  // ----------------------------
  //  Leave Voice
  // ----------------------------
  socket.on("leave_voice", ({ slot, userId }) => {
    if (slots[slot]?.id === userId) {
      delete slots[slot];
      io.emit("user_left_voice", { slot });
    }
  });

  // ----------------------------
  //  Toggle Mic
  // ----------------------------
  socket.on("toggle_mic", ({ slot, userId, status }) => {
    if (slots[slot]?.id === userId) {
      slots[slot].mic = status;
      io.emit("mic_status_changed", { slot, status });
    }
  });

  // ----------------------------
  //  Toggle Webcam <-- BARU
  // ----------------------------
  socket.on("toggle_webcam", ({ slot, userId, status }) => {
    if (slots[slot]?.id === userId) {
      slots[slot].webcam = status;
      io.emit("webcam_status_changed", { slot, status });
    }
  });

  // ----------------------------
  //  Speaking Indicator
  // ----------------------------
  socket.on("user_speaking", ({ userId, speaking }) => {
    for (const s in slots) {
      if (slots[s]?.id === userId) slots[s].speaking = speaking;
    }
    socket.broadcast.emit("user_speaking", { userId, speaking });
  });

  // ----------------------------
  //  Live Chat (Text)
  // ----------------------------
  socket.on("user_chat", ({ userId, message }) => {
    io.emit("user_chat", { userId, message });
  });

  // ----------------------------
  //  Kick User
  // ----------------------------
  socket.on("kick_user", ({ userId }) => {
    console.log("Kick requested for:", userId);

    let kickedSlot = null;
    let kickedSocketId = null;

    for (const s in slots) {
      if (slots[s]?.id === userId) {
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

  // ----------------------------
  //  WebRTC Signaling
  // ----------------------------
  socket.on("webrtc-offer", ({ toSocketId, fromSocketId, sdp }) => {
    if (toSocketId)
      io.to(toSocketId).emit("webrtc-offer", { fromSocketId, sdp });
  });

  socket.on("webrtc-answer", ({ toSocketId, fromSocketId, sdp }) => {
    if (toSocketId)
      io.to(toSocketId).emit("webrtc-answer", { fromSocketId, sdp });
  });

  socket.on("webrtc-ice", ({ toSocketId, candidate, fromSocketId }) => {
    if (toSocketId)
      io.to(toSocketId).emit("webrtc-ice", { fromSocketId, candidate });
  });

  // ----------------------------
  //  Disconnect Cleanup
  // ----------------------------
  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);

    for (const s in slots) {
      if (slots[s]?.socketId === socket.id) {
        delete slots[s];
        io.emit("user_left_voice", { slot: Number(s) });
      }
    }
  });
});

// ==================================================
//  Server Start
// ==================================================
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Voice server running on port ${PORT}`);
});
