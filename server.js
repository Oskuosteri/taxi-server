require("dotenv").config();
const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const bodyParser = require("body-parser");
const multer = require("multer");
const path = require("path");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(express.json());
app.use(cors());
app.use(bodyParser.json());
app.use("/uploads", express.static("uploads")); // 🔥 Mahdollistaa kuvien näyttämisen

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
  })
  .catch((err) => {
    console.error("❌ MongoDB virhe:", err);
    process.exit(1);
  });

// ✅ Määritetään Multer tallentamaan kuvat palvelimelle
const storage = multer.diskStorage({
  destination: "./uploads/",
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname)); // Uniikki tiedostonimi
  },
});
const upload = multer({ storage: storage });

// ✅ Testireitti
app.get("/", (req, res) => {
  res.json({ message: "🚀 Tervetuloa TaxiSure API:iin" });
});

// ✅ Käyttäjä-malli (MongoDB)
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ["client", "driver"], required: true },
  name: String,
  carModel: String,
  licensePlate: String,
  profileImage: String, // Kuvan polku
  carImage: String, // Kuvan polku
});

const User = mongoose.model("User", userSchema);

// ✅ Middleware JWT-tunnistautumiseen
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  if (!authHeader) return res.status(403).json({ error: "Token puuttuu" });

  const token = authHeader.split(" ")[1];
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: "Virheellinen token" });

    req.user = decoded;
    next();
  });
};

// ✅ Kuvien lataus (POST /upload)
app.post("/upload", upload.single("image"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Kuvaa ei löytynyt" });
  }
  res.json({ success: true, imagePath: req.file.path });
});

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
      { expiresIn: "6h" } // ✅ Pidempi voimassaoloaika
    );

    res.json({ token, role: user.role });
  } catch (error) {
    console.error("❌ Kirjautumisvirhe:", error);
    res.status(500).json({ error: "Sisäinen palvelinvirhe" });
  }
});

app.post("/create-payment-intent", async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount) {
      return res.status(400).json({ error: "Määrä puuttuu" });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Stripe käyttää senttejä
      currency: "eur",
      payment_method_types: ["card"],
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error("❌ Stripe-virhe:", error);
    res.status(500).json({ error: "Maksun luonti epäonnistui" });
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
      console.log("📩 Palvelin vastaanotti viestin:", data);

      if (!data.type) {
        ws.send(
          JSON.stringify({ type: "error", message: "Viestityyppi puuttuu" })
        );
        return;
      }

      if (!data.token) {
        ws.send(
          JSON.stringify({ type: "auth_error", message: "Token puuttuu" })
        );
        return;
      }

      let decoded;
      try {
        decoded = jwt.verify(data.token, JWT_SECRET);
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "auth_error",
            message: "Virheellinen tai vanhentunut token",
          })
        );
        return;
      }

      // ✅ Kuljettajan kirjautuminen WebSocketiin
      if (data.type === "driver_login" && decoded.role === "driver") {
        drivers.push({
          id: decoded.username,
          ws,
          isWorking: false,
          token: data.token,
        });
        ws.send(JSON.stringify({ type: "login_success" }));
        console.log(`🚖 Kuljettaja ${decoded.username} kirjautui sisään.`);
      }

      // ✅ Kuljettajan työvuoron aloitus
      else if (data.type === "start_shift") {
        const driver = drivers.find((d) => d.id === decoded.username);
        if (driver) {
          driver.isWorking = true;
          ws.send(JSON.stringify({ type: "shift_started" }));
          console.log(`🟢 Kuljettaja ${decoded.username} aloitti työvuoron.`);
        }
      }

      // ✅ Kuljettajan työvuoron lopetus
      else if (data.type === "stop_shift") {
        const driver = drivers.find((d) => d.id === decoded.username);
        if (driver) {
          driver.isWorking = false;
          ws.send(JSON.stringify({ type: "shift_stopped" }));
          console.log(`🔴 Kuljettaja ${decoded.username} lopetti työvuoron.`);
        }
      }

      // ✅ Asiakkaan kyytipyynnön käsittely
      else if (data.type === "ride_request") {
        console.log("🚖 Uusi kyytipyyntö vastaanotettu palvelimella:", data);

        const availableDrivers = drivers.filter((d) => d.isWorking);
        console.log(
          `📢 Lähetetään kyytipyyntö ${availableDrivers.length} kuljettajalle`
        );

        if (availableDrivers.length === 0) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Ei vapaita kuljettajia saatavilla",
            })
          );
        } else {
          availableDrivers.forEach((driver) => {
            if (driver.ws.readyState === WebSocket.OPEN) {
              driver.ws.send(JSON.stringify(data));
            }
          });
        }
      } else if (data.type === "location_update") {
        const driver = drivers.find((d) => d.id === decoded.username);

        if (driver) {
          driver.location = {
            latitude: data.latitude,
            longitude: data.longitude,
          };
          console.log(
            `📍 Kuljettajan ${decoded.username} sijainti päivitetty:`,
            driver.location
          );

          // ✅ Lähetetään asiakkaille päivitetty sijainti
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  type: "driver_location_update",
                  driverId: decoded.username,
                  latitude: data.latitude,
                  longitude: data.longitude,
                })
              );
            }
          });
        } else {
          console.error(
            `❌ Kuljettajaa ${decoded.username} ei löydetty driver-listasta!`
          );
        }
      }

      // ✅ Kuljettajan hyväksymä kyyti
      else if (data.type === "ride_accepted") {
        console.log(`✅ Kuljettaja ${decoded.username} hyväksyi kyydin.`);

        // 🔹 Haetaan kuljettajan tiedot MongoDB:stä
        const driverData = await User.findOne({ username: decoded.username });

        if (!driverData) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Kuljettajan tietoja ei löytynyt",
            })
          );
          return;
        }

        // 🔹 Tarkistetaan, onko kuva jo täydellinen URL vai pitääkö siihen lisätä palvelimen osoite
        const isExternalUrl = (url) =>
          url.startsWith("http://") || url.startsWith("https://");

        const driverImage =
          driverData.profileImage && isExternalUrl(driverData.profileImage)
            ? driverData.profileImage // ✅ Käytä suoraan, jos se on täysi URL
            : `https://taxi-server-mnlo.onrender.com/${driverData.profileImage}`;

        const carImage =
          driverData.carImage && isExternalUrl(driverData.carImage)
            ? driverData.carImage // ✅ Käytä suoraan, jos se on täysi URL
            : `https://taxi-server-mnlo.onrender.com/${driverData.carImage}`;

        // 🔹 Lähetetään asiakkaalle hyväksyneen kuljettajan tiedot
        const rideConfirmedMessage = {
          type: "ride_confirmed",
          driverName: driverData.username,
          driverImage: driverImage, // ✅ Lähetetään oikea URL
          carImage: carImage, // ✅ Lähetetään oikea URL
          carModel: driverData.carModel || "Tuntematon auto",
          licensePlate: driverData.licensePlate || "???-???",
        };

        console.log("📡 Lähetetään asiakkaalle:", rideConfirmedMessage);

        ws.send(JSON.stringify(rideConfirmedMessage));
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(rideConfirmedMessage));
          }
        });
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

  app.post("/create-checkout-session", async (req, res) => {
    try {
      const { amount } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({ error: "Virheellinen summa" });
      }

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "eur",
              product_data: { name: "Taksi kyyti" },
              unit_amount: Math.round(amount * 100), // Stripe käyttää senttejä
            },
            quantity: 1,
          },
        ],
        success_url: "mytaxiapp://success?session_id={CHECKOUT_SESSION_ID}",
        cancel_url: "mytaxiapp://cancel",
      });

      res.json({ url: session.url });
    } catch (error) {
      console.error("❌ Stripe error:", error);
      res.status(500).json({ error: "Maksusession luonti epäonnistui" });
    }
  });

  ws.on("close", () => {
    drivers = drivers.filter((driver) => driver.ws !== ws);
  });
});

server.listen(PORT, () => console.log(`🚀 Serveri käynnissä portissa ${PORT}`));
