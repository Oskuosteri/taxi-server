const { Server } = require("ws");
const http = require("http");

const server = http.createServer();
const wss = new Server({ server });

let clients = [];

wss.on("connection", (ws) => {
  console.log("New connection");
  clients.push(ws);

  ws.on("message", (message) => {
    console.log("Received:", message);
    clients.forEach((client) => {
      if (client !== ws && client.readyState === ws.OPEN) {
        client.send(message);
      }
    });
  });

  ws.on("close", () => {
    console.log("Connection closed");
    clients = clients.filter((client) => client !== ws);
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
