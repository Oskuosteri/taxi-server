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
      const data = JSON.parse(message); // Tarkista, onko viesti JSON-muodossa
      console.log("Received:", data);
      clients.forEach((client) => {
        if (client !== ws && client.readyState === ws.OPEN) {
          client.send(JSON.stringify(data)); // Lähetä viesti takaisin JSON-muodossa
        }
      });
    } catch (error) {
      console.error("Invalid message format:", message);
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

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
