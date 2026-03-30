/**
 * Doctor Flux Pro - Dialog (autonomous)
 * Loads ticket data, conversations, sends to Make, shows results
 */

let TICKET_ID = null;
let CONVERSATIONS = [];

app.initialized().then(function (client) {
  loadData(client);
  bindEvents(client);
}).catch(function () {
  showStatus("Error al inicializar la app", "error");
});

// ─── Bind UI events ──────────────────────────────────────────────
function bindEvents(client) {
  document.getElementById("selectAll").addEventListener("click", function (evt) {
    evt.preventDefault();
    setAllCheckboxes(true);
  });

  document.getElementById("selectNone").addEventListener("click", function (evt) {
    evt.preventDefault();
    setAllCheckboxes(false);
  });

  document.getElementById("analyzeBtn").addEventListener("click", function () {
    analyzeTicket(client);
  });

  document.getElementById("feedbackUp").addEventListener("click", function () {
    sendFeedback(client, "positive");
  });

  document.getElementById("feedbackDown").addEventListener("click", function () {
    sendFeedback(client, "negative");
  });

  document.getElementById("closeBtn").addEventListener("click", function () {
    client.instance.close();
  });
}

// ─── Load ticket + conversations ─────────────────────────────────
function loadData(client) {
  let iparams = null;

  client.iparams.get().then(function (ip) {
    iparams = ip;
    return client.data.get("ticket");
  }).then(function (data) {
    const ticket = data.ticket;
    TICKET_ID = ticket.id;
    document.getElementById("ticketInfo").textContent =
      "#" + ticket.id + " — " + truncate(ticket.subject, 60);

    const authToken = btoa(iparams.freshdesk_api_key + ":X");

    return Promise.all([
      client.request.invokeTemplate("getTicket", {
        context: { ticket_id: ticket.id, auth_token: authToken }
      }),
      client.request.invokeTemplate("getConversations", {
        context: { ticket_id: ticket.id, auth_token: authToken }
      })
    ]);
  }).then(function (responses) {
    const fullTicket = JSON.parse(responses[0].response);
    const convs = JSON.parse(responses[1].response);

    CONVERSATIONS = [];

    if (fullTicket.description_text) {
      CONVERSATIONS.push({
        id: "desc",
        from_label: "Cliente (descripcion original)",
        body_text: fullTicket.description_text,
        created_at: fullTicket.created_at,
        is_description: true
      });
    }

    convs.forEach(function (conv) {
      if (!conv.private) {
        CONVERSATIONS.push({
          id: conv.id,
          from_label: conv.from_email || ("User " + conv.user_id),
          body_text: conv.body_text || stripHtml(conv.body || ""),
          created_at: conv.created_at,
          is_description: false
        });
      }
    });

    renderConversations();
    document.getElementById("analyzeBtn").disabled = false;
  }).catch(function (err) {
    document.getElementById("convItems").innerHTML =
      '<div class="dlg-loading" style="color:#d93025">Error: ' +
      escapeHtml(err.message || "No se pudieron cargar las conversaciones") + '</div>';
  });
}

// ─── Render conversations ────────────────────────────────────────
function renderConversations() {
  const container = document.getElementById("convItems");
  document.getElementById("convCount").textContent = CONVERSATIONS.length;

  if (CONVERSATIONS.length === 0) {
    container.innerHTML = '<div class="dlg-loading">No hay conversaciones publicas</div>';
    return;
  }

  const fragments = [];
  CONVERSATIONS.forEach(function (conv, idx) {
    const dateStr = formatDate(conv.created_at);
    const preview = truncate(conv.body_text, 200);
    const descTag = conv.is_description
      ? '<span class="dlg-conv-desc-tag">Descripcion original</span>' : "";

    fragments.push(
      '<div class="dlg-conv-item">' +
      '<input type="checkbox" id="conv_' + idx + '" data-idx="' + idx + '" checked>' +
      '<div class="dlg-conv-body">' +
      '<div class="dlg-conv-meta">' +
      '<span class="dlg-conv-from">' + escapeHtml(conv.from_label) + '</span>' +
      '<span class="dlg-conv-date">' + dateStr + '</span>' +
      '</div>' +
      descTag +
      '<div class="dlg-conv-text">' + escapeHtml(preview) + '</div>' +
      '</div></div>'
    );
  });

  container.innerHTML = fragments.join("");
}

function setAllCheckboxes(checked) {
  document.querySelectorAll("#convItems input[type=checkbox]").forEach(function (cb) {
    cb.checked = checked;
  });
}

// ─── Analyze ticket ──────────────────────────────────────────────
function analyzeTicket(client) {
  const btn = document.getElementById("analyzeBtn");
  btn.disabled = true;
  btn.textContent = "Analizando...";
  btn.classList.add("loading");
  showStatus("Enviando al motor de IA...", "info");

  const selectedConvs = getSelectedConversations();
  if (selectedConvs.length === 0) {
    showStatus("Selecciona al menos una conversacion", "error");
    resetButton(btn);
    return;
  }

  const techNotes = document.getElementById("techNotes").value.trim();

  client.iparams.get().then(function (iparams) {
    const parsed = parseWebhookUrl(iparams.make_webhook_url);
    if (!parsed) {
      showStatus("URL del webhook no valida. Revisa iparams.", "error");
      resetButton(btn);
      return;
    }

    const payload = {
      ticket_id: TICKET_ID,
      subject: document.getElementById("ticketInfo").textContent,
      tech_notes: techNotes,
      conversations: selectedConvs.map(function (conv) {
        return {
          from: conv.from_label,
          body: conv.body_text,
          date: conv.created_at,
          is_description: conv.is_description
        };
      }),
      source: "doctor-flux-pro"
    };

    return client.request.invokeTemplate("makeWebhook", {
      context: {
        webhook_host: parsed.host,
        webhook_path: parsed.path
      },
      body: JSON.stringify(payload)
    });
  }).then(function (response) {
    if (!response) return;
    resetButton(btn);

    let result = null;
    try {
      result = JSON.parse(response.response);
    } catch {
      showStatus("Analisis enviado. La nota privada se creara en el ticket.", "success");
      return;
    }

    displayResults(result);
    showStatus("Analisis completado", "success");
  }).catch(function (err) {
    resetButton(btn);
    let errMsg = "desconocido";
    if (err && err.message) {
      errMsg = err.message;
    } else if (err && err.status) {
      errMsg = "HTTP " + err.status + " - " + (err.response || "sin detalle");
    } else if (typeof err === "string") {
      errMsg = err;
    } else if (err) {
      errMsg = JSON.stringify(err);
    }
    showStatus("Error: " + errMsg, "error");
  });
}

function getSelectedConversations() {
  const selected = [];
  document.querySelectorAll("#convItems input[type=checkbox]:checked").forEach(function (cb) {
    const idx = parseInt(cb.getAttribute("data-idx"), 10);
    if (CONVERSATIONS[idx]) {
      selected.push(CONVERSATIONS[idx]);
    }
  });
  return selected;
}

function resetButton(btn) {
  btn.textContent = "Analizar con IA";
  btn.classList.remove("loading");
  btn.disabled = false;
}

// ─── Display results ─────────────────────────────────────────────
function displayResults(result) {
  document.getElementById("sectionResults").classList.remove("hidden");

  const recEl = document.getElementById("recommendation");
  recEl.textContent = result.recommendation || result.analysis || result.response ||
    (typeof result === "string" ? result : JSON.stringify(result, null, 2));

  renderCannedResponses(result);
  renderArticles(result);

  document.getElementById("sectionResults").scrollIntoView({ behavior: "smooth" });
}

function renderCannedResponses(result) {
  const block = document.getElementById("resultCanned");
  const el = document.getElementById("cannedResponses");

  if (!result.canned_responses || result.canned_responses.length === 0) {
    block.classList.add("hidden");
    return;
  }

  block.classList.remove("hidden");
  const parts = [];
  result.canned_responses.forEach(function (cr) {
    let item = '<div class="dlg-canned-item">';
    if (cr.title) {
      item += '<div class="dlg-canned-title">' + escapeHtml(cr.title) + '</div>';
    }
    if (cr.body || cr.content) {
      item += '<div class="dlg-canned-body">' + escapeHtml(cr.body || cr.content) + '</div>';
    }
    item += '</div>';
    parts.push(item);
  });
  el.innerHTML = parts.join("");
}

function renderArticles(result) {
  const block = document.getElementById("resultArticles");
  const el = document.getElementById("articles");

  if (!result.articles || result.articles.length === 0) {
    block.classList.add("hidden");
    return;
  }

  block.classList.remove("hidden");
  const parts = [];
  result.articles.forEach(function (art) {
    const title = art.title || art.url || "Articulo";
    const url = art.url || "#";
    parts.push('<a class="dlg-article-item" href="' + escapeHtml(url) + '" target="_blank">' + escapeHtml(title) + '</a>');
  });
  el.innerHTML = parts.join("");
}

// ─── Feedback ────────────────────────────────────────────────────
function sendFeedback(client, type) {
  const upBtn = document.getElementById("feedbackUp");
  const downBtn = document.getElementById("feedbackDown");

  upBtn.classList.remove("selected");
  downBtn.classList.remove("selected");

  if (type === "positive") {
    upBtn.classList.add("selected");
  } else {
    downBtn.classList.add("selected");
  }

  client.iparams.get().then(function (iparams) {
    const parsed = parseWebhookUrl(iparams.make_webhook_url);
    if (!parsed) return;

    return client.request.invokeTemplate("makeWebhook", {
      context: {
        webhook_host: parsed.host,
        webhook_path: parsed.path
      },
      body: JSON.stringify({
        ticket_id: TICKET_ID,
        feedback: type,
        source: "doctor-flux-pro-feedback"
      })
    });
  }).then(function () {
    document.getElementById("feedbackMsg").textContent = "Gracias por tu feedback";
  }).catch(function () {
    document.getElementById("feedbackMsg").textContent = "No se pudo enviar";
  });
}

// ─── Utilities ───────────────────────────────────────────────────
function parseWebhookUrl(url) {
  try {
    const urlObj = new URL(url);
    return { host: urlObj.host, path: urlObj.pathname + urlObj.search };
  } catch {
    return null;
  }
}

function showStatus(text, type) {
  const el = document.getElementById("statusMsg");
  el.textContent = text;
  el.className = "dlg-status" + (type ? " " + type : "");
}

function truncate(str, max) {
  if (!str) return "";
  return str.length > max ? str.substring(0, max) + "..." : str;
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }) +
      " " + d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return dateStr;
  }
}

function escapeHtml(str) {
  if (!str) return "";
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function stripHtml(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
}
