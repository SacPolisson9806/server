/**
 * server.js (COMPLET)
 *
 * Serveur Node.js pour ton hub de jeux :
 * - Express HTTP (auth, scores, questions)
 * - Socket.IO (multijoueur synchronisé pour Quizz)
 * - Stockage SQL Server (mssql) pour Users / Scores (optionnel si pas configuré)
 * - Chargement des questions depuis `public/<theme>.json`
 *
 * IMPORTANT :
 * - Mettre les variables d'environnement dans .env : DB_USER, DB_PASSWORD, DB_SERVER, DB_NAME, JWT_SECRET
 * - Installer les dépendances : express, mssql, bcrypt, cors, socket.io, dotenv, jsonwebtoken, express-rate-limit
 *
 * Usage :
 *   node server.js
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const sql = require("mssql"); // facultatif si tu ne veux pas la DB
const bcrypt = require("bcrypt");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();
const SECRET = process.env.JWT_SECRET || "super_secret_prod";

// ----------------- Configs -----------------
const FRONTEND_ORIGINS = [
  "https://chic-torte-4d4c16.netlify.app",
  "http://localhost:5173",
  "http://localhost:3000"
];

// CORS
app.use(cors({
  origin: (origin, cb) => {
    // allow if no origin (curl/postman) or in whitelist
    if (!origin || FRONTEND_ORIGINS.includes(origin)) cb(null, true);
    else cb(new Error("Origin non autorisée"));
  },
  credentials: true
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // sert les JSON/questions statiques

// Rate limiter login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  message: { success: false, message: "Trop de tentatives, réessaie plus tard." }
});

// ----------------- SQL config (optionnel) -----------------
const dbConfig = {
  user: process.env.DB_USER || null,
  password: process.env.DB_PASSWORD || null,
  server: process.env.DB_SERVER || null,
  database: process.env.DB_NAME || null,
  options: { encrypt: false, trustServerCertificate: true }
};

// Utilitaire pour tenter connexion SQL (silencieux si non configuré)
async function trySqlConnect() {
  if (!dbConfig.user) return false;
  try {
    await sql.connect(dbConfig);
    return true;
  } catch (err) {
    console.warn("SQL non connecté :", err.message || err);
    return false;
  }
}

// ----------------- Helpers -----------------
function validatePassword(password) {
  const regex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;
  return regex.test(password);
}

function createJwt(username) {
  return jwt.sign({ username }, SECRET, { expiresIn: "30d" });
}

function verifyJwt(token) {
  return jwt.verify(token, SECRET);
}

function authMiddleware(req, res, next) {
  const auth = req.headers["authorization"];
  const token = auth?.split?.(" ")[1];
  if (!token) return res.status(401).json({ success: false, message: "Token manquant" });

  try {
    const decoded = verifyJwt(token);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Token invalide" });
  }
}

// ----------------- Routes HTTP : Auth -----------------

// Signup (simplifié) - rate limité
app.post("/signup", loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: "Pseudo/mot de passe manquant" });

  // Si SQL configuré, insérer en DB. Sinon on renvoie succès (dev mode)
  const hasSql = await trySqlConnect();
  if (!hasSql) {
    // Dev fallback : aucune persistance
    return res.json({ success: true, message: "Compte simulé créé (mode dev, SQL non configuré)." });
  }

  try {
    // Vérifier existant
    const check = await sql.query`SELECT Id FROM Users WHERE Username = ${username}`;
    if (check.recordset.length > 0) return res.status(400).json({ success: false, message: "Pseudo existant" });

    if (!validatePassword(password))
      return res.status(400).json({ success: false, message: "Mot de passe non sécurisé (min8, maj, min, chiffre, special)" });

    const hash = await bcrypt.hash(password, 12);
    await sql.query`INSERT INTO Users (Username, PasswordHash) VALUES (${username}, ${hash})`;

    return res.json({ success: true, message: "Compte créé" });
  } catch (err) {
    console.error("Signup error:", err);
    return res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

// Login
app.post("/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: "Pseudo/mot de passe manquant" });

  const hasSql = await trySqlConnect();
  if (!hasSql) {
    // Mode dev : accepte n'importe quoi, renvoie token (pratique pour dev local)
    const token = createJwt(username);
    return res.json({ success: true, message: "Connexion (mode dev)", token });
  }

  try {
    const result = await sql.query`SELECT Username, PasswordHash FROM Users WHERE Username = ${username}`;
    if (result.recordset.length === 0) return res.status(400).json({ success: false, message: "Utilisateur introuvable" });

    const user = result.recordset[0];
    const match = await bcrypt.compare(password, user.PasswordHash);
    if (!match) return res.status(400).json({ success: false, message: "Mot de passe incorrect" });

    const token = createJwt(user.Username);
    res.json({ success: true, message: "Connexion réussie", token });

  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

// ----------------- Routes HTTP : Scores, questions -----------------

// Enregistrer score (protégé)
app.post("/scores", authMiddleware, async (req, res) => {
  const { username, game, score } = req.body;
  if (!username || !game || typeof score !== "number") return res.status(400).json({ success: false, message: "Données manquantes" });
  if (req.user.username !== username) return res.status(403).json({ success: false, message: "Non autorisé" });

  const hasSql = await trySqlConnect();
  if (!hasSql) return res.json({ success: true, message: "Score simulé (dev mode)" });

  try {
    await sql.query`INSERT INTO Scores (Username, Game, Score, DateAchieved) VALUES (${username}, ${game}, ${score}, GETDATE())`;
    res.json({ success: true });
  } catch (err) {
    console.error("Scores insert error:", err);
    res.status(500).json({ success: false });
  }
});

// Récupérer questions par thème (sert les fichiers du dossier public/)
// Ex: GET /questions/minecraft
app.get("/questions/:theme", (req, res) => {
  const theme = req.params.theme || "minecraft";
  const filePath = path.join(__dirname, "public", `${theme.toLowerCase()}.json`);
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      return res.status(404).json({ success: false, message: "Thème introuvable" });
    }
    try {
      const parsed = JSON.parse(data);
      return res.json({ success: true, questions: parsed });
    } catch (e) {
      return res.status(500).json({ success: false, message: "Erreur lecture fichier" });
    }
  });
});

// Petite route healthcheck
app.get("/health", (req, res) => res.json({ success: true, uptime: process.uptime() }));

// ----------------- Socket.IO - Quizz Multijoueur -----------------
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: FRONTEND_ORIGINS,
    methods: ["GET", "POST"],
    credentials: true,
    allowedHeaders: ["Authorization"]
  }
});


// Middleware socket pour vérifier token JWT (optionnel mais recommandé)
io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Token manquant"));
    const user = verifyJwt(token);
    socket.user = user; // { username }
    next();
  } catch (err) {
    next(new Error("Token invalide"));
  }
});

// Stockage en mémoire des salons (simple). Pour prod, utiliser Redis.
const rooms = {};

/**
 * Structure d'une room :
 * rooms[roomName] = {
 *   host: 'username',
 *   players: [{ username, score }],
 *   questions: [ ... ],
 *   index: 0,
 *   pointsToWin: 100,
 *   timePerQuestion: 30
 * }
 */

io.on("connection", (socket) => {
  const username = socket.user?.username || `guest_${socket.id.slice(0,5)}`;
  console.log(`Socket connecté : ${username} (${socket.id})`);

  // Create room (emité par créateur)
  socket.on("createRoom", ({ room }) => {
    if (!room) return socket.emit("errorMsg", "Room invalide");
    socket.join(room);
    socket.room = room;
    socket.username = username;

    rooms[room] = rooms[room] || {};
    rooms[room].host = username;
    rooms[room].players = [{ username, score: 0 }];
    rooms[room].questions = [];
    rooms[room].index = 0;

    io.to(room).emit("updatePlayers", rooms[room].players.map(p => p.username));
    socket.emit("created", { room });
    console.log(`${username} a créé la room ${room}`);
  });

  // Join room
  socket.on("joinRoom", ({ room }) => {
    if (!room) return socket.emit("errorMsg", "Room invalide");
    socket.join(room);
    socket.room = room;
    socket.username = username;

    rooms[room] = rooms[room] || { players: [], questions: [], index: 0 };
    // si déjà présent, éviter doublons
    if (!rooms[room].players.find(p => p.username === username)) {
      rooms[room].players.push({ username, score: 0 });
    }

    io.to(room).emit("updatePlayers", rooms[room].players.map(p => p.username));
    console.log(`${username} a rejoint ${room}`);
  });

  // Start game (host only) - payload : { room, theme, pointsToWin, timePerQuestion }
  socket.on("startGame", async ({ room, theme = "minecraft", pointsToWin = 100, timePerQuestion = 30 }) => {
    const r = rooms[room];
    if (!r) return socket.emit("errorMsg", "Room introuvable");
    if (r.host !== username) return socket.emit("errorMsg", "Seul le créateur peut lancer");

    // Charge questions depuis public/<theme>.json
    const filePath = path.join(__dirname, "public", `${theme.toLowerCase()}.json`);
    let questions = [];
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      questions = JSON.parse(raw);
    } catch (err) {
      console.error("Erreur load questions:", err);
      socket.emit("errorMsg", "Impossible de charger les questions");
      return;
    }

    // Initialisation de la room
    r.questions = questions;
    r.index = 0;
    r.pointsToWin = pointsToWin;
    r.timePerQuestion = timePerQuestion;

    // Notifier tous les joueurs
    io.to(room).emit("launchGame", { room, pointsToWin, timePerQuestion, totalQuestions: questions.length });
    // Envoyer le premier lot de questions (ou la totalité selon ton design)
    io.to(room).emit("startQuestions", { questions: questions }); // client gère la pagination
    console.log(`Partie lancée dans ${room} (theme=${theme})`);
  });

  // joinGame (utilisé par startquizzmulti pour s'inscrire côté serveur)
  socket.on("joinGame", ({ room, username: providedName }) => {
    // déjà implémenté via joinRoom, on peut accepter les deux
    const r = rooms[room];
    if (!r) return socket.emit("errorMsg", "Room introuvable");
    if (!r.players.find(p => p.username === username))
      r.players.push({ username, score: 0 });
    io.to(room).emit("updatePlayers", r.players.map(p => p.username));
  });

  // submitAnswer
  socket.on("submitAnswer", ({ room, questionIndex, answer }) => {
    const r = rooms[room];
    if (!r) return;
    const q = r.questions?.[questionIndex];
    if (!q) {
      socket.emit("errorMsg", "Question introuvable");
      return;
    }

    // Vérifier la réponse (q.answer peut être string ou array)
    const correct = Array.isArray(q.answer) ? q.answer.includes(answer) : q.answer === answer;

    if (correct) {
      const player = r.players.find(p => p.username === username);
      if (player) {
        player.score = (player.score || 0) + (q.points || 10); // q.points facultatif
      }
    }

    // Mettre à jour scores pour tous
    io.to(room).emit("scoreUpdate", r.players);

    // Indiquer la bonne réponse à tous
    io.to(room).emit("showAnswer", { questionIndex, correctAnswer: q.answer, by: username });
  });

  // timeout (le client notifie quand le chrono est expiré)
  socket.on("timeout", ({ room, questionIndex }) => {
    const r = rooms[room];
    if (!r) return;
    const q = r.questions?.[questionIndex];
    if (!q) return;
    io.to(room).emit("showAnswer", { questionIndex, correctAnswer: q.answer, by: null });
  });

  // Déconnexion : retirer de la room
  socket.on("disconnect", () => {
    const rName = socket.room;
    if (!rName || !rooms[rName]) return;
    const r = rooms[rName];
    r.players = r.players.filter(p => p.username !== username);
    io.to(rName).emit("updatePlayers", r.players.map(p => p.username));
    console.log(`${username} déconnecté de ${rName}`);

    // Si plus personne, cleanup
    if (r.players.length === 0) {
      delete rooms[rName];
      console.log(`Room ${rName} supprimée (vide)`);
    } else {
      // si host parti, choisir un nouveau host
      if (r.host === username) {
        r.host = r.players[0].username;
        io.to(rName).emit("hostChanged", { host: r.host });
      }
    }
  });

});

// ----------------- Démarrage -----------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT} (PORT ${PORT})`);
});
