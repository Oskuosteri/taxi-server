const { Server } = require("ws");
const http = require("http");

const server = http.createServer();
const wss = new Server({ server });

let drivers = []; // Lista kuljettajista
let clients = []; // Lista asiakkaista

wss.on("connection", (ws) => {
  console.log("New connection");

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === "driver_login") {
        // Kuljettajan kirjautuminen
        drivers.push({
          id: data.driverId, // Kuljettajan yksilöllinen ID
          ws: ws,
          isWorking: false, // Kuljettajan työvuoron tila
        });
        ws.send(JSON.stringify({ type: "login_success" }));
        console.log(`Driver ${data.driverId} logged in`);
      } else if (data.type === "start_shift") {
        // Aloita työvuoro
        const driver = drivers.find((d) => d.ws === ws);
        if (driver) {
          driver.isWorking = true;
          ws.send(JSON.stringify({ type: "shift_started" }));
          console.log(`Driver ${driver.id} started shift`);
        }
      } else if (data.type === "stop_shift") {
        // Lopeta työvuoro
        const driver = drivers.find((d) => d.ws === ws);
        if (driver) {
          driver.isWorking = false;
          ws.send(JSON.stringify({ type: "shift_stopped" }));
          console.log(`Driver ${driver.id} stopped shift`);
        }
      } else if (data.type === "request_taxi") {
        // Asiakas pyytää taksia
        console.log("Ride request received:", data);
        const availableDriver = drivers.find((driver) => driver.isWorking);
        if (availableDriver) {
          availableDriver.ws.send(JSON.stringify(data)); // Lähetä pyynnön kuljettajalle
        } else {
          ws.send(
            JSON.stringify({
              type: "no_drivers_available",
              message: "Ei vapaana olevia kuljettajia",
            })
          );
        }
      }
    } catch (error) {
      console.error("Invalid message format:", message);
    }
  });

  ws.on("close", () => {
    console.log("Connection closed");
    // Poista kuljettaja tai asiakas listasta
    drivers = drivers.filter((driver) => driver.ws !== ws);
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
