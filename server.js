const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const port = Number(process.env.PORT || 4173);
const root = __dirname;
const rooms = new Map();

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(root, pathname));

  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mime[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const roomId = url.searchParams.get("room") || "practice";
  const room = getRoom(roomId);
  room.clients.add(socket);
  send(socket, "snapshot", {
    peers: room.peers,
    inGame: room.inGame,
    drawerId: room.drawerId,
    round: room.round,
    strokes: room.strokes,
  });

  socket.on("data", (buffer) => {
    const text = readFrame(buffer);
    if (!text) return;
    const message = JSON.parse(text);
    remember(room, message);
    broadcast(room, socket, message);
  });

  socket.on("close", () => room.clients.delete(socket));
  socket.on("error", () => room.clients.delete(socket));
});

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients: new Set(),
      peers: {},
      inGame: false,
      drawerId: null,
      round: 1,
      strokes: [],
    });
  }
  return rooms.get(roomId);
}

function remember(room, message) {
  if (message.type === "presence" || message.type === "ready") {
    room.peers[message.from] = {
      name: message.name,
      ready: message.ready,
      coins: message.coins,
    };
  }
  if (message.type === "start") {
    room.inGame = true;
    room.drawerId = message.data.drawerId;
    room.round = message.data.round || 1;
    room.strokes = [];
  }
  if (message.type === "stroke") room.strokes.push(message.data);
  if (message.type === "clear") room.strokes = [];
}

function broadcast(room, sender, message) {
  for (const client of room.clients) {
    if (client !== sender && !client.destroyed) sendRaw(client, JSON.stringify(message));
  }
}

function send(socket, type, data) {
  sendRaw(socket, JSON.stringify({ type, data, from: "server", name: "server" }));
}

function sendRaw(socket, text) {
  const payload = Buffer.from(text);
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

function readFrame(buffer) {
  const lengthByte = buffer[1] & 0x7f;
  let offset = 2;
  let length = lengthByte;
  if (lengthByte === 126) {
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (lengthByte === 127) {
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  const mask = buffer.slice(offset, offset + 4);
  offset += 4;
  const payload = buffer.slice(offset, offset + length);
  for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  return payload.toString("utf8");
}

function getLanUrls() {
  const urls = [`http://127.0.0.1:${port}/`];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const item of interfaces || []) {
      if (item.family === "IPv4" && !item.internal) urls.push(`http://${item.address}:${port}/`);
    }
  }
  return urls;
}

server.listen(port, "0.0.0.0", () => {
  console.log("캐치마인드 서버가 열렸어요.");
  console.log("아래 주소 중 하나를 친구에게 보내면 같은 방에서 테스트할 수 있어요.");
  for (const url of getLanUrls()) console.log(url);
});
