require("dotenv").config();
const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");

const app = express();
app.use(express.json()); // ✅ Varmistaa, että Express voi käsitellä JSON-dataa
app.use(cors()); // ✅ Sallii kaikki pyynnöt (voit rajoittaa tarpeen mukaan)

const JWT_SECRET = process.env.JWT_SECRET || "salainen-avain";
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("❌ VIRHE: MONGO_URI puuttuu ympäristömuuttujista!");
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

// ✅ Yhdistetään MongoDB:hen
mongoose
  .connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => {
    console.log("✅ MongoDB yhteys muodostettu");

    // ✅ Käynnistetään palvelin vasta kun MongoDB on yhdistetty
    server.listen(PORT, () =>
      console.log(`🚀 Serveri käynnissä portissa ${PORT}`)
    );
  })
  .catch((err) => {
    console.error("❌ MongoDB virhe:", err);
    process.exit(1);
  });

// ✅ Testireitti varmistaaksesi, että serveri toimii
app.get("/", (req, res) => {
  res.json({ message: "🚀 Tervetuloa TaxiSure API:iin" });
});

// ✅ Käyttäjä-malli (MongoDB users-kokoelmasta)
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ["client", "driver"], required: true },
});
const User = mongoose.model("User", userSchema);

// ✅ Middleware JWT-tokenin tarkistukseen
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(403).json({ error: "Token puuttuu" });

  const token = authHeader.split(" ")[1];
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: "Virheellinen token" });

    req.user = decoded; // ✅ Tallennetaan käyttäjän tiedot req-olioon
    next();
  });
};

// ✅ Kirjautuminen (POST /login)
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "Käyttäjänimi ja salasana vaaditaan" });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ error: "Väärä käyttäjänimi tai salasana" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: "Väärä käyttäjänimi tai salasana" });
    }

    const token = jwt.sign(
      { username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    res.json({ token, role: user.role });
  } catch (error) {
    console.error("❌ Kirjautumisvirhe:", error);
    res.status(500).json({ error: "Sisäinen palvelinvirhe" });
  }
});

// ✅ Rekisteröinti (POST /register)
app.post("/register", async (req, res) => {
  try {
    const { username, password, role } = req.body;
    if (!username || !password || !role) {
      return res.status(400).json({ error: "Kaikki kentät ovat pakollisia" });
    }

    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({ error: "Käyttäjänimi varattu" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await new User({ username, password: hashedPassword, role }).save();

    res.json({ message: "Rekisteröinti onnistui" });
  } catch (error) {
    console.error("❌ Rekisteröintivirhe:", error);
    res.status(500).json({ error: "Sisäinen palvelinvirhe" });
  }
});

// ✅ WebSocket-palvelin
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
let drivers = [];

wss.on("connection", (ws) => {
  console.log("✅ WebSocket-yhteys avattu");

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);
      if (!data.type) {
        ws.send(
          JSON.stringify({ type: "error", message: "Viestityyppi puuttuu" })
        );
        return;
      }

      // ✅ Tarkistetaan token
      if (!data.token) {
        ws.send(
          JSON.stringify({ type: "auth_error", message: "Token puuttuu" })
        );
        return;
      }
      const decoded = jwt.verify(data.token, JWT_SECRET);
      if (!decoded) {
        ws.send(
          JSON.stringify({ type: "auth_error", message: "Virheellinen token" })
        );
        return;
      }

      // ✅ Käsitellään WebSocket-viestit
      if (data.type === "driver_login" && decoded.role === "driver") {
        drivers.push({ id: decoded.username, ws, isWorking: false });
        ws.send(JSON.stringify({ type: "login_success" }));
      } else if (data.type === "start_shift") {
        const driver = drivers.find((d) => d.id === decoded.username);
        if (driver) {
          driver.isWorking = true;
          ws.send(JSON.stringify({ type: "shift_started" }));
        }
      } else if (data.type === "stop_shift") {
        const driver = drivers.find((d) => d.id === decoded.username);
        if (driver) {
          driver.isWorking = false;
          ws.send(JSON.stringify({ type: "shift_stopped" }));
        }
      } else if (data.type === "driver_location") {
        console.log(
          `📍 ${decoded.username} sijainti päivitetty:`,
          data.location
        );
      } else {
        ws.send(
          JSON.stringify({ type: "error", message: "Tuntematon viesti" })
        );
      }
    } catch (error) {
      console.error("❌ WebSocket-virhe:", error);
      ws.send(
        JSON.stringify({ type: "error", message: "Virheellinen viesti" })
      );
    }
  });

  ws.on("close", () => {
    drivers = drivers.filter((driver) => driver.ws !== ws);
  });
});

// ✅ Suojattu reitti
app.get("/protected", authenticateToken, (req, res) => {
  res.json({ message: "Pääsy myönnetty, tervetuloa!", user: req.user });
});
