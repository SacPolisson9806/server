// server.js
/**
 * Serveur Node.js sécurisé pour site de jeux
 * Backend Express + Socket.IO + SQL Server
 * Sécurités incluses :
 * - JWT pour authentification (HTTP + Socket.IO)
 * - Middleware auth pour routes sensibles
 * - Rate limiting sur login pour éviter brute force
 * - Hashage de mots de passe avec bcrypt
 * - Validation mot de passe RGPD
 * - Comptes admin/test exemptés de certaines règles
 * - Préparation pour 2FA et renouvellement mot de passe
 */

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const sql = require("mssql");
const bcrypt = require("bcrypt");
const cors = require("cors");
const fs = require("fs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
require("dotenv").config(); // pour JWT_SECRET et DB credentials

const app = express();
const SECRET = process.env.JWT_SECRET || "super_secret_prod"; // 🔹 mettre dans .env

// ----------------- Middleware -----------------
app.use(cors({ origin: "http://localhost:5173" })); // React frontend
app.use(express.json());

// 🔹 Rate limiting sur login pour éviter brute force
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10, // max 10 tentatives
  message: { success: false, message: "Trop de tentatives, réessaie plus tard." }
});

// ----------------- Config SQL -----------------
const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  options: { encrypt: false, trustServerCertificate: true }
};

// ----------------- Helpers -----------------

/**
 * Vérifie que le mot de passe respecte les règles RGPD / bonnes pratiques :
 * - min 8 caractères
 * - majuscule, minuscule, chiffre, caractère spécial
 */
function validatePassword(password) {
  const regex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;
  return regex.test(password);
}

/**
 * Middleware pour protéger routes HTTP
 */
function authMiddleware(req, res, next) {
  const token = req.headers["authorization"]?.split(" ")[1];
  if (!token) return res.status(401).json({ success: false, message: "Token manquant" });

  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ success: false, message: "Token invalide" });
  }
}

/**
 * Vérification admin/test pour bypass règles de mot de passe
 */
async function isAdminOrTest(username) {
  await sql.connect(config);
  const result = await sql.query`SELECT IsAdmin, IsTest FROM Users WHERE Username = ${username}`;
  if (result.recordset.length === 0) return false;
  const user = result.recordset[0];
  return user.IsAdmin || user.IsTest;
}

// ----------------- Routes HTTP -----------------

// 🔹 Signup simplifié : pseudo + mot de passe
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return res.status(400).json({ success: false, message: "Pseudo ou mot de passe manquant" });

  try {
    await sql.connect(config);

    // Vérifie pseudo existant
    const checkUsername = await sql.query`SELECT * FROM Users WHERE Username = ${username}`;
    if (checkUsername.recordset.length > 0)
      return res.status(400).json({ success: false, message: "Ce pseudo existe déjà !" });

    // 🔹 Vérification mot de passe RGPD
    const skipRules = await isAdminOrTest(username);
    if (!skipRules && !validatePassword(password)) {
      return res.status(400).json({
        success: false,
        message:
          "Mot de passe non sécurisé. Il doit contenir 8+ caractères, majuscule, minuscule, chiffre et caractère spécial."
      });
    }

    // 🔹 Hash du mot de passe
    const hash = await bcrypt.hash(password, 12);

    // 🔹 Insertion dans la base
    await sql.query`INSERT INTO Users (Username, PasswordHash) VALUES (${username}, ${hash})`;

    // 🔹 Retour frontend
    console.log("Utilisateur créé :", username);
    res.json({ success: true, message: "Compte créé ! Tu peux maintenant te connecter." });
  } catch (err) {
    console.error("Erreur signup :", err);
    res.status(500).json({ success: false, message: "Erreur serveur, réessaie plus tard." });
  }
});



// 🔹 Login
app.post("/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, message: "Pseudo ou mot de passe manquant" });

  try {
    await sql.connect(config);
    const result = await sql.query`SELECT * FROM Users WHERE Username = ${username}`;
    if (result.recordset.length === 0)
      return res.status(400).json({ success: false, message: "Pseudo ou mot de passe incorrect." });

    const user = result.recordset[0];
    const match = await bcrypt.compare(password, user.PasswordHash);
    if (!match) return res.status(400).json({ success: false, message: "Pseudo ou mot de passe incorrect." });

    // 🔹 Génération token JWT avec expiration
    const token = jwt.sign({ username }, SECRET, { expiresIn: "24h" });

    console.log("Connexion réussie pour :", username);
    res.json({ success: true, message: "Connexion réussie", token });
  } catch (err) {
    console.error("Erreur login :", err);
    res.status(500).json({ success: false, message: "Erreur serveur, réessaie plus tard." });
  }
});

// ----------------- Scores -----------------
app.post("/scores", authMiddleware, async (req, res) => {
  const { username, game, score } = req.body;
  if (!username || !game || score === undefined)
    return res.status(400).json({ success: false, message: "Données manquantes" });

  if (req.user.username !== username)
    return res.status(403).json({ success: false, message: "Non autorisé" });

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

app.get("/getScore/:username/:game", authMiddleware, async (req, res) => {
  const { username, game } = req.params;
  if (req.user.username !== username)
    return res.status(403).json({ success: false, message: "Non autorisé" });

  try {
    await sql.connect(config);
    const result = await sql.query`
      SELECT TOP 1 Score, DateAchieved
      FROM Scores
      WHERE Username = ${username} AND Game = ${game}
      ORDER BY DateAchieved DESC
    `;
    res.json({ success: true, score: result.recordset[0]?.Score || 0 });
  } catch (err) {
    console.error("Erreur getScore :", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

app.get("/scores/:game", authMiddleware, async (req, res) => {
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

// ----------------- Socket.IO -----------------
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "http://localhost:5173" } });

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("Token manquant"));
  try {
    const user = jwt.verify(token, SECRET);
    socket.user = user;
    next();
  } catch {
    next(new Error("Token invalide"));
  }
});

const rooms = {};

io.on("connection", (socket) => {
  console.log("🟢 Joueur connecté :", socket.user.username);

  socket.on("joinRoom", ({ username, room }) => {
    if (username !== socket.user.username) return;
    socket.join(room);
    socket.username = username;
    socket.room = room;

    if (!rooms[room]) rooms[room] = [];
    rooms[room].push({ id: socket.id, username, score: 0 });

    io.to(room).emit("updatePlayers", rooms[room].map(p => p.username));
    socket.to(room).emit("message", `${username} a rejoint la partie.`);
  });

  // Les autres événements Socket.IO peuvent être ajoutés ici (startGame, submitAnswer, etc.)
});

// ----------------- Démarrage serveur -----------------
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Serveur sécurisé démarré sur http://localhost:${PORT}`));
