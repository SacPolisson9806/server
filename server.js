// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const sql = require("mssql");
const bcrypt = require("bcrypt");
const cors = require("cors");
const fs = require("fs");

const app = express();

// 🔹 Middleware
app.use(cors({ origin: "http://localhost:5173" })); // React
app.use(express.json());

// 🔹 Config SQL Server
const config = {
  user: "sacpolisson9806_datahubejeuxreact",
  password: "Pokemon12****",
  server: "sql.bsite.net\\MSSQL2016",
  database: "sacpolisson9806_datahubejeuxreact",
  options: { encrypt: false, trustServerCertificate: true }
};

// ------------------- Routes HTTP -------------------


// 🔹 Signup
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: "Pseudo ou mot de passe manquant" });

  try {
    const hash = await bcrypt.hash(password, 10);
    await sql.connect(config);

    const check = await sql.query`SELECT * FROM Users WHERE Username = ${username}`;
    if (check.recordset.length > 0) return res.status(400).json({ success: false, message: "Ce pseudo existe déjà !" });

    await sql.query`INSERT INTO Users (Username, PasswordHash) VALUES (${username}, ${hash})`;
    console.log("Utilisateur créé :", username);
    res.json({ success: true, message: "Compte créé !" });
  } catch (err) {
    console.error("Erreur signup :", err);
    res.status(500).json({ success: false, message: "Erreur serveur, réessaie plus tard." });
  }
});

// 🔹 Login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: "Pseudo ou mot de passe manquant" });

  try {
    await sql.connect(config);
    const result = await sql.query`SELECT * FROM Users WHERE Username = ${username}`;
    if (result.recordset.length === 0) return res.status(400).json({ success: false, message: "Pseudo inconnu." });

    const user = result.recordset[0];
    const match = await bcrypt.compare(password, user.PasswordHash);
    if (!match) return res.status(400).json({ success: false, message: "Mot de passe incorrect." });

    console.log("Connexion réussie pour :", username);
    res.json({ success: true, message: "Connexion réussie" });
  } catch (err) {
    console.error("Erreur login :", err);
    res.status(500).json({ success: false, message: "Erreur serveur, réessaie plus tard." });
  }
});

// ------------------- Serveur Socket.IO -------------------

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "http://localhost:5173", methods: ["GET", "POST"] }
});

const rooms = {}; // { roomName: [ { id, username, score, answers } ], questions }

io.on("connection", (socket) => {
  console.log("🟢 Nouveau joueur connecté :", socket.id);

  // 🔹 Rejoindre une salle
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

  // 🔹 Créer une salle
  socket.on("createRoom", ({ username, room }) => {
    socket.join(room);
    socket.username = username;
    socket.room = room;

    rooms[room] = [{ id: socket.id, username, score: 0 }];
    console.log(`🎮 ${username} a créé la salle ${room}`);

    io.to(room).emit("updatePlayers", rooms[room].map(p => p.username));
    socket.emit("message", `Salon ${room} créé avec succès.`);
  });

  // 🔹 Démarrer le jeu
  socket.on("startGame", ({ room, selectedTheme, pointsToWin, timePerQuestion }) => {
    const filePath = `./data/${selectedTheme.toLowerCase()}.json`;
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
      console.log(`📦 Jeu lancé pour la salle ${room}, thème : ${selectedTheme}`);
    } else {
      socket.emit("message", `❌ Thème "${selectedTheme}" introuvable.`);
    }
  });

  // 🔹 Réception d'une réponse
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

      io.to(room).emit("scoreUpdate", rooms[room].map(p => ({ username: p.username, score: p.score })));
      rooms[room].forEach(p => { if (p.answers) delete p.answers[questionIndex]; });
    }
  });

  // 🔹 Timeout d'une question
  socket.on("timeout", ({ room, questionIndex }) => {
    if (!rooms[room]) return;
    const correctAnswer = rooms[room].questions[questionIndex].answer;
    io.to(room).emit("showAnswer", { correctAnswer });
  });

  // 🔹 Déconnexion
  socket.on("disconnect", () => {
    console.log("🔴 Joueur déconnecté :", socket.id);
    const room = socket.room;
    if (room && rooms[room]) {
      rooms[room] = rooms[room].filter(p => p.id !== socket.id);
      io.to(room).emit("updatePlayers", rooms[room].map(p => p.username));
      socket.to(room).emit("message", `${socket.username} a quitté la partie.`);
      if (rooms[room].length === 0) delete rooms[room];
    }
  });
});

// ------------------- Démarrage serveur -------------------
const PORT = 5000;
server.listen(PORT, () => {
  console.log(`Serveur combiné démarré sur http://localhost:${PORT}`);
});

app.get("/getScore/:username/:game", async (req, res) => {
  let { username, game } = req.params;
  username = username.trim();
  game = game.trim();
  try {
    await sql.connect(config);
    const result = await sql.query`
      SELECT TOP 1 Score, DateAchieved
      FROM Scores
      WHERE Username = ${username} AND Game = ${game}
      ORDER BY DateAchieved DESC
    `;
    console.log(result.recordset.length);
    if (result.recordset.length === 0) {
      return res.json({ success: true, score: 0 });
    }
    res.json({ success: true, score: result.recordset[0].Score });
  } catch (err) {
    console.error("Erreur getScore :", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

//----------------------score-------------------------------
// 🔹 Récupérer le classement d’un jeu (meilleur score par joueur)
app.get("/scores/:game", async (req, res) => {
  const { game } = req.params;
  try {
    await sql.connect(config);
    const result = await sql.query`
      SELECT Username, MAX(Score) AS Score, MAX(DateAchieved) AS DateAchieved
      FROM Scores
      WHERE Game = ${game}
      GROUP BY Username
      ORDER BY MAX(Score) DESC
    `;
    res.json({ success: true, scores: result.recordset });
  } catch (err) {
    console.error("Erreur récupération scores :", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});


// 🔹 Ajouter un score (avec date automatique)
app.post("/scores", async (req, res) => {
  const { username, game, score } = req.body;

  if (!username || !game || score === undefined) {
    return res.status(400).json({ success: false, message: "Données manquantes" });
  }

  try {
    await sql.connect(config);
    await sql.query`
      INSERT INTO Scores (Username, Game, Score, DateAchieved)
      VALUES (${username}, ${game}, ${score}, GETDATE())
    `;
    res.json({ success: true, message: "Score enregistré !" });
  } catch (err) {
    console.error("Erreur ajout score :", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});
