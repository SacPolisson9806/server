const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors({
  origin: "https://chic-torte-4d4c16.netlify.app", // ton app React
  methods: ["GET", "POST"]
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "https://chic-torte-4d4c16.netlify.app",
    methods: ["GET", "POST"]
  }
});

// 🧠 Structure pour stocker les joueurs par salle
const rooms = {}; // { roomName: [ { id, username } ] }

io.on("connection", (socket) => {
  console.log("🟢 Nouveau joueur connecté :", socket.id);

  // ✅ Rejoindre une salle existante
  socket.on("joinRoom", ({ username, room }) => {
    socket.join(room);
    socket.username = username;
    socket.room = room;

    if (!rooms[room]) rooms[room] = [];
    rooms[room].push({ id: socket.id, username });

    console.log(`${username} a rejoint la salle ${room}`);
    io.to(room).emit("updatePlayers", rooms[room].map(p => p.username));
    socket.to(room).emit("message", `${username} a rejoint la partie.`);
  });

  // ✅ Créer une nouvelle salle
  socket.on("createRoom", ({ username, room }) => {
    socket.join(room);
    socket.username = username;
    socket.room = room;

    rooms[room] = [{ id: socket.id, username }];

    console.log(`🎮 ${username} a créé la salle ${room}`);
    io.to(room).emit("updatePlayers", rooms[room].map(p => p.username));
    socket.emit("message", `Salon ${room} créé avec succès.`);
  });

  // ✅ Lancer le quiz
  socket.on("startGame", ({ room, selectedTheme, pointsToWin, timePerQuestion }) => {
  const fs = require("fs");
  const filePath = `./data/${selectedTheme.toLowerCase()}.json`;

  if (fs.existsSync(filePath)) {
    const questions = JSON.parse(fs.readFileSync(filePath));
    
    // ✅ Envoyer les questions à tous les joueurs
    io.to(room).emit("startQuestions", {
      questions,
      selectedThemes: [selectedTheme],
      pointsToWin,
      timePerQuestion,
      room
    });

    // ✅ Envoyer un signal de démarrage
    io.to(room).emit("launchGame");
  } else {
    socket.emit("message", `❌ Thème "${selectedTheme}" introuvable.`);
  }
});


  // ✅ Réception des réponses
  socket.on("submitAnswer", ({ room, username, questionIndex, answer }) => {
    if (!rooms[room]) return;
    const player = rooms[room].find(p => p.username === username);
    if (!player.answers) player.answers = {};
    player.answers[questionIndex] = answer;

    const allAnswered = rooms[room].every(p => p.answers && p.answers[questionIndex] !== undefined);
    if (allAnswered) {
      const correctAnswer = "TODO"; // à remplacer par la vraie réponse
      io.to(room).emit("showAnswer", { correctAnswer });

      // Mise à jour des scores (exemple simple)
      rooms[room].forEach(p => {
        if (!p.score) p.score = 0;
        if (p.answers[questionIndex] === correctAnswer) {
          p.score += 10;
        }
      });

      io.to(room).emit("scoreUpdate", rooms[room].map(p => ({
        username: p.username,
        score: p.score
      })));
    }
  });

  // ✅ Timer écoulé
  socket.on("timeout", ({ room, questionIndex }) => {
    const correctAnswer = "TODO"; // à remplacer par la vraie réponse
    io.to(room).emit("showAnswer", { correctAnswer });
  });

  // ✅ Déconnexion
  socket.on("disconnect", () => {
    console.log("🔴 Joueur déconnecté :", socket.id);
    const room = socket.room;
    if (room && rooms[room]) {
      rooms[room] = rooms[room].filter(p => p.id !== socket.id);
      io.to(room).emit("updatePlayers", rooms[room].map(p => p.username));
      socket.to(room).emit("message", `${socket.username} a quitté la partie.`);

      if (rooms[room].length === 0) {
        delete rooms[room];
      }
    }
  });
});

// 🚀 Démarrer le serveur
server.listen(4000, () => {
  console.log("✅ Serveur Socket.IO lancé sur http://localhost:4000");
});
