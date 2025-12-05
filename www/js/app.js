// app.js (client)
document.addEventListener("deviceready", () => {
  console.log("Cordova Ready!");

  const voiceGrid = document.getElementById("voiceGrid");
  const statusBar = document.getElementById("statusBar");

  // signaling server (DevTunnel)
  const SIGNALING_URL = "https://m3h048qq-3000.asse.devtunnels.ms";

  const socket = io(SIGNALING_URL, {
    transports: ["polling"],
    upgrade: false,
    forceNew: true
  });

  // local user identity
  const myUser = {
    id: "u" + Math.floor(Math.random() * 999999),
    name: "User " + Math.floor(Math.random() * 99),
    avatar: "https://api.dicebear.com/7.x/bottts/svg?seed=" + Math.random()
  };

  let mySlot = null;
  const NUM_SLOTS = 8;

  // WebRTC objects:
  // peers: map peerSocketId => { pc, audioEl, slot }
  const peers = {};

  // STUN/TURN servers — TURN recommended for production
  const RTC_CONFIG = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" }
      // add TURN here if available
      // { urls: 'turn:YOUR_TURN_SERVER', username: 'user', credential: 'pass' }
    ]
  };

  // Create slot UI
  for (let i = 1; i <= NUM_SLOTS; i++) {
    const div = document.createElement("div");
    div.className = "voice-slot";
    div.id = "slot" + i;
    div.innerHTML = `<div class="circle empty"></div>`;
    voiceGrid.appendChild(div);

    div.addEventListener("click", () => handleSlotClick(i));
  }

  // Helpers to create audio element for remote peer
  function createRemoteAudioElement(peerSocketId, slot) {
    const circle = document.querySelector(`#slot${slot} .circle`);
    if (!circle) return null;

    // create an audio element and attach inside the circle (or after)
    let audio = circle.querySelector(`audio[data-peer="${peerSocketId}"]`);
    if (!audio) {
      audio = document.createElement("audio");
      audio.setAttribute("data-peer", peerSocketId);
      audio.autoplay = true;
      audio.playsInline = true; // mobile
      // place audio element hidden (we only need playback)
      audio.style.display = "none";
      circle.appendChild(audio);
    }
    return audio;
  }

  // Start capturing mic (return MediaStream)
  async function startLocalStream() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      console.log("Got local stream");
      return stream;
    } catch (err) {
      console.error("getUserMedia failed", err);
      alert("Tidak bisa mengakses microphone. Izinkan mic dan coba lagi.");
      throw err;
    }
  }

  // Create PeerConnection for a remote peer
  function createPeerConnection(peerSocketId, remoteSlot, localStream) {
    if (peers[peerSocketId]) return peers[peerSocketId].pc;

    const pc = new RTCPeerConnection(RTC_CONFIG);

    // add local tracks
    if (localStream) {
      for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
    }

    // create audio element for playback
    const audioEl = createRemoteAudioElement(peerSocketId, remoteSlot);

    // when remote track arrives -> attach to audioEl
    pc.ontrack = (evt) => {
      // attach the first stream
      const [stream] = evt.streams;
      if (audioEl) {
        audioEl.srcObject = stream;
        // try to play (user interacted by clicking slot)
        audioEl.play().catch(e => console.warn("audio play blocked", e));
      }
    };

    // ICE candidate discovered -> send to remote via signaling
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("webrtc-ice", {
          toSocketId: peerSocketId,
          fromSocketId: socket.id,
          candidate: event.candidate
        });
      }
    };

    peers[peerSocketId] = { pc, audioEl, slot: remoteSlot };
    return pc;
  }

  // Handle incoming offer from peer
  socket.on("webrtc-offer", async ({ fromSocketId, sdp }) => {
    console.log("Received offer from", fromSocketId);

    // Find which slot belongs to that peer (scan slots)
    const remoteSlot = findSlotBySocketId(fromSocketId);
    // start local stream (if not started yet)
    if (!localStream) {
      localStream = await startLocalStream();
    }

    const pc = createPeerConnection(fromSocketId, remoteSlot, localStream);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit("webrtc-answer", {
      toSocketId: fromSocketId,
      fromSocketId: socket.id,
      sdp: pc.localDescription
    });
  });

  // Handle incoming answer from peer
  socket.on("webrtc-answer", async ({ fromSocketId, sdp }) => {
    console.log("Received answer from", fromSocketId);
    const entry = peers[fromSocketId];
    if (!entry) return console.warn("No peer entry for answer", fromSocketId);
    await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  });

  // Handle incoming ICE
  socket.on("webrtc-ice", async ({ fromSocketId, candidate }) => {
    const entry = peers[fromSocketId];
    if (!entry) {
      console.warn("ICE for unknown peer", fromSocketId);
      return;
    }
    try {
      await entry.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.warn("addIceCandidate error", e);
    }
  });

  // Utility: find slot by socketId from latest known slots (we'll track lastSlots)
  let lastSlots = {}; // slot -> user obj (contains socketId)
  function findSlotBySocketId(socketId) {
    for (const s in lastSlots) {
      const u = lastSlots[s];
      if (u && u.socketId === socketId) return Number(s);
    }
    return null;
  }

  // existing_peers: server tells newly-joined client which peers already in room
  socket.on("existing_peers", async (existing) => {
    console.log("Existing peers:", existing);
    // create local stream if not yet
    if (!localStream) {
      localStream = await startLocalStream();
    }

    // For each existing peer, create a PC and initiate offer (we are the new joiner)
    for (const p of existing) {
      const { socketId: peerSocketId, slot: peerSlot } = p;
      // create pc
      const pc = createPeerConnection(peerSocketId, peerSlot, localStream);

      // create offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // send offer to peer
      socket.emit("webrtc-offer", {
        toSocketId: peerSocketId,
        fromSocketId: socket.id,
        sdp: pc.localDescription
      });
    }
  });

  // ROOM updates and slot events
  socket.on("connect", () => {
    console.log("Connected to signaling server", socket.id);
    statusBar.innerText = "Connected";
    socket.emit("identify", myUser);
    socket.emit("get_room_state");
  });

  socket.on("room_state", ({ slots }) => {
    console.log("Room state", slots);
    lastSlots = slots || {};
    updateAllSlots(slots);
  });

  socket.on("user_joined_voice", ({ slot, user }) => {
    console.log("user_joined_voice", slot, user);
    lastSlots[slot] = user;
    updateSlotUI(slot, user);
  });

  socket.on("user_left_voice", ({ slot }) => {
    console.log("user_left_voice", slot);
    delete lastSlots[slot];
    clearSlotUI(slot);
    // cleanup any peer connected to that socketId
    // find peer with that slot:
    for (const peerId in peers) {
      if (peers[peerId].slot === Number(slot)) {
        // close pc
        try { peers[peerId].pc.close(); } catch(e){}
        // remove audio element
        if (peers[peerId].audioEl && peers[peerId].audioEl.parentNode) peers[peerId].audioEl.remove();
        delete peers[peerId];
      }
    }
  });

  socket.on("join_failed", ({ slot, reason }) => {
    alert("Join failed: " + reason);
  });

  socket.on("mic_status_changed", ({ slot, status }) => {
    // update mic icon if you have one
    const circle = document.querySelector(`#slot${slot} .circle`);
    if (circle) {
      circle.classList.toggle("mic-off", status === "off");
      circle.classList.toggle("mic-on", status === "on");
    }
  });

  // ========== UI functions ==========
  function updateAllSlots(slots) {
    for (let i = 1; i <= NUM_SLOTS; i++) clearSlotUI(i);
    for (const s in slots) updateSlotUI(s, slots[s]);
  }

  function updateSlotUI(slot, user) {
    const div = document.querySelector(`#slot${slot} .circle`);
    if (!div) return;
    div.classList.remove("empty");
    div.style.backgroundImage = `url('${user.avatar}')`;
    // label name:
    let label = div.nextElementSibling;
    if (!label || !label.classList.contains("slot-name")) {
      label = document.createElement("div");
      label.className = "slot-name";
      div.parentNode.appendChild(label);
    }
    label.innerText = user.name || "User";
  }

  function clearSlotUI(slot) {
    const div = document.querySelector(`#slot${slot} .circle`);
    if (!div) return;
    div.classList.add("empty");
    div.style.backgroundImage = "none";
    // remove label if exists
    const label = div.parentNode.querySelector(".slot-name");
    if (label) label.remove();
  }

  // ========== Slot click logic ==========
  // localStream will be initialized on demand
  let localStream = null;

  async function handleSlotClick(slot) {
    // user must interact (click) to allow autoplay later
    if (!mySlot) {
      // join: start local stream and emit join
      try {
        localStream = await startLocalStream();
      } catch (e) {
        return; // user denied
      }
      socket.emit("join_voice", { slot, user: { ...myUser, socketId: socket.id }});
      mySlot = slot;
      // after server sends existing_peers, we'll create offers
      return;
    }

    if (mySlot === slot) {
      // toggle mic: stop or resume tracks
      const enabled = localStream && localStream.getAudioTracks()[0].enabled;
      if (localStream && localStream.getAudioTracks().length > 0) {
        localStream.getAudioTracks()[0].enabled = !enabled;
        socket.emit("toggle_mic", { slot: mySlot, userId: myUser.id });
      }
      return;
    }

    // move: leave previous slot and join new slot
    socket.emit("leave_voice", { slot: mySlot, userId: myUser.id });
    socket.emit("join_voice", { slot, user: { ...myUser, socketId: socket.id }});
    mySlot = slot;
    // existing_peers event will come for the new join
  }

  // Clean up on exit (optional)
  window.addEventListener("beforeunload", () => {
    if (mySlot) socket.emit("leave_voice", { slot: mySlot, userId: myUser.id });
    socket.close();
  });
});
