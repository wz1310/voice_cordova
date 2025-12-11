// ==================================================
//  Imports & Setup
// ==================================================
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const twilio = require("twilio");
const fs = require("fs"); // <-- BARU: Import filesystem
const path = require("path"); // <-- BARU: Import path

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
    console.error("Twilio Error:", err.message || err);
    res.status(500).json({
      error: "twilio_failed",
      message: err.message || String(err),
    });
  }
});

// ==================================================
//  Load User Data <-- BARU
// ==================================================
let registeredUsers = [];
try {
  const dataPath = path.join(__dirname, "data", "data.json");
  const data = fs.readFileSync(dataPath, "utf-8");
  registeredUsers = JSON.parse(data);
  console.log(`Loaded ${registeredUsers.length} registered users.`);
} catch (err) {
  console.error("Error loading data.json:", err.message);
}
// ==================================================

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
  socket.on("start_screen_share_signal", ({ fromSocketId, toSocketId }) => {
    if (toSocketId) {
      // Jika ada toSocketId (peer baru), kirim HANYA ke peer itu
      io.to(toSocketId).emit("start_screen_share_signal", {
        fromSocketId: fromSocketId,
      });
      console.log(
        `[SIGNAL] Screen share signal sent by ${fromSocketId} to NEW PEER: ${toSocketId}`
      );
    } else {
      // Jika tidak ada toSocketId (peer lama saat memulai share), kirim broadcast
      socket.broadcast.emit("start_screen_share_signal", {
        fromSocketId: fromSocketId,
      });
      console.log(
        `[SIGNAL] Screen share signal sent by ${fromSocketId} to ALL OTHERS.`
      );
    }
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
  //  User Login Validation <-- BARU
  // ----------------------------
  socket.on("validate_login", ({ username, password }) => {
    const userMatch = registeredUsers.find(
      (u) => u.username === username && u.password === password
    );

    if (userMatch) {
      // Login berhasil, kirim data user yang valid kembali ke client
      socket.emit("login_success", {
        isValid: true,
        name: userMatch.name,
        userId: userMatch.id, // <-- PENTING: Kirim ID dari data.json
        // Anda bisa menambahkan ID unik di sini, atau biarkan client yang membuatnya
      });
    } else {
      // Login gagal
      socket.emit("login_failure", {
        isValid: false,
        message: "Invalid username or password.",
      });
    }
  });

  // ----------------------------
  //  Join Voice Slot
  // ----------------------------
  socket.on("join_voice", ({ slot, user, authUserId }) => {
    // 1. Pengecekan Duplikasi ID (Hanya boleh 1 sesi per ID)
    const existingSlot = Object.values(slots).find(
      (s) => s.authUserId === authUserId
    );

    if (existingSlot && existingSlot.slot !== slot) {
      // ID sudah duduk di slot lain
      socket.emit("join_failed", { slot, reason: "duplicate_id" });
      return;
    }

    // 2. Cek apakah slot sudah terisi oleh ID lain
    if (slots[slot] && slots[slot].authUserId !== authUserId) {
      socket.emit("join_failed", { slot, reason: "occupied" });
      return;
    }

    // 3. Verifikasi final dan ambil data user (opsional, karena sudah diverifikasi saat login)
    const userMatch = registeredUsers.find((u) => u.id === authUserId);

    if (!userMatch) {
      socket.emit("join_failed", { slot, reason: "unauthorized" });
      return;
    }

    // Pastikan nama pengguna dari server digunakan
    user.name = userMatch.name;
    user.id = authUserId; // <-- Pastikan myUser.id diset ke ID dari server

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
      authUserId: authUserId, // <-- PENTING: Simpan ID autentikasi di slot
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
