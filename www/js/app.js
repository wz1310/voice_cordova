document.addEventListener("deviceready", () => {
  console.log("Cordova Ready!");

  // -------------------------
  // Constants & State
  // -------------------------
  const NUM_SLOTS = 8;
  const SIGNALING_URL = "https://m3h048qq-4000.asse.devtunnels.ms";
  let RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

  let isMuted = false;
  let screenStream = null;
  let webcamStream = null;
  let localStream = null;

  let mySlot = null;
  let pendingSlot = null;

  let authUserId = null; // Simpan ID yang berhasil login

  const peers = {}; // { [socketId]: { pc, audioEl, slot, isSharingScreen } }
  let lastSlots = {}; // server-side slot state

  // -------------------------
  // DOM Elements
  // -------------------------
  const voiceGrid = document.getElementById("voiceGrid");
  const statusBar = document.getElementById("statusBar");
  const chatInput = document.getElementById("chatInput");
  const btnScreenShare = document.getElementById("btnScreenShare");
  const btnWebcam = document.getElementById("btnWebcam");
  const btnVolOn = document.getElementById("volumeon");
  const btnSilent = document.getElementById("silent");

  // BARU
  const btnMenu = document.getElementById("btnMenu");
  const sideMenu = document.getElementById("sideMenu");
  const menuOverlay = sideMenu ? sideMenu.querySelector(".menu-overlay") : null;

  // BARU: Login Elements (Dipindahkan ke Side Menu)
  const loginForm = document.getElementById("loginForm");
  const loginUsernameInput = document.getElementById("loginUsername");
  const loginPasswordInput = document.getElementById("loginPassword");
  const btnLoginSubmit = document.getElementById("btnLoginSubmit");
  const loginMessage = document.getElementById("loginMessage");

  // BARU UNTUK HELLO USER
  const userGreeting = document.getElementById("userGreeting"); // <-- TAMBAHKAN INI

  // State untuk form login
  let loginPromiseResolve = null;
  let isLoggingIn = false; // Status untuk mencegah klik ganda
  // ...

  // -------------------------
  // Local user
  // -------------------------
  const myUser = {
    id: "u" + Math.floor(Math.random() * 999999),
    name: "Tamu",
    avatar: "https://api.dicebear.com/7.x/bottts/svg?seed=" + Math.random(),
    mic: "on",
    webcam: "off",
  };

  // -------------------------
  // Utilities
  // -------------------------
  function addManualCloseButton(container) {
    if (container.querySelector(".manual-close-btn")) return;

    const btn = document.createElement("button");
    btn.innerText = "✖";
    btn.className = "manual-close-btn";

    Object.assign(btn.style, {
      position: "absolute",
      top: "5px",
      left: "5px",
      zIndex: "1000",
      background: "rgba(0,0,0,0.3)",
      color: "#fff",
      border: "none",
      borderRadius: "4px",
      padding: "4px 6px",
      cursor: "pointer",
    });

    btn.onclick = () => {
      const vids = container.querySelectorAll("video");
      vids.forEach((v) => {
        v.srcObject = null;
        v.remove();
      });

      container.style.display = "none";

      if (screenStream) {
        screenStream.getTracks().forEach((t) => t.stop());
        screenStream = null;
        if (btnScreenShare) btnScreenShare.style.background = "";
      }
    };

    container.style.position = "relative";
    container.appendChild(btn);
  }

  function createRemoteAudioElement(peerSocketId, slot) {
    const circle = document.querySelector(`#slot${slot} .circle`);
    if (!circle) return null;

    let audio = circle.querySelector(`audio[data-peer="${peerSocketId}"]`);
    if (!audio) {
      audio = document.createElement("audio");
      audio.dataset.peer = peerSocketId;
      audio.autoplay = true;
      audio.playsInline = true;
      audio.muted = isMuted;
      audio.style.display = "none";
      circle.appendChild(audio);

      const unlock = () => audio.play().catch(() => {});
      document.body.addEventListener("click", unlock, { once: true });
      document.body.addEventListener("touchstart", unlock, { once: true });
    }

    return audio;
  }

  async function startLocalStream() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      const t = s.getAudioTracks()[0];
      if (t) t.enabled = myUser.mic === "on";
      return s;
    } catch (err) {
      alert("Tidak bisa mengakses microphone.");
      throw err;
    }
  }

  function findSlotBySocketId(socketId) {
    const key = Object.keys(lastSlots).find(
      (s) => lastSlots[s]?.socketId === socketId
    );
    return key ? Number(key) : null;
  }
  // BARU: Utility untuk mencari slot kosong
  function findFirstAvailableSlot() {
    for (let i = 1; i <= NUM_SLOTS; i++) {
      if (!lastSlots[i]) {
        return i;
      }
    }
    return null;
  }

  // -------------------------
  // Webcam handlers
  // -------------------------
  async function startWebcamStream() {
    if (!mySlot) return alert("Join slot dulu sebelum mengaktifkan kamera!");

    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      webcamStream = s;
      if (btnWebcam) btnWebcam.style.background = "#0f0";

      // tampilkan video lokal di slot sendiri
      updateVideoElement(mySlot, socket.id, webcamStream, true);

      // kirim track video ke semua peer
      for (const peerId in peers) {
        const pc = peers[peerId].pc;
        webcamStream
          .getVideoTracks()
          .forEach((t) => pc.addTrack(t, webcamStream));

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        socket.emit("webrtc-offer", {
          toSocketId: peerId,
          fromSocketId: socket.id,
          sdp: pc.localDescription,
        });
      }

      myUser.webcam = "on";
      socket.emit("toggle_webcam", {
        slot: mySlot,
        userId: myUser.id,
        status: myUser.webcam,
      });
    } catch (err) {
      console.warn("Webcam gagal", err);
      alert("Tidak bisa mengakses kamera.");
      if (btnWebcam) btnWebcam.style.background = "";
      webcamStream = null;
      myUser.webcam = "off";
    }
  }

  async function stopWebcamStream() {
    if (!webcamStream) return;

    // hapus video lokal
    updateVideoElement(mySlot, socket.id, null, true);

    // hentikan track
    webcamStream.getTracks().forEach((t) => t.stop());
    webcamStream = null;
    if (btnWebcam) btnWebcam.style.background = "";

    // hapus track dari peer connections
    for (const peerId in peers) {
      const pc = peers[peerId].pc;
      pc.getSenders().forEach((sender) => {
        if (sender.track?.kind === "video" && sender.track.label !== "screen") {
          try {
            pc.removeTrack(sender);
          } catch (e) {
            // some browsers may not support removeTrack for this sender
          }
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

    myUser.webcam = "off";
    socket.emit("toggle_webcam", {
      slot: mySlot,
      userId: myUser.id,
      status: myUser.webcam,
    });
  }

  function updateVideoElement(slot, peerSocketId, stream, isLocal = false) {
    const slotDiv = document.getElementById(`slot${slot}`);
    if (!slotDiv) return;

    let container = slotDiv.querySelector(".video-container");

    if (stream) {
      if (!container) {
        container = document.createElement("div");
        container.className = "video-container";
        slotDiv.insertBefore(container, slotDiv.querySelector(".circle"));
      }

      let video = container.querySelector(`video[data-peer="${peerSocketId}"]`);

      if (!video) {
        video = document.createElement("video");
        video.dataset.peer = peerSocketId;
        video.autoplay = true;
        video.playsInline = true;
        video.muted = isLocal;
        video.style.transform = isLocal ? "scaleX(-1)" : "none";
        container.appendChild(video);
      }

      video.srcObject = stream;
    } else if (container) {
      const video = container.querySelector(
        `video[data-peer="${peerSocketId}"]`
      );
      if (video) video.remove();

      if (!container.querySelector("video")) container.remove();
    }
  }

  // Webcam button listener
  if (btnWebcam)
    btnWebcam.addEventListener("click", async () => {
      if (screenStream) {
        alert("Matikan Screen Share dulu sebelum mengaktifkan kamera!");
        return;
      }
      if (!mySlot) return alert("Join slot dulu sebelum mengaktifkan kamera!");
      if (webcamStream) return stopWebcamStream();
      return startWebcamStream();
    });

  // -------------------------
  // Screen share
  // -------------------------
  if (btnScreenShare)
    btnScreenShare.addEventListener("click", async () => {
      const screenContainer = document.getElementById("screenShareContainer");

      if (webcamStream) {
        await stopWebcamStream();
      }

      if (!mySlot) return alert("Join slot dulu sebelum share screen!");
      if (screenStream) return await stopScreenShare();

      try {
        screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });

        socket.emit("start_screen_share_signal", { fromSocketId: socket.id });

        const videoEl = document.createElement("video");
        videoEl.id = "localScreenVideo";
        videoEl.autoplay = true;
        videoEl.playsInline = true;
        videoEl.muted = true;
        videoEl.style.width = "100%";
        videoEl.style.height = "100%";
        videoEl.style.objectFit = "contain";
        videoEl.srcObject = screenStream;

        screenContainer.innerHTML = "";
        screenContainer.appendChild(videoEl);
        addManualCloseButton(screenContainer);
        screenContainer.style.display = "flex";

        for (const peerId in peers) {
          const pc = peers[peerId].pc;
          screenStream.getTracks().forEach((t) => pc.addTrack(t, screenStream));

          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);

          socket.emit("webrtc-offer", {
            toSocketId: peerId,
            fromSocketId: socket.id,
            sdp: pc.localDescription,
          });
        }

        if (btnScreenShare) btnScreenShare.style.background = "#0f0";

        screenStream.getVideoTracks()[0].onended = async () => {
          await stopScreenShare();
        };
      } catch (err) {
        console.warn("Screen share gagal", err);
      }
    });

  async function stopScreenShare() {
    if (!screenStream) return;

    for (const peerId in peers) {
      const pc = peers[peerId].pc;

      socket.emit("stop_screen_share", {
        toSocketId: peerId,
        fromSocketId: socket.id,
      });

      pc.getSenders().forEach((sender) => {
        if (screenStream.getTracks().includes(sender.track)) {
          try {
            pc.removeTrack(sender);
          } catch (e) {
            // ignore
          }
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

    if (btnScreenShare) btnScreenShare.style.background = "";

    const screenContainer = document.getElementById("screenShareContainer");
    if (screenContainer) {
      screenContainer.innerHTML = "";
      screenContainer.style.display = "none";
    }
  }

  // -------------------------
  // Fetch TURN/ICE
  // -------------------------
  async function getTwilioIce() {
    try {
      const base = SIGNALING_URL.replace(/\/$/, "");
      const resp = await fetch(base + "/turn-token");

      if (!resp.ok) throw new Error(resp.status);
      const data = await resp.json();

      const iceArr = data.ice_servers || data.iceServers || [];
      if (!Array.isArray(iceArr) || iceArr.length === 0)
        return RTC_CONFIG.iceServers;

      return iceArr.map((s) => ({
        urls: s.urls || s.url || s.servers,
        username: s.username,
        credential: s.credential || s.password,
      }));
    } catch (err) {
      console.warn("getTwilioIce failed", err);
      return RTC_CONFIG.iceServers;
    }
  }

  // -------------------------
  // Build slot UI
  // -------------------------
  for (let i = 1; i <= NUM_SLOTS; i++) {
    const div = document.createElement("div");
    div.id = `slot${i}`;
    div.className = "voice-slot";
    div.innerHTML = `
      <div class="kick-btn" id="kick-${i}">x</div>
      <div class="mic-btn" id="mic-${i}">🎤</div>
      <div class="circle empty"></div>
    `;
    div.addEventListener("click", () => handleSlotClick(i));
    voiceGrid.appendChild(div);
  }

  // -------------------------
  // Mic visualizer
  // -------------------------
  function startMicVisualizer(stream) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);

    const data = new Uint8Array(analyser.frequencyBinCount);
    let lastSpeaking = false;

    function loop() {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
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

  // -------------------------
  // Peer connection
  // -------------------------
  function createPeerConnection(peerSocketId, remoteSlot, localStreamParam) {
    if (peers[peerSocketId]) return peers[peerSocketId].pc;

    const pc = new RTCPeerConnection(RTC_CONFIG);

    // tambahkan webcam jika aktif
    if (webcamStream)
      webcamStream.getTracks().forEach((t) => pc.addTrack(t, webcamStream));

    // tambahkan screen jika aktif
    if (screenStream) {
      screenStream.getTracks().forEach((t) => pc.addTrack(t, screenStream));
      socket.emit("start_screen_share_signal", {
        fromSocketId: socket.id,
        toSocketId: peerSocketId,
      });
    }

    // tambahkan audio lokal
    if (localStreamParam)
      localStreamParam
        .getTracks()
        .forEach((t) => pc.addTrack(t, localStreamParam));

    const audioEl = createRemoteAudioElement(peerSocketId, remoteSlot);

    pc.ontrack = (evt) => {
      const stream = evt.streams[0];
      const kind = evt.track.kind;
      const track = evt.track;

      console.log(
        `[ONTRACK] Peer: ${peerSocketId} Kind: ${kind} Label: ${track.label}`
      );

      if (kind === "video") {
        const container = document.getElementById("screenShareContainer");
        const isSharing =
          peers[peerSocketId] && peers[peerSocketId].isSharingScreen;
        const isScreenShare = track.label.includes("screen") || isSharing;

        if (isScreenShare) {
          container.style.display = "flex";

          let video = container.querySelector(
            `video[data-peer="${peerSocketId}"]`
          );
          if (!video) {
            video = document.createElement("video");
            video.dataset.peer = peerSocketId;
            video.autoplay = true;
            video.playsInline = true;
            container.appendChild(video);

            if (!container.querySelector(".fullscreen-btn")) {
              const btnFull = document.createElement("button");
              btnFull.innerText = "⛶";
              btnFull.className = "fullscreen-btn";

              Object.assign(btnFull.style, {
                position: "absolute",
                top: "5px",
                right: "5px",
                zIndex: "1000",
                background: "rgba(0,0,0,0.3)",
                color: "#fff",
                border: "none",
                borderRadius: "4px",
                padding: "4px 6px",
                cursor: "pointer",
              });

              btnFull.onclick = () =>
                !document.fullscreenElement
                  ? video.requestFullscreen().catch(() => {})
                  : document.exitFullscreen().catch(() => {});

              container.style.position = "relative";
              container.appendChild(btnFull);
              addManualCloseButton(container);
            }
          }

          video.srcObject = stream;

          // hapus video webcam dari slot
          updateVideoElement(remoteSlot, peerSocketId, null);
        } else {
          updateVideoElement(remoteSlot, peerSocketId, stream);
        }
      }

      if (kind === "audio") {
        const audio = createRemoteAudioElement(peerSocketId, remoteSlot);
        if (audio) {
          audio.srcObject = stream;
          if (!isMuted) audio.play().catch(() => {});
        }
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate)
        socket.emit("webrtc-ice", {
          toSocketId: peerSocketId,
          fromSocketId: socket.id,
          candidate: e.candidate,
        });
    };

    peers[peerSocketId] = { pc, audioEl, slot: remoteSlot };
    return pc;
  }

  // -------------------------
  // Socket events
  // -------------------------
  const socket = io(SIGNALING_URL, {
    transports: ["polling"],
    upgrade: false,
    forceNew: true,
  });

  socket.on("start_screen_share_signal", ({ fromSocketId }) => {
    if (peers[fromSocketId]) {
      peers[fromSocketId].isSharingScreen = true;
      console.log(
        `[SIGNAL] Peer ${fromSocketId} is now marked as sharing screen.`
      );
    }
  });

  socket.on("connect", async () => {
    statusBar.innerText = "Connected";
    statusBar.className = "connected"; // Tambah class hijau kedip

    try {
      const iceServers = await getTwilioIce();
      if (iceServers.length > 0) RTC_CONFIG.iceServers = iceServers;
    } catch (e) {
      // ignore
    }

    socket.emit("identify", myUser);
    socket.emit("get_room_state");
  });

  // Saat Terputus
  socket.on("disconnect", () => {
    console.log("Disconnected from server");
    statusBar.innerText = "Disconnected";
    statusBar.className = "disconnected"; // Tambah class merah kedip

    // Reset state jika perlu
    voiceGrid.innerHTML = "";
    for (let id in peers) {
      peers[id].pc.close();
      delete peers[id];
    }
  });

  socket.on("room_state", ({ slots }) => {
    lastSlots = slots || {};
    updateAllSlots(slots);
  });

  socket.on("user_joined_voice", ({ slot, user }) => {
    lastSlots[slot] = user;
    updateSlotUI(slot, user);
    if (user.id === myUser.id) {
      mySlot = slot;
    }
  });

  socket.on("stop_screen_share", ({ fromSocketId }) => {
    const container = document.getElementById("screenShareContainer");
    const video = container.querySelector(`video[data-peer="${fromSocketId}"]`);

    if (peers[fromSocketId]) {
      peers[fromSocketId].isSharingScreen = false;
      console.log(`[SIGNAL] Peer ${fromSocketId} is no longer sharing screen.`);
    }
    if (video) video.remove();
    if (!container.querySelector("video")) container.style.display = "none";
  });

  socket.on("user_left_voice", ({ slot }) => {
    const user = lastSlots[slot];

    if (user?.socketId) {
      const cont = document.getElementById("screenShareContainer");
      const video = cont.querySelector(`video[data-peer="${user.socketId}"]`);
      if (video) video.remove();
      if (!cont.querySelector("video")) cont.style.display = "none";

      updateVideoElement(slot, user.socketId, null);
    }

    delete lastSlots[slot];
    clearSlotUI(slot);

    if (user?.socketId && peers[user.socketId]) {
      peers[user.socketId].pc.close();
      delete peers[user.socketId];
    }
  });

  socket.on("webcam_status_changed", ({ slot, status }) => {
    const user = lastSlots[slot];
    if (user) user.webcam = status;

    if (status === "off" && user?.socketId) {
      updateVideoElement(slot, user.socketId, null);

      const peerId = user.socketId;
      if (peers[peerId]) {
        const pc = peers[peerId].pc;
        pc.getReceivers().forEach((receiver) => {
          if (
            receiver.track?.kind === "video" &&
            receiver.track.label !== "screen"
          ) {
            console.log(
              `[CLEANUP] Webcam OFF: Removing remote video from slot ${slot} for peer ${peerId}`
            );
          }
        });
      }
    }
  });

  socket.on("user_speaking", ({ userId, speaking }) => {
    const slot = Object.keys(lastSlots).find(
      (s) => lastSlots[s]?.id === userId
    );
    const circle = document.querySelector(`#slot${slot} .circle`);
    if (circle)
      circle.style.boxShadow = speaking
        ? "0 0 30px rgba(0,255,150,0.9)"
        : "none";
  });

  socket.on("mic_status_changed", ({ slot, status }) => {
    const micBtn = document.getElementById(`mic-${slot}`);
    if (micBtn) {
      micBtn.textContent = status === "on" ? "🎤" : "🔇";
      micBtn.style.opacity = "1";
    }
  });

  socket.on("update_slots", (newSlots) => {
    lastSlots = newSlots || {};
    updateAllSlots(lastSlots);

    const stillHere = Object.values(lastSlots).some((u) => u?.id === myUser.id);
    if (!stillHere) {
      localCleanupAfterKick();
      socket.emit("get_room_state");
    }
  });

  socket.on("user_chat", ({ userId, message }) => {
    const slot = Object.keys(lastSlots).find(
      (s) => lastSlots[s]?.id === userId
    );
    showFloatingText(slot, message);
  });

  socket.on("existing_peers", async (existing) => {
    if (!localStream) localStream = await startLocalStream();

    for (const p of existing) {
      const pc = createPeerConnection(p.socketId, p.slot, localStream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socket.emit("webrtc-offer", {
        toSocketId: p.socketId,
        fromSocketId: socket.id,
        sdp: pc.localDescription,
      });
    }
  });

  socket.on("webrtc-offer", async ({ fromSocketId, sdp }) => {
    const remoteSlot = findSlotBySocketId(fromSocketId);
    if (!localStream) localStream = await startLocalStream();

    const pc = createPeerConnection(fromSocketId, remoteSlot, localStream);

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit("webrtc-answer", {
      toSocketId: fromSocketId,
      fromSocketId: socket.id,
      sdp: pc.localDescription,
    });
  });

  socket.on("webrtc-answer", async ({ fromSocketId, sdp }) => {
    const entry = peers[fromSocketId];
    if (!entry) return;
    await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  });

  socket.on("webrtc-ice", async ({ fromSocketId, candidate }) => {
    const entry = peers[fromSocketId];
    if (!entry) return;
    await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
  });

  // -------------------------
  // Login / Join handling
  // -------------------------
  // ------------- FIX LOGIN SUCCESS (AUTO JOIN SLOT KOSONG) -------------
  // app.js, sekitar baris 772

  // ------------- FIX LOGIN SUCCESS (AUTO JOIN SLOT KOSONG) -------------
  // app.js, sekitar baris 772

  // ------------- FIX LOGIN SUCCESS (AUTO JOIN SLOT KOSONG) -------------
  socket.on("login_success", async ({ isValid, name, userId }) => {
    myUser.name = name;
    myUser.id = userId;
    authUserId = userId; // Simpan user ID yang telah terautentikasi

    // ... (kode lainnya untuk reset UI)

    if (loginForm) loginForm.style.display = "none";
    if (userGreeting) {
      userGreeting.innerText = `Halo, ${name}!`;
      userGreeting.style.display = "block"; // Pastikan tampil
    }
    closeMenu(); // Tutup menu samping setelah login

    // 🔥 LANGKAH 1: Mulai Local Stream (Microphone) & Visualizer
    try {
      localStream = await startLocalStream();
      startMicVisualizer(localStream);
    } catch (err) {
      console.error("Gagal memulai local stream setelah login", err);
      // Jika gagal, pastikan localStream = null atau handle secara elegan
    }

    // 🔥 LANGKAH 2: Langsung Cari Slot Kosong & Join
    const slotKosong = findFirstAvailableSlot();

    if (slotKosong) {
      socket.emit("join_voice", {
        slot: slotKosong,
        user: { ...myUser, socketId: socket.id },
        authUserId: userId,
      });
      mySlot = slotKosong;
    } else {
      alert(
        "Semua slot penuh. Anda sudah login, tetapi tidak ada slot kosong."
      );
      // Penting: Reset jika localStream berhasil tapi tidak bisa join
      if (localStream) {
        // Jika localStream berhasil, tetapi tidak ada slot, biarkan saja.
        // User mungkin akan mengklik slot yang kosong jika ada yang keluar.
      }
    }

    // 🔥 JANGAN gunakan loginPromiseResolve lagi, kita sudah memisahkan alurnya
    // Hapus blok kode ini:
    // if (loginPromiseResolve) {
    //     loginPromiseResolve({ loggedIn: true, name, userId });
    //     loginPromiseResolve = null;
    // }

    pendingSlot = null;
    isLoggingIn = false; // Reset status logging
    btnLoginSubmit.disabled = false;
  });

  socket.on("login_failure", ({ message }) => {
    loginMessage.innerText = message || "Login gagal. Coba lagi.";
    btnLoginSubmit.disabled = false; // Aktifkan tombol
    isLoggingIn = false; // Reset status
    pendingSlot = null; // Reset pending slot
  });

  socket.on("join_failed", ({ reason }) => {
    if (reason === "unauthorized") {
      alert("Anda tidak memiliki otorisasi untuk bergabung dengan slot ini.");
    } else if (reason === "occupied") {
      alert("Slot sudah terisi.");
    } else if (reason === "duplicate_id") {
      alert(
        "ID Anda sudah digunakan. Anda hanya bisa bergabung dengan satu sesi."
      );
      localCleanupAfterKick();
      location.reload();
    }
    pendingSlot = null;
    authUserId = null;
  });

  // -------------------------
  // Slot & UI handlers
  // -------------------------
  function updateAllSlots(slots) {
    for (let i = 1; i <= NUM_SLOTS; i++)
      slots[i] ? updateSlotUI(i, slots[i]) : clearSlotUI(i);
  }

  function updateSlotUI(slot, user) {
    const circle = document.querySelector(`#slot${slot} .circle`);
    const kickBtn = document.getElementById(`kick-${slot}`);
    const micBtn = document.getElementById(`mic-${slot}`);

    if (!circle) return;

    circle.classList.remove("empty");
    circle.style.backgroundImage = `url('${user.avatar}')`;

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
      if (user.id === myUser.id) toggleMyMic();
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

    if (!circle) return;

    circle.classList.add("empty");
    circle.style.backgroundImage = "none";
    circle.style.boxShadow = "none";

    if (kickBtn) kickBtn.style.display = "none";
    if (micBtn) micBtn.style.display = "none";

    const label = circle.parentNode.querySelector(".slot-name");
    if (label) label.remove();

    // Hapus video/container jika ada
    updateVideoElement(slot, null, null);
  }

  // app.js, sekitar baris 840

  // app.js, sekitar baris 840

  async function handleSlotClick(slot) {
    if (mySlot === slot) return;

    // Pindah slot (sudah login)
    if (authUserId) {
      // Cek apakah sudah login
      // Jika sedang membagikan webcam, hentikan dulu
      // 🔥🔥 TAMBAH PENGECUALIAN INI: Cek apakah slot tujuan sudah terisi
      if (lastSlots[slot]) {
        return; // Hentikan fungsi di sini. User tetap di slot lama.
      }
      if (webcamStream) await stopWebcamStream();

      // Tinggalkan slot lama
      if (mySlot)
        socket.emit("leave_voice", { slot: mySlot, userId: myUser.id });

      // Join slot baru
      socket.emit("join_voice", {
        slot,
        user: { ...myUser, socketId: socket.id },
        authUserId,
      });

      mySlot = slot;
      return;
    }

    // 🔥 Belum login: Tampilkan menu login.
    // User harus klik "Login" di menu samping.
    if (!authUserId) {
      // Tampilkan form login, tapi JANGAN LAKUKAN VALIDASI ATAU JOIN
      openMenu();
      // Berikan pesan visual jika perlu, tapi biarkan user klik Login.
      // loginMessage.innerText = "Silakan login terlebih dahulu."; // Opsional

      // JANGAN lakukan promptForCredentials() yang mengembalikan Promise,
      // karena kita mau Login Button yang memicu proses.
      return;
    }
  }

  // -------------------------
  // Prompt for credentials
  // -------------------------
  // app.js, sekitar baris 896

  // -------------------------
  // Prompt for credentials
  // -------------------------
  function promptForCredentials() {
    // Jika sudah terotorisasi (sudah login), lewati/kembalikan status
    if (authUserId) {
      return Promise.resolve({
        username: myUser.name,
        password: "", // Password tidak dikirim
        isReconnecting: true,
      });
    }

    // Tampilkan form login di side menu jika belum terlihat
    if (loginForm) loginForm.style.display = "block";

    // 🔥 Jika belum login, kembalikan Promise yang tidak langsung resolve
    // Resolve akan dilakukan oleh btnLoginSubmit yang kini langsung memanggil socket.emit("validate_login")
    // Note: Anda mungkin ingin menampilkan Menu Samping (sideMenu) di sini.
    openMenu(); // Panggil fungsi openMenu()

    // Cukup kembalikan Promise.reject atau null jika ingin user menekan tombol Login
    // Kita biarkan user menekan tombol Login di menu samping, jadi kita return Promise yang menahan
    // fungsi handleSlotClick agar tidak lanjut, atau kita buat Promise yang resolve-nya
    // akan dipanggil dari login_success.

    // Kita kembalikan Promise yang menunggu, dan resolve-nya akan di-trigger
    // oleh socket.on("login_success").
    return new Promise((resolve) => {
      loginPromiseResolve = resolve;
    });
  }
  // -------------------------
  // Handler Submit Login (BARU)
  // -------------------------
  btnLoginSubmit.addEventListener("click", () => {
    if (isLoggingIn) return; // Cukup cegah klik ganda

    const username = loginUsernameInput.value.trim();
    const password = loginPasswordInput.value.trim();

    if (!username || !password) {
      loginMessage.innerText = "Username dan Password harus diisi!";
      return;
    }

    isLoggingIn = true;
    loginMessage.innerText = "Mencoba masuk...";
    btnLoginSubmit.disabled = true;

    socket.emit("validate_login", { username, password });
  });

  // -------------------------
  // Mic toggle
  // -------------------------
  function toggleMyMic() {
    if (!localStream) return;

    const track = localStream.getAudioTracks()[0];
    track.enabled = !track.enabled;
    myUser.mic = track.enabled ? "on" : "off";

    socket.emit("toggle_mic", {
      slot: mySlot,
      userId: myUser.id,
      status: myUser.mic,
    });

    const btn = document.getElementById(`mic-${mySlot}`);
    if (btn) btn.innerText = myUser.mic === "on" ? "🎤" : "🔇";
  }

  // -------------------------
  // Floating text chat
  // -------------------------
  function showFloatingText(slot, text) {
    const slotDiv = document.getElementById(`slot${slot}`);
    if (!slotDiv) return;

    let bubble = slotDiv.querySelector(".floating-text");
    if (!bubble) {
      bubble = document.createElement("div");
      bubble.className = "floating-text";
      slotDiv.appendChild(bubble);
    }

    if (!text) {
      bubble.classList.add("fade-out");
      return setTimeout(() => bubble.remove(), 300);
    }

    bubble.innerText = text;
    bubble.classList.remove("fade-out");

    clearTimeout(bubble.timeoutId);

    bubble.timeoutId = setTimeout(() => {
      bubble.classList.add("fade-out");
      setTimeout(() => bubble.remove(), 350);
    }, 4000);
  }

  if (chatInput) {
    chatInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (!mySlot) return;

      const text = chatInput.value.trim();
      if (!text) return;

      socket.emit("user_chat", { userId: myUser.id, message: text });
      showFloatingText(mySlot, text);

      chatInput.value = "";
      chatInput.blur();
    });

    document.addEventListener("touchstart", (ev) => {
      if (
        chatInput &&
        !ev.target.closest("#chatContainer") &&
        document.activeElement === chatInput
      ) {
        chatInput.blur();
      }
    });
  }

  // -------------------------
  // Global mute/unmute
  // -------------------------
  function muteAllUsers() {
    document.querySelectorAll("audio").forEach((a) => (a.muted = true));
  }

  function unmuteAllUsers() {
    document.querySelectorAll("audio").forEach((a) => (a.muted = false));
  }

  if (btnVolOn)
    btnVolOn.addEventListener("click", () => {
      btnVolOn.style.display = "none";
      if (btnSilent) btnSilent.style.display = "flex";

      isMuted = true;
      muteAllUsers();
    });

  if (btnSilent)
    btnSilent.addEventListener("click", () => {
      btnSilent.style.display = "none";
      if (btnVolOn) btnVolOn.style.display = "flex";

      isMuted = false;
      unmuteAllUsers();

      if (localStream) {
        const t = localStream.getAudioTracks()[0];
        if (t) t.enabled = true;
        myUser.mic = "on";

        if (mySlot) {
          socket.emit("toggle_mic", {
            slot: mySlot,
            userId: myUser.id,
            status: myUser.mic,
          });
        }
      }
    });

  // -------------------------
  // Kick handling / cleanup
  // -------------------------
  socket.on("kicked", () => {
    alert("Anda telah dikeluarkan dari room.");
    localCleanupAfterKick();
    socket.emit("get_room_state");
  });

  function localCleanupAfterKick() {
    if (mySlot) {
      clearSlotUI(mySlot);
      updateVideoElement(mySlot, socket.id, null, true);
      mySlot = null;
    }

    // Sembunyikan form login lagi (jika ada)
    if (loginForm) loginForm.style.display = "none";

    if (userGreeting) userGreeting.style.display = "none"; // <-- SEMBUNYIKAN GREETING
    // 🔥 AKHIR PERUBAHAN BARU

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

    if (webcamStream) {
      try {
        webcamStream.getTracks().forEach((t) => t.stop());
      } catch (e) {}
      webcamStream = null;
    }

    if (btnWebcam) btnWebcam.style.background = "";
    authUserId = null;
  }

  const btnKeluar = document.getElementById("btnKeluar");
  // -------------------------
  // Side Menu Handlers (BARU)
  // -------------------------

  // Tampilkan tombol menu setelah Cordova ready
  if (btnMenu) btnMenu.style.display = "flex";

  function openMenu() {
    if (sideMenu) {
      sideMenu.classList.add("active");
      sideMenu.style.pointerEvents = "all";
    }
  }

  function closeMenu() {
    if (sideMenu) {
      sideMenu.classList.remove("active");
      // Delay sedikit sebelum menonaktifkan pointer-events agar transisi selesai
      setTimeout(() => {
        sideMenu.style.pointerEvents = "none";
      }, 300);
    }
  }

  if (btnMenu) {
    btnMenu.addEventListener("click", openMenu);
  }

  if (menuOverlay) {
    menuOverlay.addEventListener("click", closeMenu);
  }
  if (btnMenu) btnMenu.style.display = "flex";

  function openMenu() {
    if (sideMenu) {
      sideMenu.classList.add("active");
      sideMenu.style.pointerEvents = "all";
    }
  }
  if (btnMenu) btnMenu.style.display = "flex";

  function openMenu() {
    if (sideMenu) {
      sideMenu.classList.add("active");
      sideMenu.style.pointerEvents = "all";
    }
  }
  function closeMenu() {
    if (sideMenu) {
      sideMenu.classList.remove("active");
      // Delay sedikit sebelum menonaktifkan pointer-events agar transisi selesai
      setTimeout(() => {
        sideMenu.style.pointerEvents = "none";
      }, 300);
    }
  }
  if (btnMenu) {
    btnMenu.addEventListener("click", openMenu);
  }

  if (menuOverlay) {
    menuOverlay.addEventListener("click", closeMenu);
  }
  if (btnKeluar)
    btnKeluar.onclick = () => {
      if (mySlot)
        socket.emit("leave_voice", { slot: mySlot, userId: myUser.id });
      if (webcamStream) stopWebcamStream();
      try {
        socket.close();
      } catch (e) {}
      localCleanupAfterKick();
      location.reload();
    };

  window.addEventListener("beforeunload", () => {
    if (mySlot) socket.emit("leave_voice", { slot: mySlot, userId: myUser.id });
    if (webcamStream) stopWebcamStream();
    try {
      socket.close();
    } catch (e) {}
  });
});
