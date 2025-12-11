// ==================================================
//  Imports & Setup
// ==================================================
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const twilio = require("twilio");
const fs = require("fs");
const path = require("path");

// --------------------------------------------------
//  Twilio Credentials (gunakan ENV pada production)
// --------------------------------------------------
const TWILIO_SID = "AC450e442565433adc3daefeab1155b172";
const TWILIO_AUTH = "4513557fba41d18bdc6bf67bb17ea8b7";

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
    console.error("Twilio Error:", err.message);
    res.status(500).json({
      error: "twilio_failed",
      message: err.message,
    });
  }
});

// ==================================================
//  Load User Data
// ==================================================
let registeredUsers = [];

try {
  const dataPath = path.join(__dirname, "data", "data.json");
  const raw = fs.readFileSync(dataPath, "utf-8");
  registeredUsers = JSON.parse(raw);

  console.log(`Loaded ${registeredUsers.length} registered users.`);
} catch (err) {
  console.error("Error loading data.json:", err.message);
}

// ==================================================
//  Socket.IO Configuration
// ==================================================
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"], allowedHeaders: ["*"] },
  transports: ["polling"],
  allowEIO3: true,
});

// Inject CORS ke header polling
io.engine.on("headers", (headers) => {
  headers["Access-Control-Allow-Origin"] = "*";
  headers["Access-Control-Allow-Credentials"] = "false";
  headers["Access-Control-Allow-Headers"] = "*";
});

// ==================================================
//  Voice Room State
// ==================================================
const NUM_SLOTS = 8;
const slots = {}; // slots[n]: { id, name, mic, webcam, slot, socketId, speaking }

// ==================================================
//  Socket.IO Events
// ==================================================
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // --------------------------------------------------
  //  Screen Share Started
  // --------------------------------------------------
  socket.on("start_screen_share_signal", ({ fromSocketId, toSocketId }) => {
    if (toSocketId) {
      io.to(toSocketId).emit("start_screen_share_signal", { fromSocketId });
      console.log(`[SCREEN] ${fromSocketId} → NEW PEER: ${toSocketId}`);
    } else {
      socket.broadcast.emit("start_screen_share_signal", { fromSocketId });
      console.log(`[SCREEN] ${fromSocketId} broadcast to all`);
    }
  });

  // --------------------------------------------------
  //  Screen Share Stopped
  // --------------------------------------------------
  socket.on("stop_screen_share", ({ toSocketId, fromSocketId }) => {
    if (toSocketId) io.to(toSocketId).emit("stop_screen_share", { fromSocketId });
    else socket.broadcast.emit("stop_screen_share", { fromSocketId });
  });

  // --------------------------------------------------
  //  Identify
  // --------------------------------------------------
  socket.on("identify", (user) => {
    socket.data.user = user;
  });

  // --------------------------------------------------
  //  Get Room State
  // --------------------------------------------------
  socket.on("get_room_state", () => {
    io.to(socket.id).emit("room_state", { slots });
  });

  // --------------------------------------------------
  //  Login Validation
  // --------------------------------------------------
  socket.on("validate_login", ({ username, password }) => {
    const userMatch = registeredUsers.find(
      (u) => u.username === username && u.password === password
    );

    if (userMatch) {
      socket.emit("login_success", {
        isValid: true,
        name: userMatch.name,
        userId: userMatch.id,
      });
    } else {
      socket.emit("login_failure", {
        isValid: false,
        message: "Invalid username or password.",
      });
    }
  });

  // --------------------------------------------------
  //  Join Voice Slot
  // --------------------------------------------------
  socket.on("join_voice", ({ slot, user, authUserId }) => {
    // Cegah duplikasi sesi user
    const existingSlot = Object.values(slots).find(
      (s) => s.authUserId === authUserId
    );

    if (existingSlot && existingSlot.slot !== slot) {
      socket.emit("join_failed", { slot, reason: "duplicate_id" });
      return;
    }

    // Slot terisi user lain
    if (slots[slot] && slots[slot].authUserId !== authUserId) {
      socket.emit("join_failed", { slot, reason: "occupied" });
      return;
    }

    const userMatch = registeredUsers.find((u) => u.id === authUserId);

    if (!userMatch) {
      socket.emit("join_failed", { slot, reason: "unauthorized" });
      return;
    }

    // Pakai data resmi dari server
    user.name = userMatch.name;
    user.id = authUserId;

    if (slot < 1 || slot > NUM_SLOTS) {
      socket.emit("join_failed", { slot, reason: "invalid_slot" });
      return;
    }

    // Hapus slot lama (kalau pindah)
    for (const s in slots) {
      if (slots[s]?.id === user.id) {
        delete slots[s];
        io.emit("user_left_voice", { slot: Number(s) });
      }
    }

    // Set slot baru
    slots[slot] = {
      ...user,
      authUserId,
      mic: user.mic || "on",
      webcam: user.webcam || "off",
      slot,
      socketId: socket.id,
      speaking: false,
    };

    io.emit("user_joined_voice", { slot, user: slots[slot] });

    // Kirim peer list ke user baru
    const peers = Object.keys(slots)
      .filter((s) => slots[s].socketId !== socket.id)
      .map((s) => ({
        slot: Number(s),
        socketId: slots[s].socketId,
      }));

    io.to(socket.id).emit("existing_peers", peers);

    console.log("User joined slot:", slot, slots[slot]);
  });

  // --------------------------------------------------
  //  Leave Voice
  // --------------------------------------------------
  socket.on("leave_voice", ({ slot, userId }) => {
    if (slots[slot]?.id === userId) {
      delete slots[slot];
      io.emit("user_left_voice", { slot });
    }
  });

  // --------------------------------------------------
  //  Toggle Mic
  // --------------------------------------------------
  socket.on("toggle_mic", ({ slot, userId, status }) => {
    if (slots[slot]?.id === userId) {
      slots[slot].mic = status;
      io.emit("mic_status_changed", { slot, status });
    }
  });

  // --------------------------------------------------
  //  Toggle Webcam
  // --------------------------------------------------
  socket.on("toggle_webcam", ({ slot, userId, status }) => {
    if (slots[slot]?.id === userId) {
      slots[slot].webcam = status;
      io.emit("webcam_status_changed", { slot, status });
    }
  });

  // --------------------------------------------------
  //  Speaking Indicator
  // --------------------------------------------------
  socket.on("user_speaking", ({ userId, speaking }) => {
    for (const s in slots) {
      if (slots[s]?.id === userId) slots[s].speaking = speaking;
    }
    socket.broadcast.emit("user_speaking", { userId, speaking });
  });

  // --------------------------------------------------
  //  Text Chat
  // --------------------------------------------------
  socket.on("user_chat", ({ userId, message }) => {
    io.emit("user_chat", { userId, message });
  });

  // --------------------------------------------------
  //  Kick User
  // --------------------------------------------------
  socket.on("kick_user", ({ userId }) => {
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

    if (kickedSocketId) io.to(kickedSocketId).emit("kicked");
  });

  // --------------------------------------------------
  //  WebRTC Signaling
  // --------------------------------------------------
  socket.on("webrtc-offer", ({ toSocketId, fromSocketId, sdp }) => {
    if (toSocketId) io.to(toSocketId).emit("webrtc-offer", { fromSocketId, sdp });
  });

  socket.on("webrtc-answer", ({ toSocketId, fromSocketId, sdp }) => {
    if (toSocketId) io.to(toSocketId).emit("webrtc-answer", { fromSocketId, sdp });
  });

  socket.on("webrtc-ice", ({ toSocketId, candidate, fromSocketId }) => {
    if (toSocketId) io.to(toSocketId).emit("webrtc-ice", { fromSocketId, candidate });
  });

  // --------------------------------------------------
  //  Disconnect Cleanup
  // --------------------------------------------------
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
