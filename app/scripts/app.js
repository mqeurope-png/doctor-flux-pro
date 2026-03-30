/**
 * Doctor Flux Pro v3 - Sidebar
 * Opens analysis dialog, then inserts selected canned responses into editor
 */
app.initialized().then(function (client) {
  client.data.get("ticket").then(function (data) {
    const ticket = data.ticket;
    document.getElementById("ticketInfo").textContent =
      "#" + ticket.id + " — " + (ticket.subject || "").substring(0, 50);
  });

  document.getElementById("analyzeBtn").addEventListener("click", function () {
    // Clear any previous selection before opening dialog
    client.db.delete("selected_canned").catch(function () {
      // Ignore if key doesn't exist yet
    });

    client.interface.trigger("showDialog", {
      title: "Doctor Flux Pro — Analisis IA",
      template: "dialog.html"
    }).then(function () {
      // Dialog just closed — check if there are canned responses to insert
      return client.db.get("selected_canned");
    }).then(function (data) {
      if (data && data.content) {
        return client.interface.trigger("setValue", {
          id: "editor",
          value: data.content
        });
      }
    }).then(function () {
      // Clean up after inserting
      client.db.delete("selected_canned").catch(function () {});
      updateSidebarStatus("Respuesta insertada en el editor");
    }).catch(function () {
      // No canned selected or db key not found — normal close, do nothing
    });
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
