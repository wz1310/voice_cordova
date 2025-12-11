// app.js (final updated - cleaned formatting only)
document.addEventListener("deviceready", () => {
  console.log("Cordova Ready!");

  let isMuted = false;
  let screenStream = null;
  let webcamStream = null; // <-- TAMBAHAN
  let mySlot = null;
  let localStream = null;
  let authUsername = null; // <-- BARU: Simpan username yang berhasil login
  let authUserId = null; // <-- BARU: Simpan ID yang berhasil login (menggantikan authUsername)

  const NUM_SLOTS = 8;
  const peers = {};
  const SIGNALING_URL = "https://m3h048qq-4000.asse.devtunnels.ms";
  let RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };
  let lastSlots = {};

  const voiceGrid = document.getElementById("voiceGrid");
  const statusBar = document.getElementById("statusBar");
  const chatInput = document.getElementById("chatInput");
  const btnScreenShare = document.getElementById("btnScreenShare");
  const btnWebcam = document.getElementById("btnWebcam"); // <-- TAMBAHAN

  const myUser = {
    id: "u" + Math.floor(Math.random() * 999999),
    name: "Tamu", // <-- Ganti nama default
    avatar: "https://api.dicebear.com/7.x/bottts/svg?seed=" + Math.random(),
    mic: "on",
    webcam: "off", // <-- TAMBAHAN
  };

  /* =========================================================
      UTILITIES
  ========================================================= */
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
        btnScreenShare.style.background = "";
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

  /* =========================================================
      WEBCAM HANDLERS <-- BARU
  ========================================================= */

  async function startWebcamStream() {
    if (!mySlot) return alert("Join slot dulu sebelum mengaktifkan kamera!");

    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      webcamStream = s;
      btnWebcam.style.background = "#0f0";

      // 1. Tampilkan video lokal di slot sendiri
      updateVideoElement(mySlot, socket.id, webcamStream, true);

      // 2. Kirim track video ke semua peer
      for (const peerId in peers) {
        const pc = peers[peerId].pc;
        webcamStream
          .getVideoTracks()
          .forEach((t) => pc.addTrack(t, webcamStream));

        // Negosiasi ulang (Offer/Answer)
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        socket.emit("webrtc-offer", {
          toSocketId: peerId,
          fromSocketId: socket.id,
          sdp: pc.localDescription,
        });
      }

      // 3. Update status di server
      myUser.webcam = "on";
      socket.emit("toggle_webcam", {
        slot: mySlot,
        userId: myUser.id,
        status: myUser.webcam,
      });
    } catch (err) {
      console.warn("Webcam gagal", err);
      alert("Tidak bisa mengakses kamera.");
      btnWebcam.style.background = "";
      webcamStream = null;
      myUser.webcam = "off";
    }
  }

  async function stopWebcamStream() {
    if (!webcamStream) return;

    // 1. Hapus video lokal
    updateVideoElement(mySlot, socket.id, null, true);

    // 2. Hentikan track
    webcamStream.getTracks().forEach((t) => t.stop());
    webcamStream = null;
    btnWebcam.style.background = "";

    // 3. Hapus track dari peer connections
    for (const peerId in peers) {
      const pc = peers[peerId].pc;

      pc.getSenders().forEach((sender) => {
        // Hapus track yang jenisnya video dan BUKAN screen
        if (sender.track?.kind === "video" && sender.track.label !== "screen") {
          pc.removeTrack(sender);
        }
      });

      // Negosiasi ulang
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      socket.emit("webrtc-offer", {
        toSocketId: peerId,
        fromSocketId: socket.id,
        sdp: pc.localDescription,
      });
    }

    // 4. Update status di server
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
        // Tambahkan sebelum .circle agar muncul di atas avatar
        slotDiv.insertBefore(container, slotDiv.querySelector(".circle"));
      }

      let video = container.querySelector(`video[data-peer="${peerSocketId}"]`);

      if (!video) {
        video = document.createElement("video");
        video.dataset.peer = peerSocketId;
        video.autoplay = true;
        video.playsInline = true;
        video.muted = isLocal; // Mute video lokal
        video.style.transform = isLocal ? "scaleX(-1)" : "none"; // Mirror lokal
        container.appendChild(video);
      }

      video.srcObject = stream;
    } else if (container) {
      // Hapus video/container jika stream null
      const video = container.querySelector(
        `video[data-peer="${peerSocketId}"]`
      );
      if (video) video.remove();

      // Hapus container jika sudah tidak ada video di dalamnya
      if (!container.querySelector("video")) container.remove();
    }
  }

  // Listener Tombol Webcam
  btnWebcam.addEventListener("click", async () => {
    if (screenStream) {
      alert("Matikan Screen Share dulu sebelum mengaktifkan kamera!");
      return;
    }
    if (!mySlot) return alert("Join slot dulu sebelum mengaktifkan kamera!");
    if (webcamStream) return stopWebcamStream();
    return startWebcamStream();
  });

  /* =========================================================
      SCREEN SHARE
  ========================================================= */
  btnScreenShare.addEventListener("click", async () => {
    const screenContainer = document.getElementById("screenShareContainer");

    if (webcamStream) {
      await stopWebcamStream(); // <-- agar tidak bentrok dengan screen
    }

    if (!mySlot) return alert("Join slot dulu sebelum share screen!");
    if (screenStream) return await stopScreenShare();

    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      // 1. KIRIM SINYAL KE SEMUA PEER SEBELUM ADDTRACK
      socket.emit("start_screen_share_signal", {
        fromSocketId: socket.id,
      });

      // --- TAMPILKAN VIDEO LOKAL DI CONTAINER BAWAH ---
      const videoEl = document.createElement("video");
      videoEl.id = "localScreenVideo";
      videoEl.autoplay = true;
      videoEl.playsInline = true;
      videoEl.muted = true; // Video lokal harus di-mute
      videoEl.style.width = "100%";
      videoEl.style.height = "100%";
      videoEl.style.objectFit = "contain";
      videoEl.srcObject = screenStream;

      // Hapus video sebelumnya jika ada (misal dari peer lain)
      screenContainer.innerHTML = "";
      screenContainer.appendChild(videoEl);
      addManualCloseButton(screenContainer); // Tambahkan tombol close

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

      btnScreenShare.style.background = "#0f0";

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
    // --- HAPUS TAMPILAN LOKAL SCREEN SHARE ---
    const screenContainer = document.getElementById("screenShareContainer");
    screenContainer.innerHTML = ""; // Bersihkan semua konten
    screenContainer.style.display = "none";
    // ------------------------------------------
  }

  /* =========================================================
      FETCH TWILIO ICE
  ========================================================= */
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

  /* =========================================================
      BUILD SLOT UI
  ========================================================= */
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

  /* =========================================================
      MIC VISUALIZER
  ========================================================= */
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
      const avg = data.reduce((a, b) => a + b) / data.length;
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

  /* =========================================================
      PEER CONNECTION
  ========================================================= */
  function createPeerConnection(peerSocketId, remoteSlot, localStream) {
    if (peers[peerSocketId]) return peers[peerSocketId].pc;

    const pc = new RTCPeerConnection(RTC_CONFIG);

    // Tambahkan stream webcam lokal jika aktif
    if (webcamStream)
      webcamStream.getTracks().forEach((t) => pc.addTrack(t, webcamStream)); // <-- BARU

    // *** ➡️ TAMBAHKAN BLOK INI UNTUK SCREEN SHARE ***
    if (screenStream) {
      screenStream.getTracks().forEach((t) => pc.addTrack(t, screenStream));
      // Sinyal ke peer baru bahwa kita sedang berbagi layar (untuk flag isSharingScreen)
      socket.emit("start_screen_share_signal", {
        fromSocketId: socket.id,
        toSocketId: peerSocketId, // Kirim langsung ke peer yang baru join
      });
    }
    // **********************************************

    if (localStream)
      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

    const audioEl = createRemoteAudioElement(peerSocketId, remoteSlot);

    pc.ontrack = (evt) => {
      const stream = evt.streams[0];
      const kind = evt.track.kind;
      const track = evt.track;

      // --- DEBUG LOGGING TAMBAHAN ---
      console.log(`[ONTRACK] Peer: ${peerSocketId}`);
      console.log(
        `[ONTRACK] Kind: ${kind}, Label: ${track.label}, ID: ${track.id}`
      );
      // -----------------------------

      if (kind === "video") {
        const container = document.getElementById("screenShareContainer");
        const isSharing =
          peers[peerSocketId] && peers[peerSocketId].isSharingScreen;
        const isScreenShare = track.label.includes("screen") || isSharing;

        console.log(`[ONTRACK] Peer Flag Is Sharing? ${isSharing}`);
        console.log(`[ONTRACK] Is Screen Share? ${isScreenShare}`);

        if (isScreenShare) {
          // --- PENANGANAN SCREEN SHARE (ke container bawah) ---
          container.style.display = "flex";

          let video = container.querySelector(
            `video[data-peer="${peerSocketId}"]`
          );

          if (!video) {
            video = document.createElement("video");
            video.dataset.peer = peerSocketId;
            video.autoplay = true;
            video.playsInline = true;

            // Tambahkan video ke container
            container.appendChild(video);

            // Tambahkan tombol fullscreen/close jika belum ada video screen share lain.
            // Kita hanya perlu satu set tombol control untuk seluruh container.
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
          // Set stream ke video screen share
          video.srcObject = stream;

          // Hapus video webcam jika ada dari user ini (misalnya screen share aktif, webcam harus hilang dari slot)
          updateVideoElement(remoteSlot, peerSocketId, null);
        } else {
          // --- PENANGANAN VIDEO WEBCAM (ke avatar slot) ---
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

  /* =========================================================
      SOCKET EVENTS
  ========================================================= */
  const socket = io(SIGNALING_URL, {
    transports: ["polling"],
    upgrade: false,
    forceNew: true,
  });

  socket.on("start_screen_share_signal", ({ fromSocketId }) => {
    if (peers[fromSocketId]) {
      // Set flag di objek peer
      peers[fromSocketId].isSharingScreen = true;
      console.log(
        `[SIGNAL] Peer ${fromSocketId} is now marked as sharing screen.`
      );
    }
  });

  socket.on("connect", async () => {
    statusBar.innerText = "Connected";

    try {
      const iceServers = await getTwilioIce();
      if (iceServers.length > 0) RTC_CONFIG.iceServers = iceServers;
    } catch {}

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

    if (peers[fromSocketId]) {
      peers[fromSocketId].isSharingScreen = false; // Reset flag saat berhenti
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
      // !!! TAMBAHKAN LOGIKA UNTUK HAPUS VIDEO WEBCAM DARI SLOT !!!
      updateVideoElement(slot, user.socketId, null);
    }

    delete lastSlots[slot];
    clearSlotUI(slot);
    // Hapus peer connection juga di sini (jika belum dilakukan di tempat lain)
    if (user?.socketId && peers[user.socketId]) {
      peers[user.socketId].pc.close();
      delete peers[user.socketId];
    }
  });

  socket.on("webcam_status_changed", ({ slot, status }) => {
    // <-- BARU
    const user = lastSlots[slot];
    if (user) user.webcam = status;

    // Jika status OFF, pastikan video remote dihilangkan
    if (status === "off") {
      updateVideoElement(slot, user.socketId, null);
      // !!! TAMBAHKAN LOGIKA UNTUK MENUTUP REMOTE TRACK JIKA MASIH ADA !!!
      // Ini memastikan track video remote benar-benar dibersihkan dari peer connection.
      const peerId = user.socketId;
      if (peers[peerId]) {
        const pc = peers[peerId].pc;
        pc.getReceivers().forEach((receiver) => {
          if (
            receiver.track?.kind === "video" &&
            receiver.track.label !== "screen"
          ) {
            // Di WebRTC, tidak ada 'removeTrack' untuk receiver.
            // Cukup hapus elemen video di UI adalah cara yang paling efektif.
            // Namun, kita bisa menambahkan log untuk debugging:
            console.log(
              `[CLEANUP] Webcam OFF: Removing remote video from slot ${slot} for peer ${peerId}`
            );
          }
        });
      }
    }
    // Anda bisa menambahkan indikasi visual lain di sini jika diperlukan
  });

  socket.on("user_speaking", ({ userId, speaking }) => {
    const slot = Object.keys(lastSlots).find(
      (s) => lastSlots[s]?.id === userId
    );

    const circle = document.querySelector(`#slot${slot} .circle`);
    if (circle) {
      circle.style.boxShadow = speaking
        ? "0 0 30px rgba(0,255,150,0.9)"
        : "none";
    }
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
    if (screenStream) {
      screenStream.getTracks().forEach((t) => pc.addTrack(t, screenStream));
      socket.emit("start_screen_share_signal", {
        fromSocketId: socket.id,
        toSocketId: peerSocketId,
      });
    }
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

  // ----------------------------
  //  Login Handlers <-- BARU
  // ----------------------------
  socket.on("login_success", ({ isValid, name, userId }) => { // <-- PASTIKAN userId ADA DI SINI
    myUser.name = name;
    // Gunakan hash dari nama sebagai seed avatar agar avatar lebih konsisten// Gunakan ID dari server untuk identitas
    myUser.id = userId; // <-- PENTING: Update myUser.id dengan ID server
    authUserId = userId; // <-- Simpan ID otentikasi permanen
    const seed = name
      .split("")
      .reduce((sum, char) => sum + char.charCodeAt(0), 0);
    myUser.avatar = "https://api.dicebear.com/7.x/bottts/svg?seed=" + seed;

    // Lanjutkan proses join setelah login berhasil
    socket.emit("join_voice", {
      slot: pendingSlot, // Gunakan slot yang disimpan sebelumnya
      user: { ...myUser, socketId: socket.id },
      authUserId: authUserId, // Kirim ID otentikasi
    });

    mySlot = pendingSlot;
    pendingSlot = null;
  });

  socket.on("login_failure", ({ message }) => {
    alert("Login Gagal: " + message);
    pendingSlot = null;
    authUsername = null;
  });

  socket.on("join_failed", ({ reason }) => {
    // <-- TAMBAHAN: Untuk notifikasi join gagal
    if (reason === "unauthorized") {
      alert("Anda tidak memiliki otorisasi untuk bergabung dengan slot ini.");
    } else if (reason === "occupied") {
      alert("Slot sudah terisi.");
    } else if (reason === "duplicate_id") {
      // <-- BARU
      alert(
        "ID Anda sudah digunakan. Anda hanya bisa bergabung dengan satu sesi."
      );
      localCleanupAfterKick();
      location.reload();
    }
    pendingSlot = null;
    authUsername = null;
  });

  /* =========================================================
      SLOT & UI HANDLERS
  ========================================================= */
  function updateAllSlots(slots) {
    for (let i = 1; i <= NUM_SLOTS; i++)
      slots[i] ? updateSlotUI(i, slots[i]) : clearSlotUI(i);
  }

  function updateSlotUI(slot, user) {
    const circle = document.querySelector(`#slot${slot} .circle`);
    const kickBtn = document.getElementById(`kick-${slot}`);
    const micBtn = document.getElementById(`mic-${slot}`);

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

    circle.classList.add("empty");
    circle.style.backgroundImage = "none";
    circle.style.boxShadow = "none";

    kickBtn.style.display = "none";
    micBtn.style.display = "none";

    const label = circle.parentNode.querySelector(".slot-name");
    if (label) label.remove();
  }
  let pendingSlot = null; // <-- BARU: Slot yang akan di-join setelah login

  async function handleSlotClick(slot) {
    if (mySlot === slot) return; // Klik slot yang sama, abaikan

    // ==========================================================
    // BAGIAN 1: PERTAMA KALI JOIN (Membutuhkan Autentikasi Login)
    // ==========================================================
    if (!mySlot) {
      if (pendingSlot) return;
      pendingSlot = slot;

      const creds = await promptForCredentials();

      if (!creds) {
        pendingSlot = null;
        return; // User membatalkan login
      }

      authUserId = creds.username; // <-- Simpan username sementara

      // Persiapan Stream
      try {
        localStream = await startLocalStream();
        startMicVisualizer(localStream);
      } catch (err) {
        // Jika gagal start audio, batalkan join
        pendingSlot = null;
        authUsername = null;
        return;
      }

      // Kirim kredensial ke server untuk validasi
      socket.emit("validate_login", creds);

      // HENTIKAN di sini. Proses join dilanjutkan di event 'login_success'.
      return;
    }

    // ==========================================================
    // BAGIAN 2: PINDAH SLOT (mySlot SUDAH terisi, artinya user SUDAH login)
    // ==========================================================

    // 1. Matikan webcam jika aktif
    if (webcamStream) {
      await stopWebcamStream();
    }

    // 2. Tinggalkan slot lama
    socket.emit("leave_voice", { slot: mySlot, userId: myUser.id });

    // 3. Gabung slot baru
    socket.emit("join_voice", {
      slot,
      user: { ...myUser, socketId: socket.id },
      authUserId: authUserId, // <-- Ganti authUsername ke authUserId
    });

    // 4. Update status lokal
    mySlot = slot;
  }

  /* =========================================================
      PROMPT LOGIN <-- BARU
  ========================================================= */
  async function promptForCredentials() {
    const username = prompt("Masukkan Username:");
    if (!username) return null;

    const password = prompt("Masukkan Password untuk " + username + ":");
    if (!password) return null;

    return { username, password };
  }

  /* =========================================================
      MIC TOGGLE
  ========================================================= */
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

  /* =========================================================
      FLOATING TEXT CHAT
  ========================================================= */
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

  /* =========================================================
      GLOBAL MUTE / UNMUTE
  ========================================================= */
  const btnVolOn = document.getElementById("volumeon");
  const btnSilent = document.getElementById("silent");

  function muteAllUsers() {
    document.querySelectorAll("audio").forEach((a) => (a.muted = true));
  }

  function unmuteAllUsers() {
    document.querySelectorAll("audio").forEach((a) => (a.muted = false));
  }

  btnVolOn.addEventListener("click", () => {
    btnVolOn.style.display = "none";
    btnSilent.style.display = "flex";

    isMuted = true;
    muteAllUsers();
  });

  btnSilent.addEventListener("click", () => {
    btnSilent.style.display = "none";
    btnVolOn.style.display = "flex";

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

  /* =========================================================
      KICK HANDLING
  ========================================================= */
  socket.on("kicked", () => {
    alert("Anda telah dikeluarkan dari room.");
    localCleanupAfterKick();
    socket.emit("get_room_state");
  });

  function localCleanupAfterKick() {
    if (mySlot) {
      clearSlotUI(mySlot);
      // Hapus video lokal dari slot
      updateVideoElement(mySlot, socket.id, null, true); // <-- BARU
      mySlot = null;
    }

    for (const p in peers) {
      try {
        peers[p].pc.close();
      } catch {}
      delete peers[p];
    }

    if (localStream) {
      try {
        localStream.getTracks().forEach((t) => t.stop());
      } catch {}
      localStream = null;
    }
    // Cleanup Webcam BARU
    if (webcamStream) {
      try {
        webcamStream.getTracks().forEach((t) => t.stop());
      } catch {}
      webcamStream = null;
    }
    btnWebcam.style.background = ""; // <-- BARU
    authUserId = null; // <-- Ganti authUsername ke authUserId
  }

  document.getElementById("btnKeluar").onclick = () => {
    if (mySlot) socket.emit("leave_voice", { slot: mySlot, userId: myUser.id });

    // Hentikan Webcam jika aktif
    if (webcamStream) stopWebcamStream(); // <-- BARU

    try {
      socket.close();
    } catch {}

    localCleanupAfterKick();
    location.reload();
  };

  window.addEventListener("beforeunload", () => {
    if (mySlot) socket.emit("leave_voice", { slot: mySlot, userId: myUser.id });

    // Hentikan Webcam jika aktif
    if (webcamStream) stopWebcamStream(); // <-- BARU

    try {
      socket.close();
    } catch {}
  });
});
