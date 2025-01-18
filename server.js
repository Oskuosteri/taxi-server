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
      const data = JSON.parse(message); // Tarkista, että viesti on kelvollista JSON:ia
      console.log("Received:", data);

      // Lähetä viesti vain, jos se on JSON-muodossa
      clients.forEach((client) => {
        if (client !== ws && client.readyState === ws.OPEN) {
          client.send(JSON.stringify(data)); // Lähetä takaisin JSON-muodossa
        }
      });
    } catch (error) {
      console.error("Invalid message format:", message); // Tulosta virheellinen viesti
      ws.send(
        JSON.stringify({ type: "error", message: "Invalid message format" })
      ); // Palauta virheilmoitus lähettäjälle
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
