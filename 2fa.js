// 2fa.js
/**
 * Backend Node.js pour gérer la 2FA (Two-Factor Authentication)
 * 
 * Fonctionnalités :
 * - Génération d’un secret TOTP pour l’utilisateur
 * - Fournit un QR code à scanner avec Google Authenticator
 * - Vérification du code fourni par l’utilisateur
 * - Stockage du secret 2FA dans la base SQL Server
 * 
 * Notes :
 * - Nécessite npm install speakeasy qrcode
 * - Doit être utilisé avec JWT pour identifier l’utilisateur
 */

const express = require("express");
const router = express.Router();
const sql = require("mssql");
const speakeasy = require("speakeasy"); // TOTP
const QRCode = require("qrcode");       // QR code
const jwt = require("jsonwebtoken");
require("dotenv").config();

const SECRET = process.env.JWT_SECRET || "super_secret_prod";

// Middleware JWT pour protéger toutes les routes 2FA
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

// Config SQL (identique à server.js)
const config = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_NAME,
  options: { encrypt: false, trustServerCertificate: true }
};

// ----------------- Générer secret 2FA -----------------
router.post("/generate", authMiddleware, async (req, res) => {
  try {
    await sql.connect(config);

    // 🔹 Génération secret TOTP
    const secret = speakeasy.generateSecret({ length: 20, name: `MonSiteJeux (${req.user.username})` });

    // 🔹 Stocker le secret temporairement en DB (ou mettre colonne 2FASecret dans Users)
    await sql.query`
      UPDATE Users
      SET TwoFASecret = ${secret.base32}, TwoFAEnabled = 0
      WHERE Username = ${req.user.username}
    `;

    // 🔹 Générer QR code pour l’application Authenticator
    const otpauthUrl = secret.otpauth_url;
    const qrCodeDataURL = await QRCode.toDataURL(otpauthUrl);

    res.json({ success: true, qrCodeDataURL, secret: secret.base32 });
  } catch (err) {
    console.error("Erreur 2FA generate:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

// ----------------- Vérifier code 2FA -----------------
router.post("/verify", authMiddleware, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, message: "Code manquant" });

  try {
    await sql.connect(config);

    const result = await sql.query`
      SELECT TwoFASecret
      FROM Users
      WHERE Username = ${req.user.username}
    `;
    if (result.recordset.length === 0) return res.status(404).json({ success: false, message: "Utilisateur introuvable" });

    const secret = result.recordset[0].TwoFASecret;

    // 🔹 Vérifier code avec speakeasy
    const verified = speakeasy.totp.verify({
      secret,
      encoding: "base32",
      token,
      window: 1 // tolérance 1 pas de temps
    });

    if (verified) {
      // 🔹 Activer 2FA si ce n’est pas déjà fait
      await sql.query`
        UPDATE Users
        SET TwoFAEnabled = 1
        WHERE Username = ${req.user.username}
      `;
      res.json({ success: true, message: "2FA vérifiée et activée !" });
    } else {
      res.status(400).json({ success: false, message: "Code invalide" });
    }
  } catch (err) {
    console.error("Erreur 2FA verify:", err);
    res.status(500).json({ success: false, message: "Erreur serveur" });
  }
});

module.exports = router;
