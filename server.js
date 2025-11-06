const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors({
  origin: "https://chic-torte-4d4c16.netlify.app/", // ton app React
  methods: ["GET", "POST"]
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "https://chic-torte-4d4c16.netlify.app/",
    methods: ["GET", "POST"]
  }
});

io.on("connection", (socket) => {
  console.log("🟢 Nouveau joueur connecté :", socket.id);

  // ✅ Rejoindre une salle
  socket.on("joinRoom", ({ username, room }) => {
    socket.join(room);
    socket.username = username;
    socket.room = room;

    console.log(`${username} a rejoint la salle ${room}`);
    socket.to(room).emit("message", `${username} a rejoint la partie.`);
  });

  // ✅ Créer une salle
  socket.on("createRoom", ({ username, room }) => {
    socket.join(room);
    socket.username = username;
    socket.room = room;

    console.log(`🎮 ${username} a créé la salle ${room}`);
    socket.emit("message", `Salon ${room} créé avec succès.`);
  });

  // ✅ Action de jeu (exemple : déplacement, réponse au quiz, etc.)
  socket.on("move", ({ room, data }) => {
    socket.to(room).emit("updateGame", data);
  });

  // ✅ Déconnexion
  socket.on("disconnect", () => {
    console.log("🔴 Joueur déconnecté :", socket.id);
    if (socket.room && socket.username) {
      socket.to(socket.room).emit("message", `${socket.username} a quitté la partie.`);
    }
  });
});

// ⚙️ Démarrer le serveur sur le bon port
server.listen(4000, () => {
  console.log("✅ Serveur Socket.IO lancé sur http://localhost:4000");
});
