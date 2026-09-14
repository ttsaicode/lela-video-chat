"use strict";

/* ============================================================
   DOM ELEMENTS
   ============================================================ */

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");

const localPlaceholder = document.getElementById("localPlaceholder");
const remotePlaceholder = document.getElementById("remotePlaceholder");

const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const nextButton = document.getElementById("nextButton");
const recordButton = document.getElementById("recordButton");

const chatToggleButton = document.getElementById("chatToggleButton");
const reportButton = document.getElementById("reportButton");

const statusElement = document.getElementById("status");
const onlineCountElement = document.getElementById("onlineCountText");

const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatMessages = document.getElementById("chatMessages");
const sendChatButton = document.getElementById("sendChatButton");

const reportModalBackdrop = document.getElementById("reportModalBackdrop");
const cancelReportButton = document.getElementById("cancelReportButton");
const submitReportButton = document.getElementById("submitReportButton");

const recordingStatus = document.getElementById("recordingStatus");
const recordingTime = document.getElementById("recordingTime");

const recordingResultBackdrop = document.getElementById("recordingResultBackdrop");
const recordingResultText = document.getElementById("recordingResultText");
const recordingLocalNote = document.getElementById("recordingLocalNote");
const recordingPreview = document.getElementById("recordingPreview");
const downloadRecordingButton = document.getElementById("downloadRecordingButton");
const deleteRecordingButton = document.getElementById("deleteRecordingButton");

const broadcastBanner = document.getElementById("broadcastBanner");
const broadcastMessage = document.getElementById("broadcastMessage");
const bannedModalBackdrop = document.getElementById("bannedModalBackdrop");
const bannedReasonText = document.getElementById("bannedReasonText");


/* ============================================================
   WEBRTC CONFIGURATION
   ============================================================ */

const rtcConfiguration = {
  iceServers: [
    { urls: "stun:free.expressturn.com:3478" },
    {
      urls: [
        "turn:free.expressturn.com:3478?transport=udp",
        "turn:free.expressturn.com:3478?transport=tcp"
      ],
      username: "000000002103732653",
      credential: "rgTyOIK/8pVvQzdnm7e5jave1MA="
    }
  ],
  iceTransportPolicy: "all"
};


/* ============================================================
   STATE
   ============================================================ */

let localStream = null;
let peerConnection = null;
let socket = null;
let chatChannel = null;
let pendingIceCandidates = [];
let hasStartedCamera = false;
let isMatched = false;
let chatEnabled = true;

// Local-only encounter recording state.
let mediaRecorder = null;
let recordingChunks = [];
let recordingCanvas = null;
let recordingContext = null;
let recordingCanvasStream = null;
let recordingAnimationFrame = null;
let recordingTimer = null;
let recordingStartedAt = 0;
let recordingElapsedMs = 0;

let recordingAudioContext = null;
let recordingAudioDestination = null;
let recordingAudioSources = [];

let completedRecordingBlob = null;
let completedRecordingUrl = null;
let completedRecordingDurationSeconds = 0;

/* ============================================================
   DEBUG & STATUS
   ============================================================ */

function debug(...args) {
  console.log("[HEY]", ...args);
}

function setStatus(message) {
  if (statusElement) {
    statusElement.textContent = message;
  }
  debug(message);
}


/* ============================================================
   UI STATE HELPERS
   ============================================================ */

function updateVideoPlaceholders() {
  if (localPlaceholder) localPlaceholder.style.display = localStream ? "none" : "flex";
  if (remotePlaceholder) remotePlaceholder.style.display = remoteVideo.srcObject ? "none" : "flex";
}

function updateMatchButtons() {
  if (nextButton) nextButton.disabled = !isMatched;
  if (reportButton) reportButton.disabled = !isMatched;
  if (chatToggleButton) chatToggleButton.disabled = !isMatched;
  if (recordButton) recordButton.disabled = !isMatched;
  updateRecordButton();

  if (isMatched && chatToggleButton) {
    chatToggleButton.innerHTML = chatEnabled
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg> Chat: ON'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg> Chat: OFF';
  }
}

function updateStopButton() {
  if (stopButton) stopButton.disabled = !hasStartedCamera;
}

function applyChatState() {
  const chatPanel = document.querySelector(".chat-panel");
  if (chatPanel) {
    chatPanel.classList.toggle("chat-off", !chatEnabled);
  }
  if (chatInput) {
    chatInput.disabled = !chatEnabled;
    chatInput.placeholder = chatEnabled ? "Type a message..." : "Chat is off";
  }
}


/* ============================================================
   LOCAL-ONLY VIDEO RECORDING
   ============================================================ */

function setRecordingIndicators(show) {
  if (!recordingStatus) return;
  recordingStatus.classList.toggle("show", show);
  if (!show && recordingTime) {
    recordingTime.textContent = "00:00";
  }
}

function getRecordingElapsedSeconds() {
  let elapsed = recordingElapsedMs;
  if (mediaRecorder && mediaRecorder.state === "recording" && recordingStartedAt) {
    elapsed += Date.now() - recordingStartedAt;
  }
  return elapsed / 1000;
}

function formatRecordingTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const secs = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${secs}`;
}

function updateRecordingTimer() {
  if (!mediaRecorder) return;
  const formatted = formatRecordingTime(getRecordingElapsedSeconds());
  if (recordingTime) recordingTime.textContent = formatted;

  if (mediaRecorder.state === "recording" && recordButton) {
    recordButton.textContent = `⏹ Stop ${formatted}`;
    recordButton.classList.add("recording");
    recordButton.disabled = false;
  }
}

function updateRecordButton() {
  if (!recordButton) return;

  if (mediaRecorder && mediaRecorder.state === "recording") {
    const formatted = formatRecordingTime(getRecordingElapsedSeconds());
    recordButton.textContent = `⏹ Stop ${formatted}`;
    recordButton.classList.add("recording");
    recordButton.disabled = false;
    return;
  }

  recordButton.textContent = "🔴 Record";
  recordButton.classList.remove("recording");
  recordButton.disabled = !isMatched;
}

function chooseRecordingFormat() {
  const candidates = [
    { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", extension: "mp4" },
    { mimeType: "video/mp4", extension: "mp4" },
    { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
    { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
    { mimeType: "video/webm", extension: "webm" }
  ];

  const supported = candidates.find((item) => MediaRecorder.isTypeSupported(item.mimeType));
  return supported || { mimeType: "video/webm", extension: "webm" };
}

function drawRecordingFrame() {
  if (!recordingContext || !recordingCanvas) return;

  const width = recordingCanvas.width;
  const height = recordingCanvas.height;
  const gap = Math.max(6, Math.round(width * 0.008));
  const panelHeight = Math.floor((height - gap) / 2);

  recordingContext.fillStyle = "#080a12";
  recordingContext.fillRect(0, 0, width, height);

  drawVideoToCanvas(remoteVideo, 0, 0, width, panelHeight);
  drawVideoToCanvas(localVideo, 0, panelHeight + gap, width, height - panelHeight - gap);

  if (mediaRecorder && mediaRecorder.state === "recording") {
    recordingAnimationFrame = requestAnimationFrame(drawRecordingFrame);
  }
}

function drawVideoToCanvas(video, x, y, width, height) {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    recordingContext.fillStyle = "#121526";
    recordingContext.fillRect(x, y, width, height);
    return;
  }

  const sourceRatio = video.videoWidth / video.videoHeight;
  const targetRatio = width / height;

  let sx = 0;
  let sy = 0;
  let sw = video.videoWidth;
  let sh = video.videoHeight;

  if (sourceRatio > targetRatio) {
    sw = Math.round(video.videoHeight * targetRatio);
    sx = Math.round((video.videoWidth - sw) / 2);
  } else {
    sh = Math.round(video.videoWidth / targetRatio);
    sy = Math.round((video.videoHeight - sh) / 2);
  }

  recordingContext.drawImage(video, sx, sy, sw, sh, x, y, width, height);
}

function setupRecordingAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;

  try {
    recordingAudioContext = new AudioContextClass();
    recordingAudioDestination = recordingAudioContext.createMediaStreamDestination();
    recordingAudioSources = [];

    const addStream = (stream) => {
      if (!stream || !stream.getAudioTracks().length) return;
      try {
        const source = recordingAudioContext.createMediaStreamSource(stream);
        source.connect(recordingAudioDestination);
        recordingAudioSources.push(source);
      } catch (error) {
        console.warn("[HEY] Could not add audio source:", error);
      }
    };

    addStream(localStream);
    addStream(remoteVideo.srcObject);

    if (recordingAudioContext.state === "suspended") {
      recordingAudioContext.resume().catch(() => {});
    }

    return recordingAudioDestination.stream.getAudioTracks()[0] || null;
  } catch (error) {
    console.warn("[HEY] Could not create recording audio:", error);
    return null;
  }
}

async function startLocalRecording() {
  if (!isMatched) return;
  if (mediaRecorder && (mediaRecorder.state === "recording" || mediaRecorder.state === "paused")) return;

  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    alert("Recording is not supported by this browser.");
    return;
  }

  try {
    recordingCanvas = document.createElement("canvas");
    recordingCanvas.width = 1080;
    recordingCanvas.height = 1920;
    recordingContext = recordingCanvas.getContext("2d");

    if (!recordingContext) throw new Error("Could not create recording canvas.");

    recordingCanvasStream = recordingCanvas.captureStream(30);
    const audioTrack = setupRecordingAudio();
    if (audioTrack) recordingCanvasStream.addTrack(audioTrack);

    const recordingFormat = chooseRecordingFormat();

    try {
      mediaRecorder = new MediaRecorder(recordingCanvasStream, {
        mimeType: recordingFormat.mimeType,
        videoBitsPerSecond: 3500000
      });
    } catch (err) {
      mediaRecorder = new MediaRecorder(recordingCanvasStream, { videoBitsPerSecond: 3500000 });
    }

    recordingChunks = [];
    recordingElapsedMs = 0;
    recordingStartedAt = Date.now();

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) recordingChunks.push(event.data);
    });

    mediaRecorder.addEventListener("stop", finishLocalRecording, { once: true });
    mediaRecorder.start(500);

    setRecordingIndicators(true);
    updateRecordButton();
    sendMessage({ type: "recording-started" });
    setStatus("🔴 Recording encounter...");

    recordingTimer = setInterval(updateRecordingTimer, 250);
    drawRecordingFrame();
  } catch (error) {
    console.error("[HEY] Could not start recording:", error);
    cleanupRecordingResources();
    setRecordingIndicators(false);
    updateRecordButton();
    alert("Could not start recording on this browser.");
  }
}

function stopLocalRecording() {
  if (!mediaRecorder) return;
  if (mediaRecorder.state === "recording" && recordingStartedAt) {
    recordingElapsedMs += Date.now() - recordingStartedAt;
  }
  recordingStartedAt = 0;

  try {
    if (mediaRecorder.state === "recording") mediaRecorder.requestData();
    if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch (error) {
    finishLocalRecording();
    return;
  }

  clearInterval(recordingTimer);
  recordingTimer = null;
  setRecordingIndicators(false);
  sendMessage({ type: "recording-stopped" });
  setStatus("Finishing recording...");
}

function cleanupRecordingResources() {
  if (recordingAnimationFrame) cancelAnimationFrame(recordingAnimationFrame);
  recordingAnimationFrame = null;

  clearInterval(recordingTimer);
  recordingTimer = null;

  recordingAudioSources.forEach((src) => {
    try { src.disconnect(); } catch (e) {}
  });
  recordingAudioSources = [];

  if (recordingAudioContext) {
    try { recordingAudioContext.close(); } catch (e) {}
  }
  recordingAudioContext = null;
  recordingAudioDestination = null;
  recordingCanvasStream = null;
  recordingCanvas = null;
  recordingContext = null;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function openRecordingResult(blob, durationSeconds) {
  completedRecordingBlob = blob;
  completedRecordingDurationSeconds = Math.max(0, Math.round(durationSeconds));

  if (completedRecordingUrl) URL.revokeObjectURL(completedRecordingUrl);
  completedRecordingUrl = URL.createObjectURL(blob);

  recordingPreview.src = completedRecordingUrl;
  recordingPreview.load();

  const durationText = formatRecordingTime(completedRecordingDurationSeconds);
  const formatLabel = blob.type.includes("mp4") ? "MP4" : "WebM";

  recordingResultText.textContent = `${durationText} encounter • ${formatBytes(blob.size)} • ${formatLabel} video • created locally on this device.`;
  recordingLocalNote.innerHTML = "🔒 <strong>Not uploaded.</strong> The recording is only in this browser right now. Tap <strong>Save to device</strong> to choose where you want the video stored.";
  downloadRecordingButton.textContent = "⬇ Save to device";
  recordingResultBackdrop.classList.add("show");
  recordingPreview.muted = false;
}

async function saveCompletedRecording() {
  if (!completedRecordingBlob) return;
  const isMp4 = completedRecordingBlob.type.includes("mp4");
  const extension = isMp4 ? "mp4" : "webm";
  const mimeType = isMp4 ? "video/mp4" : "video/webm";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `hey-encounter-vertical-${timestamp}.${extension}`;

  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "Hey encounter video", accept: { [mimeType]: [`.${extension}`] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(completedRecordingBlob);
      await writable.close();
      setStatus("Recording saved to the location you selected.");
      closeAndClearRecordingResult();
      return;
    } catch (error) {
      if (error && error.name === "AbortError") return;
    }
  }

  const link = document.createElement("a");
  link.href = completedRecordingUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setStatus(`Recording downloaded as ${extension.toUpperCase()} video.`);
  window.setTimeout(closeAndClearRecordingResult, 350);
}

function clearCompletedRecordingData() {
  if (recordingPreview) {
    recordingPreview.pause();
    recordingPreview.removeAttribute("src");
    recordingPreview.load();
  }
  if (completedRecordingUrl) URL.revokeObjectURL(completedRecordingUrl);
  completedRecordingBlob = null;
  completedRecordingUrl = null;
  completedRecordingDurationSeconds = 0;
}

function closeAndClearRecordingResult() {
  clearCompletedRecordingData();
  recordingResultBackdrop.classList.remove("show");
}

function deleteCompletedRecording() {
  closeAndClearRecordingResult();
  setStatus("Recording deleted.");
}

function finishLocalRecording() {
  const recorderMimeType = mediaRecorder?.mimeType || "video/webm";
  const chunks = recordingChunks;
  recordingChunks = [];
  const durationSeconds = getRecordingElapsedSeconds();
  const blob = new Blob(chunks, { type: recorderMimeType });

  mediaRecorder = null;
  cleanupRecordingResources();
  setRecordingIndicators(false);
  recordingStartedAt = 0;
  recordingElapsedMs = 0;
  updateRecordButton();

  if (!blob.size) {
    setStatus("Recording finished, but the browser returned no video data.");
    return;
  }

  openRecordingResult(blob, durationSeconds);
  setStatus("Your encounter is ready. Preview it, save it, or delete it.");
}

/* ============================================================
   WEBSOCKET SIGNALING
   ============================================================ */

function connectToSignalingServer() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socketUrl = `${protocol}//${window.location.host}`;

  debug("Connecting to signaling server:", socketUrl);
  socket = new WebSocket(socketUrl);

  socket.addEventListener("open", () => {
    debug("Connected to signaling server");
    if (hasStartedCamera) {
      setStatus("Connected. Looking for someone...");
    }
  });

  socket.addEventListener("message", async (event) => {
    try {
      const message = JSON.parse(event.data);

      if (message.type === "online-count") {
        if (onlineCountElement) {
          const count = Number.isFinite(Number(message.count)) ? Number(message.count) : 0;
          onlineCountElement.textContent = `${count} online`;
        }
        return;
      }

      if (message.type === "banned") {
        handleBannedUser(message.reason);
        return;
      }

      if (message.type === "broadcast") {
        handleBroadcastMessage(message.text);
        return;
      }

      if (message.type === "report-received") {
        alert("Report submitted successfully. Thank you for keeping our community safe.");
        return;
      }

      await handleSignalingMessage(message);
    } catch (error) {
      console.error("[HEY] Error handling server message:", error);
    }
  });

  socket.addEventListener("close", () => {
    socket = null;
    if (hasStartedCamera) {
      setStatus("Signaling server disconnected. Please try again.");
    }
  });

  socket.addEventListener("error", (error) => {
    console.error("[HEY] WebSocket error:", error);
  });
}

function handleBannedUser(reason) {
  stopVideoChat();
  if (socket) {
    try { socket.close(); } catch (e) {}
  }
  if (bannedReasonText) {
    bannedReasonText.textContent = reason || "You have been suspended for violating community safety guidelines.";
  }
  if (bannedModalBackdrop) {
    bannedModalBackdrop.classList.add("show");
  }
}

function handleBroadcastMessage(text) {
  if (!broadcastBanner || !broadcastMessage) return;
  broadcastMessage.textContent = text;
  broadcastBanner.classList.add("show");
  setTimeout(() => {
    broadcastBanner.classList.remove("show");
  }, 10000);
}

function sendMessage(message) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

/* ============================================================
   CAMERA & WEBRTC LOGIC
   ============================================================ */

async function startCamera() {
  if (hasStartedCamera) return;

  try {
    setStatus("Requesting camera and microphone...");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });

    localStream = stream;
    localVideo.srcObject = localStream;
    hasStartedCamera = true;
    startButton.disabled = true;

    updateStopButton();
    updateVideoPlaceholders();
    connectToSignalingServer();

    if (socket && socket.readyState === WebSocket.OPEN) {
      createPeerConnection();
      sendMessage({ type: "ready" });
      setStatus("Looking for someone...");
    } else {
      setStatus("Connecting to server...");
      const waitForSocket = setInterval(() => {
        if (!hasStartedCamera) {
          clearInterval(waitForSocket);
          return;
        }
        if (socket && socket.readyState === WebSocket.OPEN) {
          clearInterval(waitForSocket);
          createPeerConnection();
          sendMessage({ type: "ready" });
          setStatus("Looking for someone...");
        }
      }, 100);
    }
  } catch (error) {
    console.error("[HEY] Camera/microphone error:", error);
    hasStartedCamera = false;
    startButton.disabled = false;
    updateStopButton();
    setStatus("Could not access camera/microphone.");
    alert("Please allow camera and microphone access to proceed.");
  }
}

function createPeerConnection() {
  if (peerConnection) {
    try { peerConnection.close(); } catch (e) {}
  }

  pendingIceCandidates = [];
  peerConnection = new RTCPeerConnection(rtcConfiguration);

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });
  }

  peerConnection.addEventListener("track", (event) => {
    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      updateVideoPlaceholders();
    }
  });

  peerConnection.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      sendMessage({ type: "ice-candidate", candidate: event.candidate });
    }
  });

  peerConnection.addEventListener("iceconnectionstatechange", () => {
    if (!peerConnection) return;
    const state = peerConnection.iceConnectionState;
    if (state === "checking") setStatus("Connecting to stranger...");
    if (state === "connected" || state === "completed") setStatus("Connected!");
    if (state === "failed") setStatus("Video connection failed.");
  });

  peerConnection.addEventListener("datachannel", (event) => {
    setupChatChannel(event.channel);
  });
}

async function createOffer() {
  if (!peerConnection) return;
  try {
    if (!chatChannel) {
      const channel = peerConnection.createDataChannel("chat");
      setupChatChannel(channel);
    }
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendMessage({ type: "offer", offer: peerConnection.localDescription });
  } catch (error) {
    console.error("[HEY] Error creating offer:", error);
  }
}

async function handleOffer(offer) {
  if (!peerConnection) createPeerConnection();
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    await processPendingIceCandidates();
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    sendMessage({ type: "answer", answer: peerConnection.localDescription });
  } catch (error) {
    console.error("[HEY] Error handling offer:", error);
  }
}

async function handleAnswer(answer) {
  if (!peerConnection) return;
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    await processPendingIceCandidates();
  } catch (error) {
    console.error("[HEY] Error handling answer:", error);
  }
}

async function handleIceCandidate(candidate) {
  if (!peerConnection) return;
  if (!peerConnection.remoteDescription || !peerConnection.remoteDescription.type) {
    pendingIceCandidates.push(candidate);
    return;
  }
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (error) {
    console.error("[HEY] Error adding candidate:", error);
  }
}

async function processPendingIceCandidates() {
  if (!peerConnection || !peerConnection.remoteDescription) return;
  const candidates = pendingIceCandidates;
  pendingIceCandidates = [];
  for (const candidate of candidates) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {}
  }
}

async function handleSignalingMessage(message) {
  switch (message.type) {
    case "waiting":
      isMatched = false;
      updateMatchButtons();
      setStatus("Waiting for a stranger...");
      break;
    case "matched":
      isMatched = true;
      chatEnabled = true;
      clearChat();
      applyChatState();

      if (!peerConnection) {
        createPeerConnection();
      }

      updateMatchButtons();
      updateRecordButton();
      setStatus("Matched! Connecting...");
      break;
    case "create-offer":
      await createOffer();
      break;
    case "offer":
      await handleOffer(message.offer);
      break;
    case "answer":
      await handleAnswer(message.answer);
      break;
    case "ice-candidate":
      await handleIceCandidate(message.candidate);
      break;
    case "peer-disconnected":
      handlePeerDisconnected();
      break;
  }
}

function handlePeerDisconnected() {
  debug("Stranger disconnected.");
  isMatched = false;
  closeChatChannel();
  clearChat();

  if (peerConnection) {
    try { peerConnection.close(); } catch (e) {}
  }
  peerConnection = null;
  pendingIceCandidates = [];
  remoteVideo.srcObject = null;

  updateVideoPlaceholders();
  updateMatchButtons();
  updateRecordButton();

  if (hasStartedCamera) {
    createPeerConnection();
    sendMessage({ type: "ready" });
    setStatus(mediaRecorder ? "Stranger left. Recording continues while finding someone new..." : "Stranger left. Looking for someone new...");
  }
}

function stopVideoChat() {
  if (mediaRecorder) stopLocalRecording();
  sendMessage({ type: "stop" });

  isMatched = false;
  updateMatchButtons();
  closeChatChannel();
  clearChat();

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      try { track.stop(); } catch (error) {}
    });
  }
  localStream = null;

  if (peerConnection) {
    try { peerConnection.close(); } catch (e) {}
  }
  peerConnection = null;
  remoteVideo.srcObject = null;
  localVideo.srcObject = null;

  hasStartedCamera = false;
  startButton.disabled = false;

  updateStopButton();
  updateVideoPlaceholders();

  if (!mediaRecorder) {
    setStatus("Stopped. Click Start Camera when ready.");
  }
}

function nextStranger() {
  if (!hasStartedCamera) return;
  sendMessage({ type: "skip" });

  isMatched = false;
  closeChatChannel();
  clearChat();

  if (peerConnection) {
    try { peerConnection.close(); } catch (e) {}
  }
  peerConnection = null;
  remoteVideo.srcObject = null;

  updateVideoPlaceholders();
  updateMatchButtons();
  updateRecordButton();
  setStatus(mediaRecorder ? "Recording continues. Looking for someone new..." : "Looking for someone new...");
}

/* ============================================================
   IN-VIDEO CHAT LOGIC
   ============================================================ */

function setupChatChannel(channel) {
  chatChannel = channel;
  chatChannel.addEventListener("open", () => {
    chatEnabled = true;
    applyChatState();
    updateMatchButtons();
  });
  chatChannel.addEventListener("close", () => {
    chatChannel = null;
  });
  chatChannel.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === "chat" && typeof message.text === "string") {
        addChatMessage(message.text, false);
      }
    } catch (e) {}
  });
}

function closeChatChannel() {
  if (chatChannel) {
    try { chatChannel.close(); } catch (e) {}
    chatChannel = null;
  }
}

function sendChatMessage() {
  if (!chatEnabled || !chatChannel || chatChannel.readyState !== "open" || chatInput.disabled) return;
  const text = chatInput.value.trim();
  if (!text) return;

  try {
    chatChannel.send(JSON.stringify({ type: "chat", text }));
    addChatMessage(text, true);
    chatInput.value = "";
  } catch (e) {}
}

function addChatMessage(text, mine) {
  const messageElement = document.createElement("div");
  messageElement.className = `chat-message ${mine ? "mine" : "theirs"}`;
  messageElement.textContent = text;
  chatMessages.appendChild(messageElement);

  requestAnimationFrame(() => {
    chatMessages.scrollTo({
      top: chatMessages.scrollHeight,
      behavior: 'smooth'
    });
  });
}

function clearChat() {
  if (chatMessages) chatMessages.innerHTML = "";
}

function toggleChat() {
  chatEnabled = !chatEnabled;
  applyChatState();
  updateMatchButtons();
}

/* ============================================================
   REPORT MODAL & HOTKEYS
   ============================================================ */

function openReportModal() {
  if (isMatched && reportModalBackdrop) reportModalBackdrop.classList.add("show");
}

function closeReportModal() {
  if (reportModalBackdrop) reportModalBackdrop.classList.remove("show");
}

function submitReport() {
  if (!isMatched) { closeReportModal(); return; }
  const selected = document.querySelector('input[name="reportReason"]:checked');
  if (!selected) {
    alert("Please select a reason for the report.");
    return;
  }

  // Send report to server to record in Supabase / Redis
  sendMessage({ type: "report", reason: selected.value });
  closeReportModal();
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && isMatched && hasStartedCamera) {
    nextStranger();
  }
});

/* ============================================================
   EVENT LISTENERS
   ============================================================ */

if (startButton) startButton.addEventListener("click", startCamera);
if (stopButton) stopButton.addEventListener("click", stopVideoChat);
if (nextButton) nextButton.addEventListener("click", nextStranger);

if (recordButton) {
  recordButton.addEventListener("click", async () => {
    if (!isMatched) return;
    if (mediaRecorder && mediaRecorder.state === "recording") {
      stopLocalRecording();
      return;
    }
    await startLocalRecording();
  });
}

if (chatToggleButton) chatToggleButton.addEventListener("click", toggleChat);
if (reportButton) reportButton.addEventListener("click", openReportModal);
if (cancelReportButton) cancelReportButton.addEventListener("click", closeReportModal);
if (submitReportButton) submitReportButton.addEventListener("click", submitReport);

if (chatForm) {
  chatForm.addEventListener("submit", (event) => {
    event.preventDefault();
    sendChatMessage();
  });
}

if (reportModalBackdrop) {
  reportModalBackdrop.addEventListener("click", (event) => {
    if (event.target === reportModalBackdrop) closeReportModal();
  });
}

if (downloadRecordingButton) downloadRecordingButton.addEventListener("click", saveCompletedRecording);
if (deleteRecordingButton) deleteRecordingButton.addEventListener("click", deleteCompletedRecording);

/* ============================================================
   INITIALIZATION
   ============================================================ */

updateMatchButtons();
updateStopButton();
updateRecordButton();
updateVideoPlaceholders();
applyChatState();
setStatus("Click Start Camera to begin");
connectToSignalingServer();
