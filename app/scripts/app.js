/**
 * Doctor Flux Pro v3d - Sidebar
 */
app.initialized().then(function (client) {
  client.data.get("ticket").then(function (data) {
    const ticket = data.ticket;
    document.getElementById("ticketInfo").textContent =
      "#" + ticket.id + " — " + (ticket.subject || "").substring(0, 50);
  });

  document.getElementById("analyzeBtn").addEventListener("click", function () {
    client.db.delete("selected_canned").catch(function () { /* ignore */ });

    client.interface.trigger("showDialog", {
      title: "Doctor Flux Pro v3d — Analisis IA",
      template: "dialog.html"
    }).then(function () {
      return client.db.get("selected_canned");
    }).then(function (data) {
      if (data && data.content) {
        return client.interface.trigger("setValue", {
          id: "editor",
          value: data.content
        });
      }
    }).then(function () {
      client.db.delete("selected_canned").catch(function () { /* ignore */ });
      updateSidebarStatus("Respuesta insertada en el editor");
    }).catch(function () { /* dialog closed without selection */ });
  });
}).catch(function (err) {
  document.getElementById("ticketInfo").textContent = "Error: " + (err.message || "desconocido");
});

function updateSidebarStatus(msg) {
  const el = document.getElementById("sidebarStatus");
  if (el) {
    el.textContent = msg;
    el.style.display = "block";
    setTimeout(function () {
      el.style.display = "none";
    }, 4000);
  }
}
