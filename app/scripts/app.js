/**
 * Doctor Flux Pro - Sidebar (minimal)
 * Solo muestra info del ticket y abre el dialog de analisis
 */
app.initialized().then(function (client) {
  client.data.get("ticket").then(function (data) {
    const ticket = data.ticket;
    document.getElementById("ticketInfo").textContent =
      "#" + ticket.id + " — " + (ticket.subject || "").substring(0, 50);
  });

  document.getElementById("analyzeBtn").addEventListener("click", function () {
    client.interface.trigger("showDialog", {
      title: "Doctor Flux Pro — Analisis IA",
      template: "dialog.html"
    });
  });
}).catch(function (err) {
  document.getElementById("ticketInfo").textContent = "Error: " + err.message;
});
