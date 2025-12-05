// app.js (final)
document.addEventListener("deviceready", () => {
  console.log("Cordova Ready!");

  const voiceGrid = document.getElementById("voiceGrid");
  const statusBar = document.getElementById("statusBar");
  const chatInput = document.getElementById("chatInput");

  const SIGNALING_URL = "https://m3h048qq-3000.asse.devtunnels.ms";

  const socket = io(SIGNALING_URL, {
    transports: ["polling"],
    upgrade: false,
    forceNew: true,
  });

  const myUser = {
    id: "u" + Math.floor(Math.random() * 999999),
    name: "User " + Math.floor(Math.random() * 99),
    avatar: "https://api.dicebear.com/7.x/bottts/svg?seed=" + Math.random(),
    mic: "on",
  };

  let mySlot = null;
  const NUM_SLOTS = 8;
  const peers = {};
  let localStream = null;

  // STUN + TURN (TURN: metered public relay)
  const RTC_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: ["turn:global.relay.metered.ca:80"], username: "openai", credential: "openai" },
      { urls: ["turn:global.relay.metered.ca:443"], username: "openai", credential: "openai" },
      { urls: ["turn:global.relay.metered.ca:443?transport=tcp"], username: "openai", credential: "openai" },
    ],
  };

  /* ===========================
      Create slots (UI)
     =========================== */
  for (let i = 1; i <= NUM_SLOTS; i++) {
    const div = document.createElement("div");
    div.className = "voice-slot";
    div.id = "slot" + i;

    div.innerHTML = `
      <div class="kick-btn" id="kick-${i}">x</div>
      <div class="mic-btn" id="mic-${i}">🎤</div>
      <div class="circle empty"></div>
    `;

    div.addEventListener("click", () => handleSlotClick(i));
    voiceGrid.appendChild(div);
  }

  /* ===========================
      AUDIO ELEMENT CREATION (autoplay unlock)
     =========================== */
  function createRemoteAudioElement(peerSocketId, slot) {
    const circle = document.querySelector(`#slot${slot} .circle`);
    if (!circle) return null;

    let audio = circle.querySelector(`audio[data-peer="${peerSocketId}"]`);
    if (!audio) {
      audio = document.createElement("audio");
      audio.setAttribute("data-peer", peerSocketId);
      audio.autoplay = true;
      audio.playsInline = true;
      audio.muted = false;
      audio.volume = 1.0;
      audio.style.display = "none";
      circle.appendChild(audio);

      // Unlock autoplay on first user interaction
      const unlock = () => {
        audio.play().catch(() => { /* ignore */ });
        document.body.removeEventListener("click", unlock);
        document.body.removeEventListener("touchstart", unlock);
      };
      document.body.addEventListener("click", unlock, { once: true });
      document.body.addEventListener("touchstart", unlock, { once: true });
    }
    return audio;
  }

  async function startLocalStream() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      return s;
    } catch (err) {
      alert("Tidak bisa mengakses microphone.");
      throw err;
    }
  }

  /* ===========================
      MIC VISUALIZER
     =========================== */
  function startMicVisualizer(stream) {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;

    source.connect(analyser);
    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    let lastSpeaking = false;

    function loop() {
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      const speaking = avg > 10;

      if (mySlot) {
        const myCircle = document.querySelector(`#slot${mySlot} .circle`);
        if (myCircle) {
          myCircle.style.boxShadow = speaking ? "0 0 20px rgba(0,255,100,0.9)" : "none";
        }
      }

      if (speaking !== lastSpeaking) {
        lastSpeaking = speaking;
        socket.emit("user_speaking", { userId: myUser.id, speaking });
      }

      requestAnimationFrame(loop);
    }
    loop();
  }

  /* ===========================
      Peer connection
     =========================== */
  function createPeerConnection(peerSocketId, remoteSlot, localStream) {
    if (peers[peerSocketId]) return peers[peerSocketId].pc;

    const pc = new RTCPeerConnection(RTC_CONFIG);

    // debug logs
    pc.onconnectionstatechange = () => console.debug("PC state", peerSocketId, pc.connectionState);
    pc.oniceconnectionstatechange = () => console.debug("ICE state", peerSocketId, pc.iceConnectionState);

    if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

    const audioEl = createRemoteAudioElement(peerSocketId, remoteSlot);

    pc.ontrack = (evt) => {
      console.debug("ontrack from", peerSocketId, evt.streams);
      const [stream] = evt.streams;
      if (audioEl) {
        audioEl.srcObject = stream;
        // try to play (some browsers require user gesture; we attempted to unlock earlier)
        audioEl.play().catch(() => {});
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        // helpful debug to check for relay candidates
        try {
          if ((event.candidate.candidate || "").includes("typ relay")) console.debug("Emitting relay candidate for", peerSocketId);
        } catch (e) {}
        socket.emit("webrtc-ice", { toSocketId: peerSocketId, fromSocketId: socket.id, candidate: event.candidate });
      }
    };

    peers[peerSocketId] = { pc, audioEl, slot: remoteSlot };
    return pc;
  }

  /* ===========================
      SOCKET EVENTS (signaling + room)
     =========================== */
  socket.on("connect", () => {
    statusBar.innerText = "Connected";
    socket.emit("identify", myUser);
    socket.emit("get_room_state");
  });

  socket.on("room_state", ({ slots }) => {
    lastSlots = slots || {};
    updateAllSlots(slots);
  });

  socket.on("user_joined_voice", ({ slot, user }) => {
    lastSlots[slot] = user;
    updateSlotUI(slot, user);
  });

  socket.on("user_left_voice", ({ slot }) => {
    delete lastSlots[slot];
    clearSlotUI(slot);
  });

  socket.on("user_speaking", ({ userId, speaking }) => {
    const slotKey = Object.keys(lastSlots).find((s) => lastSlots[s]?.id === userId);
    if (!slotKey) return;
    const circle = document.querySelector(`#slot${slotKey} .circle`);
    if (circle) circle.style.boxShadow = speaking ? "0 0 30px rgba(0,255,150,0.9)" : "none";
  });

  socket.on("mic_status_changed", ({ slot, status }) => {
    const micBtn = document.getElementById(`mic-${slot}`);
    if (micBtn) micBtn.innerText = status === "on" ? "🎤" : "🔇";
  });

  // defensive update_slots handler (server might emit for some reason)
  socket.on("update_slots", (newSlots) => {
    console.log("update_slots received", newSlots);
    lastSlots = newSlots || {};
    updateAllSlots(lastSlots);
    const stillHere = Object.values(lastSlots).some((u) => u && u.id === myUser.id);
    if (!stillHere) {
      localCleanupAfterKick();
      socket.emit("get_room_state");
    }
  });

  socket.on("user_chat", ({ userId, message }) => {
    const slotKey = Object.keys(lastSlots).find((s) => lastSlots[s]?.id === userId);
    if (!slotKey) return;
    showFloatingText(slotKey, message);
  });

  if (chatInput) {
    chatInput.addEventListener("keyup", () => {
      if (!mySlot) return;
      const text = chatInput.value;
      showFloatingText(mySlot, text);
      socket.emit("user_chat", { userId: myUser.id, message: text });
    });
  }

  socket.on("existing_peers", async (existing) => {
    if (!localStream) localStream = await startLocalStream();
    for (const p of existing) {
      const pc = createPeerConnection(p.socketId, p.slot, localStream);
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("webrtc-offer", { toSocketId: p.socketId, fromSocketId: socket.id, sdp: pc.localDescription });
      } catch (err) {
        console.warn("offer failed", err);
      }
    }
  });

  socket.on("webrtc-offer", async ({ fromSocketId, sdp }) => {
    const remoteSlot = findSlotBySocketId(fromSocketId);
    if (!localStream) localStream = await startLocalStream();
    const pc = createPeerConnection(fromSocketId, remoteSlot, localStream);
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("webrtc-answer", { toSocketId: fromSocketId, fromSocketId: socket.id, sdp: pc.localDescription });
    } catch (err) {
      console.warn("handle offer failed", err);
    }
  });

  socket.on("webrtc-answer", async ({ fromSocketId, sdp }) => {
    const entry = peers[fromSocketId];
    if (!entry) return;
    try {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    } catch (err) {
      console.warn("setRemoteDescription(answer) failed", err);
    }
  });

  socket.on("webrtc-ice", async ({ fromSocketId, candidate }) => {
    const entry = peers[fromSocketId];
    if (!entry) return;
    try {
      await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn("addIceCandidate failed", err);
    }
  });

  /* ===========================
      UI / state helpers
     =========================== */
  let lastSlots = {};

  function findSlotBySocketId(socketId) {
    const key = Object.keys(lastSlots).find((s) => lastSlots[s]?.socketId === socketId);
    return key ? Number(key) : null;
  }

  function updateAllSlots(slots) {
    for (let i = 1; i <= NUM_SLOTS; i++) clearSlotUI(i);
    for (const s in slots) updateSlotUI(s, slots[s]);
  }

  function updateSlotUI(slot, user) {
    const circle = document.querySelector(`#slot${slot} .circle`);
    const kickBtn = document.getElementById(`kick-${slot}`);
    const micBtn = document.getElementById(`mic-${slot}`);

    circle.classList.remove("empty");
    circle.style.backgroundImage = `url('${user.avatar}')`;

    // kick button only visible for other users
    kickBtn.style.display = user.id !== myUser.id ? "flex" : "none";
    if (user.id !== myUser.id) {
      kickBtn.onclick = (e) => {
        e.stopPropagation();
        socket.emit("kick_user", { userId: user.id });
      };
    }

    micBtn.style.display = user.id === myUser.id ? "flex" : "none";
    micBtn.innerText = user.mic === "on" ? "🎤" : "🔇";
    micBtn.onclick = (e) => {
      e.stopPropagation();
      toggleMyMic();
    };

    let label = circle.parentNode.querySelector(".slot-name");
    if (!label) {
      label = document.createElement("div");
      label.className = "slot-name";
      circle.parentNode.appendChild(label);
    }
    label.innerText = user.name;
  }

  function clearSlotUI(slot) {
    const circle = document.querySelector(`#slot${slot} .circle`);
    const kickBtn = document.getElementById(`kick-${slot}`);
    const micBtn = document.getElementById(`mic-${slot}`);

    circle.classList.add("empty");
    circle.style.backgroundImage = "none";
    circle.style.boxShadow = "none";

    kickBtn.style.display = "none";
    micBtn.style.display = "none";

    const label = circle.parentNode.querySelector(".slot-name");
    if (label) label.remove();
  }

  /* ===========================
      Mic toggle
     =========================== */
  function toggleMyMic() {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    track.enabled = !track.enabled;
    myUser.mic = track.enabled ? "on" : "off";
    socket.emit("toggle_mic", { slot: mySlot, userId: myUser.id });
  }

  /* ===========================
      Slot click (join/move)
     =========================== */
  async function handleSlotClick(slot) {
    if (!mySlot) {
      try {
        localStream = await startLocalStream();
        startMicVisualizer(localStream);
      } catch (e) {
        return;
      }

      socket.emit("join_voice", { slot, user: { ...myUser, socketId: socket.id } });
      mySlot = slot;
      return;
    }

    if (mySlot === slot) return;

    socket.emit("leave_voice", { slot: mySlot, userId: myUser.id });
    socket.emit("join_voice", { slot, user: { ...myUser, socketId: socket.id } });
    mySlot = slot;
  }

  /* ===========================
      Floating chat bubble
     =========================== */
  function showFloatingText(slot, text) {
    const slotDiv = document.getElementById(`slot${slot}`);
    if (!slotDiv) return;
    let bubble = slotDiv.querySelector(".floating-text");
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.className = "floating-text";
      slotDiv.appendChild(bubble);
    }
    bubble.innerText = text;
    if (!text) {
      bubble.classList.add("fade-out");
      setTimeout(() => bubble.remove(), 300);
      return;
    }
    bubble.classList.remove("fade-out");
    if (bubble.timeoutId) clearTimeout(bubble.timeoutId);
    bubble.timeoutId = setTimeout(() => {
      bubble.classList.add("fade-out");
      setTimeout(() => bubble.remove(), 350);
    }, 4000);
  }

  /* ===========================
      Kick handling: client side
     =========================== */
  socket.on("kicked", () => {
    // only target receives this event
    alert("Anda telah dikeluarkan dari room.");
    // local cleanup and request authoritative state
    localCleanupAfterKick();
    socket.emit("get_room_state");
  });

  function localCleanupAfterKick() {
    // remove my slot in UI
    if (mySlot) {
      clearSlotUI(mySlot);
      mySlot = null;
    }
    // close all peer connections
    for (const p in peers) {
      try { peers[p].pc.close(); } catch (e) {}
      delete peers[p];
    }
    // stop local stream
    if (localStream) {
      try { localStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      localStream = null;
    }
  }

  /* ===========================
      Cleanup on unload
     =========================== */
  window.addEventListener("beforeunload", () => {
    if (mySlot) socket.emit("leave_voice", { slot: mySlot, userId: myUser.id });
    try { socket.close(); } catch (e) {}
  });
});
