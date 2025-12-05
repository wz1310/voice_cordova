document.addEventListener("deviceready", () => {
  console.log("Cordova Ready!");

  const voiceGrid = document.getElementById("voiceGrid");
  const statusBar = document.getElementById("statusBar");

  const SIGNALING_URL = "https://m3h048qq-3000.asse.devtunnels.ms";

  const socket = io(SIGNALING_URL, {
    transports: ["polling"],
    upgrade: false,
    forceNew: true
  });

  const myUser = {
    id: "u" + Math.floor(Math.random() * 999999),
    name: "User " + Math.floor(Math.random() * 99),
    avatar: "https://api.dicebear.com/7.x/bottts/svg?seed=" + Math.random()
  };

  let mySlot = null;
  const NUM_SLOTS = 8;
  const peers = {};
  let localStream = null;

  const RTC_CONFIG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

  // Create slot UI
  for (let i = 1; i <= NUM_SLOTS; i++) {
    const div = document.createElement("div");
    div.className = "voice-slot";
    div.id = "slot" + i;
    div.style.position = "relative";

    div.innerHTML = `
      <div class="kick-btn" id="kick-${i}" style="
        position:absolute; top:-5px; right:-5px;
        background:red; color:white; width:18px; height:18px;
        font-size:12px; text-align:center; line-height:18px;
        border-radius:50%; cursor:pointer; z-index:2; display:none;">x</div>
      <div class="circle empty"></div>
    `;

    voiceGrid.appendChild(div);
    div.addEventListener("click", () => handleSlotClick(i));
  }

  function createRemoteAudioElement(peerSocketId, slot) {
    const circle = document.querySelector(`#slot${slot} .circle`);
    if (!circle) return null;
    let audio = circle.querySelector(`audio[data-peer="${peerSocketId}"]`);
    if (!audio) {
      audio = document.createElement("audio");
      audio.setAttribute("data-peer", peerSocketId);
      audio.autoplay = true;
      audio.playsInline = true;
      audio.style.display = "none";
      circle.appendChild(audio);
    }
    return audio;
  }

  async function startLocalStream() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log("Got local stream");
      return stream;
    } catch (err) {
      alert("Tidak bisa mengakses microphone.");
      throw err;
    }
  }

  // MIC VISUALIZER + STATUS KE SERVER
  function startMicVisualizer(stream) {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;

    source.connect(analyser);
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let lastSpeaking = false;

    function animate() {
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const average = sum / dataArray.length;

      const speaking = average > 10;

      if (mySlot) {
        const myCircle = document.querySelector(`#slot${mySlot} .circle`);
        if (myCircle) {
          myCircle.style.boxShadow = speaking
            ? `0 0 ${Math.min(average,50)}px 5px rgba(0,200,0,0.7)`
            : "none";
        }
      }

      if (speaking !== lastSpeaking) {
        lastSpeaking = speaking;
        socket.emit("user_speaking", { userId: myUser.id, speaking });
      }

      requestAnimationFrame(animate);
    }

    animate();
  }

  function createPeerConnection(peerSocketId, remoteSlot, localStream) {
    if (peers[peerSocketId]) return peers[peerSocketId].pc;
    const pc = new RTCPeerConnection(RTC_CONFIG);
    if (localStream) for (const t of localStream.getTracks()) pc.addTrack(t, localStream);

    const audioEl = createRemoteAudioElement(peerSocketId, remoteSlot);
    pc.ontrack = (evt) => { const [stream] = evt.streams; if (audioEl) audioEl.srcObject = stream; };
    pc.onicecandidate = (event) => {
      if (event.candidate) socket.emit("webrtc-ice", { toSocketId: peerSocketId, fromSocketId: socket.id, candidate: event.candidate });
    };

    peers[peerSocketId] = { pc, audioEl, slot: remoteSlot };
    return pc;
  }

  // =========================
  // SOCKET EVENTS
  // =========================
  socket.on("webrtc-offer", async ({ fromSocketId, sdp }) => {
    const remoteSlot = findSlotBySocketId(fromSocketId);
    if (!localStream) localStream = await startLocalStream();
    const pc = createPeerConnection(fromSocketId, remoteSlot, localStream);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("webrtc-answer", { toSocketId: fromSocketId, fromSocketId: socket.id, sdp: pc.localDescription });
  });

  socket.on("webrtc-answer", async ({ fromSocketId, sdp }) => {
    const entry = peers[fromSocketId];
    if (entry) await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  });

  socket.on("webrtc-ice", async ({ fromSocketId, candidate }) => {
    const entry = peers[fromSocketId];
    if (entry) entry.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.warn);
  });

  let lastSlots = {};

  function findSlotBySocketId(socketId) {
    for (const s in lastSlots) if (lastSlots[s] && lastSlots[s].socketId === socketId) return Number(s);
    return null;
  }

  socket.on("existing_peers", async (existing) => {
    if (!localStream) localStream = await startLocalStream();
    for (const p of existing) {
      const pc = createPeerConnection(p.socketId, p.slot, localStream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("webrtc-offer", { toSocketId: p.socketId, fromSocketId: socket.id, sdp: pc.localDescription });
    }
  });

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
    for (const peerId in peers) {
      if (peers[peerId].slot === Number(slot)) {
        try { peers[peerId].pc.close(); } catch {}
        if (peers[peerId].audioEl) peers[peerId].audioEl.remove();
        delete peers[peerId];
      }
    }
  });

  // =========================
  // USER SPEAKING UPDATE
  // =========================
  socket.on("user_speaking", ({ userId, speaking }) => {
    let slot = null;
    for (const s in lastSlots) if (lastSlots[s]?.id === userId) slot = s;
    if (!slot) return;
    const circle = document.querySelector(`#slot${slot} .circle`);
    if (!circle) return;
    circle.style.boxShadow = speaking ? `0 0 20px 5px rgba(0,200,0,0.7)` : "none";
  });

  // =========================
  // UI UPDATE
  // =========================
  function updateAllSlots(slots) { for (let i = 1; i <= NUM_SLOTS; i++) clearSlotUI(i); for (const s in slots) updateSlotUI(s, slots[s]); }

  function updateSlotUI(slot, user) {
    const circle = document.querySelector(`#slot${slot} .circle`);
    const kickBtn = document.getElementById(`kick-${slot}`);
    circle.classList.remove("empty");
    circle.style.backgroundImage = `url('${user.avatar}')`;
    kickBtn.style.display = user.id !== myUser.id ? "block" : "none";
    if (user.id !== myUser.id) kickBtn.onclick = () => socket.emit("kick_user", { userId: user.id });

    let label = circle.nextElementSibling;
    if (!label || !label.classList.contains("slot-name")) { label = document.createElement("div"); label.className = "slot-name"; circle.parentNode.appendChild(label); }
    label.innerText = user.name;
  }

  function clearSlotUI(slot) {
    const circle = document.querySelector(`#slot${slot} .circle`);
    const kickBtn = document.getElementById(`kick-${slot}`);
    circle.classList.add("empty");
    circle.style.backgroundImage = "none";
    circle.style.boxShadow = "none";
    kickBtn.style.display = "none";
    const label = circle.parentNode.querySelector(".slot-name");
    if (label) label.remove();
  }

  // =========================
  // SLOT CLICK LOGIC
  // =========================
  async function handleSlotClick(slot) {
    if (!mySlot) {
      try { localStream = await startLocalStream(); startMicVisualizer(localStream); } catch(e) { return; }
      socket.emit("join_voice", { slot, user: { ...myUser, socketId: socket.id } });
      mySlot = slot;
      return;
    }

    if (mySlot === slot) {
      const enabled = localStream.getAudioTracks()[0].enabled;
      localStream.getAudioTracks()[0].enabled = !enabled;
      socket.emit("toggle_mic", { slot: mySlot, userId: myUser.id });
      return;
    }

    socket.emit("leave_voice", { slot: mySlot, userId: myUser.id });
    socket.emit("join_voice", { slot, user: { ...myUser, socketId: socket.id } });
    mySlot = slot;
  }

  window.addEventListener("beforeunload", () => {
    if (mySlot) socket.emit("leave_voice", { slot: mySlot, userId: myUser.id });
    socket.close();
  });
});
