const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const fs = require("fs");

const app = express();
app.use(cors({
  origin: "https://chic-torte-4d4c16.netlify.app",
  methods: ["GET", "POST"]
}));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "https://chic-torte-4d4c16.netlify.app",
    methods: ["GET", "POST"]
  }
});

const rooms = {}; // { roomName: [ { id, username, score, answers } ], questions }

io.on("connection", (socket) => {
  console.log("🟢 Nouveau joueur connecté :", socket.id);

  socket.on("joinRoom", ({ username, room }) => {
    socket.join(room);
    socket.username = username;
    socket.room = room;

    if (!rooms[room]) rooms[room] = [];
    rooms[room].push({ id: socket.id, username, score: 0 });

    console.log(`${username} a rejoint la salle ${room}`);
    io.to(room).emit("updatePlayers", rooms[room].map(p => p.username));
    socket.to(room).emit("message", `${username} a rejoint la partie.`);
  });

  socket.on("createRoom", ({ username, room }) => {
    socket.join(room);
    socket.username = username;
    socket.room = room;

    rooms[room] = [{ id: socket.id, username, score: 0 }];

    console.log(`🎮 ${username} a créé la salle ${room}`);
    io.to(room).emit("updatePlayers", rooms[room].map(p => p.username));
    socket.emit("message", `Salon ${room} créé avec succès.`);
  });

  socket.on("startGame", ({ room, selectedTheme, pointsToWin, timePerQuestion }) => {
    const filePath = `./data/${selectedTheme.toLowerCase()}.json`;
    console.log(`📦 Questions chargées pour le thème ${selectedTheme}:`, questions.length);


    if (fs.existsSync(filePath)) {
      const questions = JSON.parse(fs.readFileSync(filePath));
      rooms[room].questions = questions;

      io.to(room).emit("startQuestions", {
        questions,
        selectedThemes: [selectedTheme],
        pointsToWin,
        timePerQuestion,
        room
      });

      io.to(room).emit("launchGame");
    } else {
      socket.emit("message", `❌ Thème "${selectedTheme}" introuvable.`);
    }
  });

  socket.on("submitAnswer", ({ room, username, questionIndex, answer }) => {
    if (!rooms[room]) return;
    const player = rooms[room].find(p => p.username === username);
    if (!player.answers) player.answers = {};
    player.answers[questionIndex] = answer;

    const allAnswered = rooms[room].every(p => p.answers && p.answers[questionIndex] !== undefined);
    if (allAnswered) {
      const correctAnswer = rooms[room].questions[questionIndex].answer;

      io.to(room).emit("showAnswer", { correctAnswer });

      rooms[room].forEach(p => {
        const isCorrect = Array.isArray(correctAnswer)
          ? correctAnswer.some(ans => ans.toLowerCase() === p.answers[questionIndex]?.toLowerCase())
          : correctAnswer.toLowerCase() === p.answers[questionIndex]?.toLowerCase();

        if (isCorrect) p.score += 10;
      });

      io.to(room).emit("scoreUpdate", rooms[room].map(p => ({
        username: p.username,
        score: p.score
      })));

      rooms[room].forEach(p => {
        if (p.answers) delete p.answers[questionIndex];
      });
    }
  });

  socket.on("timeout", ({ room, questionIndex }) => {
    if (!rooms[room]) return;
    const correctAnswer = rooms[room].questions[questionIndex].answer;
    io.to(room).emit("showAnswer", { correctAnswer });
  });

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

server.listen(4000, () => {
  console.log("✅ Serveur Socket.IO lancé sur http://localhost:4000");
});
