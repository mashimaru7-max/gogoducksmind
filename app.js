const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => document.querySelectorAll(selector);

const state = {
  room: null,
  playerId: crypto.randomUUID(),
  name: `오리 ${Math.floor(Math.random() * 90 + 10)}`,
  ready: false,
  round: 1,
  time: 60,
  word: "사과",
  coins: 200,
  color: "#ff738e",
  drawing: false,
  drawerId: null,
  peers: {},
  transport: null,
  connectedOnline: false,
};

let timer;
let ctx;
let strokeHistory = [];
let socket;
let channel;

function show(id) {
  $$(".screen").forEach((screen) => screen.classList.remove("active"));
  $(`#${id}`).classList.add("active");
}

function wordForRound() {
  const seed = [...String(state.room?.id || "practice")].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return CATCHMIND_WORDS[(seed + state.round - 1) % CATCHMIND_WORDS.length];
}

function getPracticeRoom() {
  return { id: "practice", name: "혼자 그리는 연습방", players: 1, max: 1, rounds: 3, practice: true };
}

function getFriendRoom(id) {
  return { id, name: `친구방 ${id.toUpperCase()}`, players: 1, max: 8, rounds: 3, practice: false };
}

function renderRooms() {
  $("#roomList").innerHTML = `
    <article class="room-card card">
      <span class="status">혼자 가능</span>
      <h3>혼자 그리는 연습방</h3>
      <p>👤 1인 · 3 라운드</p>
      <button class="outline join" data-id="practice">연습하기</button>
    </article>
    <article class="room-card card">
      <span class="status">친구 초대</span>
      <h3>새 친구방 만들기</h3>
      <p>👥 최대 8명 · 공유 링크로 입장</p>
      <button class="gold join-friends">친구방 만들기</button>
    </article>`;

  $(".join").onclick = () => {
    enterRoom("practice");
    startGame(false);
  };
  $(".join-friends").onclick = () => createFriendRoom();
}

function createRoom() {
  const id = Math.random().toString(36).slice(2, 8);
  const room = {
    id,
    name: $("#roomInput").value.trim() || "오리들의 그림 놀이터",
    players: 1,
    max: 8,
    rounds: Number($("#roundInput").value),
    practice: false,
  };
  $("#roomDialog").close();
  enterRoom(id, room);
}

function createFriendRoom() {
  const id = Math.random().toString(36).slice(2, 8);
  enterRoom(id, {
    id,
    name: "친구들과 그림 놀이터",
    players: 1,
    max: 8,
    rounds: 3,
    practice: false,
  });
}

function enterRoom(id, room = null) {
  state.room = room || (id === "practice" ? getPracticeRoom() : getFriendRoom(id));
  state.round = 1;
  state.drawerId = null;
  state.ready = false;
  state.peers = {
    [state.playerId]: { name: state.name, ready: state.ready, coins: state.coins },
  };

  $("#roomCode").textContent = state.room.id.toUpperCase();
  $("#roomName").textContent = state.room.name;
  $("#roundNum").textContent = state.round;
  $("#readyButton").textContent = "준비하기";
  window.history.replaceState({}, "", `#room=${state.room.id}`);
  $("#shareUrl").textContent = location.href;
  connect();
  renderPlayers();
  show("room");
}

function leaveRoom() {
  if (state.room) send("leave");
  clearInterval(timer);
  try {
    if (socket) socket.close();
    if (channel) channel.close();
  } catch {}
  socket = null;
  channel = null;
  state.room = null;
  state.transport = null;
  state.drawerId = null;
  state.peers = {};
  strokeHistory = [];
  window.history.replaceState({}, "", location.pathname);
  show("home");
  renderRooms();
}

function connect() {
  if (socket) socket.close();
  if (channel) channel.close();

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = `${protocol}//${location.host}/ws?room=${encodeURIComponent(state.room.id)}`;
  socket = new WebSocket(wsUrl);
  state.connectedOnline = false;

  socket.onopen = () => {
    state.connectedOnline = true;
    state.transport = "server";
    updateConnection();
    send("presence", { room: state.room });
  };

  socket.onmessage = (event) => receive(JSON.parse(event.data));

  socket.onclose = () => {
    if (state.connectedOnline) return;
    connectLocalOnly();
  };

  socket.onerror = () => {
    if (!state.connectedOnline) connectLocalOnly();
  };

  setTimeout(() => {
    if (socket?.readyState !== WebSocket.OPEN) connectLocalOnly();
  }, 600);
}

function connectLocalOnly() {
  if (state.transport === "local") return;
  try {
    if (socket) socket.close();
  } catch {}
  state.connectedOnline = false;
  state.transport = "local";
  channel = new BroadcastChannel(`duck-catchmind-${state.room.id}`);
  channel.onmessage = (event) => receive(event.data);
  updateConnection();
  send("presence", { room: state.room });
}

function updateConnection() {
  $("#connection").textContent =
    state.transport === "server"
      ? "온라인 연결 완료 · 친구는 공유 링크로 바로 들어올 수 있어요"
      : "로컬 테스트 모드 · 인터넷 친구와 하려면 서버 배포가 필요해요";
}

function send(type, data = {}) {
  const message = {
    type,
    data,
    from: state.playerId,
    name: state.name,
    ready: state.ready,
    coins: state.coins,
    roomId: state.room?.id,
  };

  if (state.transport === "server" && socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return;
  }
  channel?.postMessage(message);
}

function receive(message) {
  if (message.from === state.playerId) return;

  if (message.type === "snapshot") syncSnapshot(message.data);
  if (message.type === "presence" || message.type === "ready") {
    state.peers[message.from] = { name: message.name, ready: message.ready, coins: message.coins };
    renderPlayers();
    renderScores();
  }
  if (message.type === "leave") {
    delete state.peers[message.from];
    renderPlayers();
    renderScores();
  }
  if (message.type === "start") startGame(false, message.data.drawerId, message.data.round);
  if (message.type === "stroke") {
    drawStroke(message.data);
    strokeHistory.push(message.data);
  }
  if (message.type === "clear") clearCanvas(true);
  if (message.type === "message") addMessage(message.name, message.data.text, message.data.correct);
  if (message.type === "correct") celebrate(message.name, message.data.word, false);
}

function syncSnapshot(data) {
  if (data.room && !state.room?.practice) {
    state.room = { ...state.room, ...data.room };
    $("#roomName").textContent = state.room.name;
  }
  state.peers = {
    [state.playerId]: { name: state.name, ready: state.ready, coins: state.coins },
    ...data.peers,
  };
  renderPlayers();
  renderScores();

  if (data.inGame) {
    startGame(false, data.drawerId, data.round);
    strokeHistory = data.strokes || [];
    clearCanvas(true);
    strokeHistory.forEach(drawStroke);
  }
}

function renderPlayers() {
  const players = Object.values(state.peers || {});
  $("#players").innerHTML = players
    .map((player) => `<div class="player ${player.ready ? "ready" : ""}>🦆 ${player.name}${player.ready ? " 준비" : ""}</div>`)
    .join("");
  renderScores();
}

function startGame(broadcast = true, drawerId = state.playerId, round = 1) {
  state.drawerId = drawerId;
  state.round = round;
  state.word = wordForRound();
  $("#roundNum").textContent = state.round;

  if (broadcast) send("start", { drawerId, round: state.round });

  show("game");
  renderRole();
  setupCanvas();
  renderScores();
  clearInterval(timer);
  state.time = 60;
  $("#time").textContent = state.time;
  timer = setInterval(() => {
    state.time -= 1;
    $("#time").textContent = state.time;
    if (!state.time) {
      clearInterval(timer);
      nextRound();
    }
  }, 1000);
}

function renderRole() {
  const isDrawer = state.drawerId === state.playerId;
  $("#wordDisplay").textContent = isDrawer ? `정답: ${state.word}` : state.word.split("").map(() => "□").join(" ");
  $("#roleDuck").src = isDrawer ? "duck-drawing.png" : "duck-basic.png";
  $("#roleLabel").textContent = isDrawer
    ? "당신은 출제자예요! 정답을 보고 그림을 그려주세요."
    : "그림을 보고 정답을 맞혀보세요!";
  $("#guessInput").disabled = isDrawer;
  $("#guessInput").placeholder = isDrawer ? "출제자는 입력할 수 없어요" : "정답을 입력하세요";
  $("#guessForm button").disabled = isDrawer;
}

function nextRound(broadcast = true) {
  if (state.round >= state.room.rounds) {
    addMessage("안내", "게임이 끝났어요! 새 방에서 다시 시작해보세요.", true);
    return;
  }
  state.round += 1;
  $("#roundNum").textContent = state.round;
  state.word = wordForRound();
  renderRole();
  clearCanvas(true);
  if (broadcast) send("start", { drawerId: state.drawerId, round: state.round });
  state.time = 60;
  $("#time").textContent = state.time;
}

function setupCanvas() {
  const canvas = $("#canvas");
  ctx = canvas.getContext("2d");
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  clearCanvas(true);

  const isDrawer = state.drawerId === state.playerId;
  canvas.style.cursor = isDrawer ? "crosshair" : "not-allowed";
  canvas.onpointerdown = isDrawer
    ? (event) => {
        state.drawing = true;
        state.last = point(event);
        canvas.setPointerCapture(event.pointerId);
      }
    : null;
  canvas.onpointermove = isDrawer
    ? (event) => {
        if (!state.drawing) return;
        const nextPoint = point(event);
        const stroke = { a: state.last, b: nextPoint, color: state.color, w: Number($("#brush").value) };
        drawStroke(stroke);
        strokeHistory.push(stroke);
        send("stroke", stroke);
        state.last = nextPoint;
      }
    : null;
  canvas.onpointerup = () => {
    state.drawing = false;
  };
}

function point(event) {
  const bounds = $("#canvas").getBoundingClientRect();
  return {
    x: ((event.clientX - bounds.left) * $("#canvas").width) / bounds.width,
    y: ((event.clientY - bounds.top) * $("#canvas").height) / bounds.height,
  };
}

function drawStroke(stroke) {
  if (!ctx) return;
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.w;
  ctx.beginPath();
  ctx.moveTo(stroke.a.x, stroke.a.y);
  ctx.lineTo(stroke.b.x, stroke.b.y);
  ctx.stroke();
}

function clearCanvas(local) {
  if (!ctx) return;
  ctx.fillStyle = "#fffdf2";
  ctx.fillRect(0, 0, $("#canvas").width, $("#canvas").height);
  strokeHistory = [];
  if (!local) send("clear");
}

function renderScores() {
  if (!$("#scoreList")) return;
  const players = Object.values(state.peers || {});
  $("#scoreList").innerHTML = players
    .map((player, index) => `<div class="score-row"><span>${index === 0 ? "👑" : "🦆"} ${player.name}</span><b>${player.coins || 200} DC</b></div>`)
    .join("");
}

function addMessage(name, text, correct = false) {
  const element = document.createElement("div");
  element.className = `message ${correct ? "correct" : ""}`;
  element.textContent = `${name}: ${text}`;
  $("#messages").append(element);
  $("#messages").scrollTop = 9999;
}

function celebrate(name, word, broadcast = true) {
  clearInterval(timer);
  state.coins += 30;
  $("#coinCount").textContent = $("#gameCoin").textContent = state.coins;
  renderScores();
  $("#answerText").textContent = `${name}님이 '${word}'를 맞혔어요! +30 DC`;
  $("#answerPopup").hidden = false;
  setTimeout(() => {
    $("#answerPopup").hidden = true;
    nextRound(broadcast);
  }, 1900);
  if (broadcast) send("correct", { word });
}

$("#createRoom").onclick = () => $("#roomDialog").showModal();
$("#confirmRoom").onclick = (event) => {
  event.preventDefault();
  createRoom();
};
$("#joinCodeForm").onsubmit = (event) => {
  event.preventDefault();
  const code = $("#joinCodeInput").value.trim().replace(/^#?room=/, "");
  if (code) enterRoom(code.toLowerCase());
};
$("#startPractice").onclick = () => {
  enterRoom("practice");
  startGame(false);
};
$("#startFriends").onclick = () => createFriendRoom();
$("#readyButton").onclick = () => {
  state.ready = !state.ready;
  $("#readyButton").textContent = state.ready ? "준비 완료 ✓" : "준비하기";
  send("ready");
  renderPlayers();
};
$("#beginButton").onclick = () => startGame(true);
$$("[data-home]").forEach((button) => {
  button.onclick = () => leaveRoom();
});
$$("[data-color]").forEach((button) => {
  button.onclick = () => {
    state.color = button.dataset.color;
  };
});
$("#clear").onclick = () => clearCanvas(false);
$("#undo").onclick = () => {
  const kept = strokeHistory.slice(0, -1);
  clearCanvas(true);
  kept.forEach(drawStroke);
  strokeHistory = kept;
};
$("#guessForm").onsubmit = (event) => {
  event.preventDefault();
  const input = $("#guessInput");
  const text = input.value.trim();
  if (!text) return;
  const correct = text.replaceAll(" ", "") === state.word;
  addMessage(state.name, text, correct);
  send("message", { text, correct });
  if (correct) celebrate(state.name, state.word, true);
  input.value = "";
};
window.addEventListener("beforeunload", () => {
  if (state.room) send("leave");
});

renderRooms();
localStorage.removeItem("duckRooms");
if (location.hash.startsWith("#room=")) enterRoom(location.hash.slice(6));
