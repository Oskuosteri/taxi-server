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
const activeRideRequests = new Set();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

//  git add .
//  git commit -m "Parannuksia"
//  git push origin main

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
  profileImage: String,
  carImage: String,
  carType: { type: String },
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

app.get("/available-drivers", async (req, res) => {
  console.log("📡 Haetaan saatavilla olevia kuljettajia...");
  try {
    const { latitude, longitude } = req.query;

    if (!latitude || !longitude) {
      return res.status(400).json({ error: "Sijaintitiedot puuttuvat" });
    }

    // 🔥 Käytetään muistissa olevia kuljettajia (ei MongoDB:tä)
    const driverList = Object.values(drivers);

    console.log("🔍 Palvelimella aktiiviset kuljettajat:", driverList);

    const availableDrivers = driverList
      .map((driver) => {
        if (
          !driver.location ||
          typeof driver.location.latitude !== "number" ||
          typeof driver.location.longitude !== "number"
        ) {
          console.warn(
            "⚠️ Etäisyyslaskenta epäonnistui, koordinaatit puuttuvat!"
          );
          return {
            id: driver.carType || "undefined",
            closestDriverDistance: 999999 * 1000, // Palautetaan suuri etäisyys
          };
        }

        const distance = getDistanceFromLatLonInKm(
          latitude,
          longitude,
          driver.location.latitude,
          driver.location.longitude
        );

        console.log(`🚖 ${driver.carType} kuljettajan etäisyys:`, distance);

        return {
          id: driver.carType,
          closestDriverDistance: distance * 1000, // Muutetaan metreiksi
        };
      })
      .reduce((acc, driver) => {
        if (!acc[driver.id] || driver.closestDriverDistance < acc[driver.id]) {
          acc[driver.id] = driver.closestDriverDistance;
        }
        return acc;
      }, {});

    console.log("✅ Saatavilla olevat kuljettajat:", availableDrivers);

    res.json(
      Object.entries(availableDrivers).map(
        ([carType, closestDriverDistance]) => ({
          id: carType,
          closestDriverDistance,
        })
      )
    );
  } catch (error) {
    console.error("❌ Virhe haettaessa kuljettajia:", error);
    res.status(500).json({ error: "Sisäinen palvelinvirhe" });
  }
});

const getDistanceFromLatLonInKm = (lat1, lon1, lat2, lon2) => {
  if (!lat1 || !lon1 || !lat2 || !lon2) {
    console.log("⚠️ Etäisyyslaskenta epäonnistui, koordinaatit puuttuvat!");
    return 999999; // Asetetaan suuri arvo, jotta tämä ei valita kuljettajaksi
  }

  const R = 6371; // Maapallon säde km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Etäisyys km
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

const drivers = {};

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

      const driverId = decoded.username;

      // ✅ Kuljettajan kirjautuminen WebSocketiin
      if (data.type === "driver_login" && decoded.role === "driver") {
        drivers[driverId] = {
          id: driverId,
          ws,
          isWorking: false,
          isOnline: false,
          token: data.token,
        };

        ws.send(JSON.stringify({ type: "login_success" }));
        console.log(`🚖 Kuljettaja ${driverId} kirjautui sisään.`);
      } // ✅ Kuljettajan työvuoron aloitus
      // ✅ Kuljettajan työvuoron aloitus
      else if (data.type === "start_shift") {
        const driverId = decoded.username;
        console.log(`🚖 Kuljettaja ${driverId} aloittaa työvuoron...`);

        try {
          // 🔥 Haetaan kuljettajan tiedot MongoDB:stä
          const driverData = await User.findOne({ username: driverId }).lean();

          if (!driverData) {
            console.log(`❌ Kuljettajaa ${driverId} ei löydy tietokannasta!`);
            ws.send(
              JSON.stringify({ type: "error", message: "Kuljettajaa ei löydy" })
            );
            return;
          }

          console.log(`🛠 Kuljettajan tietokanta-arvot:`, driverData);

          // 🔥 Varmistetaan, että `carType` löytyy MongoDB:stä
          const carType = driverData.carType ?? "unknown";
          console.log(`🚖 Kuljettajan auto: ${carType}`);

          // ✅ Varmistetaan, että sijainti ei ole `undefined`
          if (!data.latitude || !data.longitude) {
            console.log(`⚠️ Kuljettajan ${driverId} koordinaatit puuttuvat!`);
            ws.send(
              JSON.stringify({ type: "error", message: "Sijainti puuttuu" })
            );
            return;
          }

          // ✅ Päivitetään kuljettaja WebSocket-listaan
          drivers[driverId] = {
            id: driverId,
            ws,
            isWorking: true,
            isOnline: true,
            carType: carType, // 🔥 Nyt varmistetaan, että auton tyyppi lisätään
            location: {
              latitude: data.latitude,
              longitude: data.longitude,
            },
          };

          console.log(`✅ Kuljettaja ${driverId} on nyt aktiivinen.`);
          console.log(
            `🚖 Auto: ${carType}, 📍 Sijainti: ${data.latitude}, ${data.longitude}`
          );

          ws.send(JSON.stringify({ type: "shift_started" }));
        } catch (error) {
          console.error("❌ Virhe haettaessa kuljettajan tietoja:", error);
          ws.send(JSON.stringify({ type: "error", message: "Palvelinvirhe" }));
        }
      }

      // ✅ Kuljettajan työvuoron lopetus
      else if (data.type === "stop_shift") {
        if (drivers[driverId]) {
          drivers[driverId].isWorking = false;
          drivers[driverId].isOnline = false;
          ws.send(JSON.stringify({ type: "shift_stopped" }));
          console.log(`🔴 Kuljettaja ${driverId} lopetti työvuoron.`);
        }
      } else if (data.type === "ride_request") {
        console.log("🚖 Uusi kyytipyyntö vastaanotettu palvelimella:", data);

        if (activeRideRequests.has(data.rideId)) {
          console.log(
            "⚠️ Sama kyytipyyntö on jo lähetetty, ei lähetetä uudelleen."
          );
          return;
        }

        activeRideRequests.add(data.rideId);

        const availableDrivers = Object.values(drivers).filter(
          (d) => d.isWorking
        );

        availableDrivers.forEach((driver) => {
          if (driver.ws.readyState === WebSocket.OPEN) {
            driver.ws.send(JSON.stringify(data));
          }
        });
      } else if (data.type === "location_update") {
        const driverId = decoded.username;

        if (drivers[driverId]) {
          // ✅ Tarkistetaan, että sijainti ei ole undefined
          if (!data.latitude || !data.longitude) {
            console.error(`❌ Kuljettajan ${driverId} sijainti ei päivity!`);
            ws.send(
              JSON.stringify({
                type: "error",
                message: "Virheellinen sijainti",
              })
            );
            return;
          }

          drivers[driverId].location = {
            latitude: data.latitude,
            longitude: data.longitude,
          };

          console.log(
            `📍 Kuljettajan ${driverId} sijainti päivitetty: ${data.latitude}, ${data.longitude}`
          );

          // ✅ Lähetetään asiakkaille päivitetty sijainti
          wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.send(
                JSON.stringify({
                  type: "driver_location_update",
                  driverId: driverId,
                  latitude: data.latitude,
                  longitude: data.longitude,
                })
              );
            }
          });
        } else {
          console.error(
            `❌ Kuljettajaa ${driverId} ei löydetty WebSocket-listasta!`
          );
        }
      }

      // ✅ Kuljettajan hyväksymä kyyti
      else if (data.type === "ride_accepted") {
        console.log(`✅ Kuljettaja ${decoded.username} hyväksyi kyydin.`);

        activeRideRequests.delete(data.rideId);

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

        const isExternalUrl = (url) =>
          url && (url.startsWith("http://") || url.startsWith("https://"));

        const driverImage = driverData.driverImage
          ? isExternalUrl(driverData.driverImage)
            ? driverData.driverImage
            : `https://taxi-server-mnlo.onrender.com/${driverData.driverImage}`
          : "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcRs10cupyp3Wf-pZvdPjGQuKne14ngVZbYdDQ&s";

        const carImage = driverData.carImage
          ? isExternalUrl(driverData.carImage)
            ? driverData.carImage
            : `https://taxi-server-mnlo.onrender.com/${driverData.carImage}`
          : "https://example.com/default-car.jpg";

        const rideConfirmedMessage = {
          type: "ride_confirmed",
          driverName: driverData.username,
          driverImage: driverImage, // ✅ Nyt käyttää oikeaa kenttää
          carImage: carImage,
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
    Object.keys(drivers).forEach((driverId) => {
      if (drivers[driverId].ws === ws) {
        console.log(`🔴 Kuljettaja ${driverId} poistettiin listalta.`);
        delete drivers[driverId]; // ✅ Poistaa kuljettajan listasta
      }
    });
  });
});

server.listen(PORT, () => console.log(`🚀 Serveri käynnissä portissa ${PORT}`));
