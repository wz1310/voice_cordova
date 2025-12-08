// app.js (final updated)
document.addEventListener("deviceready", () => {
  console.log("Cordova Ready!");
  let isMuted = false;
  let screenStream = null;

  const voiceGrid = document.getElementById("voiceGrid");
  const statusBar = document.getElementById("statusBar");
  const chatInput = document.getElementById("chatInput");
  const btnScreenShare = document.getElementById("btnScreenShare");

  const SIGNALING_URL = "https://m3h048qq-4000.asse.devtunnels.ms";

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

  let RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  function removeScreenShare(peerSocketId) {
    const container = document.getElementById("screenShareContainer");
    const video = container.querySelector(`video[data-peer="${peerSocketId}"]`);
    if (video) {
      video.srcObject = null;
      video.remove();
    }
    if (container.children.length === 0) {
      container.style.display = "none";
    }
  }

  /* ===========================
       Screen Share
     =========================== */
  btnScreenShare.addEventListener("click", async () => {
    const screenContainer = document.getElementById("screenShareContainer");

    if (!mySlot) {
      alert("Join slot dulu sebelum share screen!");
      return;
    }

    if (screenStream) {
      await stopScreenShare();
      return;
    }

    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      screenContainer.style.display = "flex";

      for (const peerId in peers) {
        const pc = peers[peerId].pc;
        screenStream
          .getTracks()
          .forEach((track) => pc.addTrack(track, screenStream));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("webrtc-offer", {
          toSocketId: peerId,
          fromSocketId: socket.id,
          sdp: pc.localDescription,
        });
      }

      btnScreenShare.style.background = "#0f0";

      screenStream.getVideoTracks()[0].onended = async () => {
        await stopScreenShare();
      };

      console.log("Screen sharing started");
    } catch (err) {
      console.warn("Screen share gagal", err);
    }
  });

  async function stopScreenShare() {
    if (!screenStream) return;

    // Broadcast ke semua peer bahwa screen share dihentikan
    for (const peerId in peers) {
      socket.emit("stop_screen_share", {
        toSocketId: peerId,
        fromSocketId: socket.id,
      });

      const pc = peers[peerId].pc;
      pc.getSenders().forEach((sender) => {
        if (screenStream.getTracks().includes(sender.track)) {
          pc.removeTrack(sender);
        }
      });
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("webrtc-offer", {
        toSocketId: peerId,
        fromSocketId: socket.id,
        sdp: pc.localDescription,
      });
    }

    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
    btnScreenShare.style.background = "";

    const screenContainer = document.getElementById("screenShareContainer");
    screenContainer.style.display = "none";
  }

  /* ===========================
       Fetch Twilio ICE
     =========================== */
  async function getTwilioIce() {
    try {
      const base = SIGNALING_URL.replace(/\/$/, "");
      const resp = await fetch(base + "/turn-token", { method: "GET" });
      if (!resp.ok)
        throw new Error("turn-token request failed: " + resp.status);
      const data = await resp.json();
      const iceArr = data.ice_servers || data.iceServers || [];
      if (!Array.isArray(iceArr) || iceArr.length === 0)
        return RTC_CONFIG.iceServers;
      return iceArr.map((s) => {
        const entry = {};
        if (s.urls) entry.urls = s.urls;
        else if (s.url) entry.urls = s.url;
        else if (s.servers) entry.urls = s.servers;
        if (s.username) entry.username = s.username;
        if (s.credential) entry.credential = s.credential;
        if (s.password && !entry.credential) entry.credential = s.password;
        return entry;
      });
    } catch (err) {
      console.warn("getTwilioIce failed:", err);
      return RTC_CONFIG.iceServers;
    }
  }

  /* ===========================
       Create slots UI
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
       Audio Element
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
      audio.muted = isMuted;
      audio.style.display = "none";
      circle.appendChild(audio);
      const unlock = () => {
        audio.play().catch(() => {});
      };
      document.body.addEventListener("click", unlock, { once: true });
      document.body.addEventListener("touchstart", unlock, { once: true });
    }
    return audio;
  }

  async function startLocalStream() {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      alert("Tidak bisa mengakses microphone.");
      throw err;
    }
  }

  /* ===========================
       Mic Visualizer
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
        if (myCircle)
          myCircle.style.boxShadow = speaking
            ? "0 0 20px rgba(0,255,100,0.9)"
            : "none";
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
       Peer Connection
     =========================== */
  function createPeerConnection(peerSocketId, remoteSlot, localStream) {
    if (peers[peerSocketId]) return peers[peerSocketId].pc;
    const pc = new RTCPeerConnection(RTC_CONFIG);

    if (localStream)
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    const audioEl = createRemoteAudioElement(peerSocketId, remoteSlot);

    pc.ontrack = (evt) => {
      const [stream] = evt.streams;
      const trackKind = evt.track.kind;

      if (trackKind === "video") {
        const container = document.getElementById("screenShareContainer");
        container.style.display = "flex";

        let video = container.querySelector(
          `video[data-peer="${peerSocketId}"]`
        );
        if (!video) {
          video = document.createElement("video");
          video.setAttribute("data-peer", peerSocketId);
          video.autoplay = true;
          video.playsInline = true;
          video.muted = false;
          container.appendChild(video);
        }
        video.srcObject = stream;
        video.play().catch(() => {});
      } else if (trackKind === "audio") {
        const audioEl = createRemoteAudioElement(peerSocketId, remoteSlot);
        if (audioEl) {
          audioEl.srcObject = stream;
          if (!isMuted) audioEl.play().catch(() => {});
        }
      }
    };

    pc.onconnectionstatechange = () =>
      console.debug("PC state", peerSocketId, pc.connectionState);
    pc.oniceconnectionstatechange = () =>
      console.debug("ICE state", peerSocketId, pc.iceConnectionState);

    pc.onicecandidate = (event) => {
      if (event.candidate)
        socket.emit("webrtc-ice", {
          toSocketId: peerSocketId,
          fromSocketId: socket.id,
          candidate: event.candidate,
        });
    };

    peers[peerSocketId] = { pc, audioEl, slot: remoteSlot };
    return pc;
  }

  /* ===========================
      SOCKET EVENTS (signaling + room)
     =========================== */
  socket.on("connect", async () => {
    statusBar.innerText = "Connected";

    // ambil ICE TURN Twilio (dari server `/turn-token`)
    try {
      const iceServers = await getTwilioIce();
      if (Array.isArray(iceServers) && iceServers.length > 0) {
        RTC_CONFIG.iceServers = iceServers;
        console.log("RTC_CONFIG updated with Twilio ICE servers");
      } else {
        console.warn("Twilio returned empty ice servers, using defaults");
      }
    } catch (err) {
      console.warn("Failed to get Twilio ICE, using default RTC_CONFIG", err);
    }

    console.log("Final RTC CONFIG:", RTC_CONFIG);

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

  socket.on("stop_screen_share", ({ fromSocketId }) => {
    const container = document.getElementById("screenShareContainer");
    const video = container.querySelector(`video[data-peer="${fromSocketId}"]`);
    if (video) {
      video.srcObject = null;
      video.remove();
    }

    // Jika container kosong, sembunyikan
    if (container.children.length === 0) {
      container.style.display = "none";
    }
  });

  socket.on("user_left_voice", ({ slot }) => {
    const user = lastSlots[slot];
    if (user?.socketId) {
      // hapus video screen share yang mungkin tersisa
      const container = document.getElementById("screenShareContainer");
      const video = container.querySelector(
        `video[data-peer="${user.socketId}"]`
      );
      if (video) video.remove();
      if (container.children.length === 0) container.style.display = "none";
    }
    delete lastSlots[slot];
    clearSlotUI(slot);
  });

  socket.on("user_speaking", ({ userId, speaking }) => {
    const slotKey = Object.keys(lastSlots).find(
      (s) => lastSlots[s]?.id === userId
    );
    if (!slotKey) return;
    const circle = document.querySelector(`#slot${slotKey} .circle`);
    if (circle)
      circle.style.boxShadow = speaking
        ? "0 0 30px rgba(0,255,150,0.9)"
        : "none";
  });

  socket.on("mic_status_changed", ({ slot, status }) => {
    const micBtn = document.getElementById(`mic-${slot}`);
    if (micBtn) {
      micBtn.textContent = status === "on" ? "🎤" : "🔇";
      micBtn.style.opacity = "1.0"; // tampil jelas
    }
  });

  socket.on("update_slots", (newSlots) => {
    console.log("update_slots received", newSlots);
    lastSlots = newSlots || {};
    updateAllSlots(lastSlots);
    const stillHere = Object.values(lastSlots).some(
      (u) => u && u.id === myUser.id
    );
    if (!stillHere) {
      localCleanupAfterKick();
      socket.emit("get_room_state");
    }
  });

  socket.on("user_chat", ({ userId, message }) => {
    const slotKey = Object.keys(lastSlots).find(
      (s) => lastSlots[s]?.id === userId
    );
    if (!slotKey) return;
    showFloatingText(slotKey, message);
  });

  if (chatInput) {
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!mySlot) return;
        const text = chatInput.value.trim();
        if (!text) return;
        socket.emit("user_chat", { userId: myUser.id, message: text });
        showFloatingText(mySlot, text);
        chatInput.value = "";
        chatInput.blur(); // close keyboard on mobile after send
      }
    });

    // prevent auto-focusing that steals view on mobile
    chatInput.addEventListener("focus", () => {
      // optional: scroll chat into view if needed, or do nothing to avoid auto-scroll
      // window.scrollTo(0, document.body.scrollHeight);
    });

    // optional: blur when touching outside
    document.addEventListener("touchstart", (ev) => {
      if (!chatInput) return;
      if (
        !ev.target.closest("#chatContainer") &&
        document.activeElement === chatInput
      ) {
        chatInput.blur();
      }
    });
  }

  socket.on("existing_peers", async (existing) => {
    if (!localStream) localStream = await startLocalStream();
    for (const p of existing) {
      const pc = createPeerConnection(p.socketId, p.slot, localStream);
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("webrtc-offer", {
          toSocketId: p.socketId,
          fromSocketId: socket.id,
          sdp: pc.localDescription,
        });
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
      socket.emit("webrtc-answer", {
        toSocketId: fromSocketId,
        fromSocketId: socket.id,
        sdp: pc.localDescription,
      });
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
    const key = Object.keys(lastSlots).find(
      (s) => lastSlots[s]?.socketId === socketId
    );
    return key ? Number(key) : null;
  }

  function updateAllSlots(slots) {
    for (let i = 1; i <= NUM_SLOTS; i++) {
      if (!slots[i]) {
        clearSlotUI(i);
      } else {
        updateSlotUI(i, slots[i]);
      }
    }
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

    micBtn.style.display = "flex";
    micBtn.innerText = user.mic === "on" ? "🎤" : "🔇";
    micBtn.onclick = (e) => {
      e.stopPropagation();

      // hanya bisa klik mic slot sendiri
      if (user.id === myUser.id) {
        toggleMyMic();
      }
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

    // 🔥 kirim status mic yang baru
    socket.emit("toggle_mic", {
      slot: mySlot,
      userId: myUser.id, // <--- WAJIB DITAMBAHKAN
      status: myUser.mic,
    });

    // update tampilan mic saya sendiri
    const myMicBtn = document.getElementById(`mic-${mySlot}`);
    if (myMicBtn) myMicBtn.innerText = myUser.mic === "on" ? "🎤" : "🔇";
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

      socket.emit("join_voice", {
        slot,
        user: { ...myUser, socketId: socket.id },
      });
      mySlot = slot;
      return;
    }

    if (mySlot === slot) return;

    socket.emit("leave_voice", { slot: mySlot, userId: myUser.id });
    socket.emit("join_voice", {
      slot,
      user: { ...myUser, socketId: socket.id },
    });
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
    if (text === null || text === undefined) {
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

  // Toggle Volume On / Silent
  const btnVolOn = document.getElementById("volumeon");
  const btnSilent = document.getElementById("silent");

  // ============================
  // FUNGSI MUTE / UNMUTE SUARA
  // ============================

  function muteAllUsers() {
    const audios = document.querySelectorAll("audio");
    audios.forEach((a) => (a.muted = true));
  }

  function unmuteAllUsers() {
    const audios = document.querySelectorAll("audio");
    audios.forEach((a) => (a.muted = false));
  }

  btnVolOn.addEventListener("click", () => {
    btnVolOn.style.display = "none";
    btnSilent.style.display = "flex";

    isMuted = true; // <-- aktifkan mute global
    muteAllUsers();
  });

  btnSilent.addEventListener("click", () => {
    btnSilent.style.display = "none";
    btnVolOn.style.display = "flex";

    isMuted = false; // <-- nonaktifkan mute global
    unmuteAllUsers();
  });

  /* ===========================
      Kick handling: client side
     =========================== */
  socket.on("kicked", () => {
    alert("Anda telah dikeluarkan dari room.");
    localCleanupAfterKick();
    socket.emit("get_room_state");
  });

  function localCleanupAfterKick() {
    if (mySlot) {
      clearSlotUI(mySlot);
      mySlot = null;
    }
    for (const p in peers) {
      try {
        peers[p].pc.close();
      } catch (e) {}
      delete peers[p];
    }
    if (localStream) {
      try {
        localStream.getTracks().forEach((t) => t.stop());
      } catch (e) {}
      localStream = null;
    }
  }

  document.getElementById("btnKeluar").onclick = () => {
    if (mySlot) socket.emit("leave_voice", { slot: mySlot, userId: myUser.id });
    try {
      socket.close();
    } catch (e) {}
    localCleanupAfterKick();
    location.reload();
  };

  window.addEventListener("beforeunload", () => {
    if (mySlot) socket.emit("leave_voice", { slot: mySlot, userId: myUser.id });
    try {
      socket.close();
    } catch (e) {}
  });
});
