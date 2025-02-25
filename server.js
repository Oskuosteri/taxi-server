require("dotenv").config();
const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const bodyParser = require("body-parser");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(express.json());
app.use(cors());
app.use(bodyParser.json());

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

// ✅ Testireitti
app.get("/", (req, res) => {
  res.json({ message: "🚀 Tervetuloa TaxiSure API:iin" });
});

// ✅ Käyttäjä-malli (MongoDB)
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  role: { type: String, enum: ["client", "driver"], required: true },
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
      }

      // ✅ Kuljettajan hyväksymä kyyti
      else if (data.type === "ride_accepted") {
        console.log(`✅ Kuljettaja ${decoded.username} hyväksyi kyydin.`);

        const driver = drivers.find((d) => d.id === decoded.username);
        if (!driver) {
          ws.send(
            JSON.stringify({ type: "error", message: "Kuljettajaa ei löydy" })
          );
          return;
        }

        if (!driver.token) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Kuljettajan token puuttuu",
            })
          );
          return;
        }

        ws.send(
          JSON.stringify({
            type: "ride_confirmed",
            message: "Kuljettaja on matkalla!",
          })
        );

        // 🔹 Lähetetään hyväksymisilmoitus asiakassovellukselle
        wss.clients.forEach((client) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(
              JSON.stringify({
                type: "ride_confirmed",
                message: `Kuljettaja ${decoded.username} on matkalla!`,
              })
            );
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

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "eur",
              product_data: { name: "Taksimatka" },
              unit_amount: Math.round(amount * 100), // Centteinä
            },
            quantity: 1,
          },
        ],
        success_url: "https://yourapp.com/success",
        cancel_url: "https://yourapp.com/cancel",
      });

      res.json({ id: session.id });
    } catch (error) {
      console.error("Stripe error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  ws.on("close", () => {
    drivers = drivers.filter((driver) => driver.ws !== ws);
  });
});

server.listen(PORT, () => console.log(`🚀 Serveri käynnissä portissa ${PORT}`));
