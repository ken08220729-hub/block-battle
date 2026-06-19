const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" }
});

let count = 0;

io.on("connection", (socket) => {

  socket.emit("update", count);

  socket.on("add", () => {
    count++;
    io.emit("update", count);
  });

});

server.listen(process.env.PORT || 3000);
