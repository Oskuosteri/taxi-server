const { Server } = require("ws");
const http = require("http");

const server = http.createServer();
const wss = new Server({ server });

let clients = [];

wss.on("connection", (ws) => {
  console.log("New connection");
  clients.push(ws);

  ws.on("message", (message) => {
    try {
      // Parsitaan viesti JSON-muotoon
      const data = JSON.parse(message.toString());
      console.log("Received:", data);

      // Lähetetään viesti takaisin kaikille muille asiakkaille JSON-muodossa
      const jsonData = JSON.stringify(data);
      clients.forEach((client) => {
        if (client !== ws && client.readyState === ws.OPEN) {
          client.send(JSON.stringify(data));
        }
      });
    } catch (error) {
      console.error("Invalid message format received:", message.toString());
    }
  });

  ws.on("close", () => {
    console.log("Connection closed");
    clients = clients.filter((client) => client !== ws);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err);
  });
});

// Käytetään Renderin määrittämää porttia
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
