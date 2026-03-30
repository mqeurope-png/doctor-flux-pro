/**
 * Doctor Flux Pro - Freshdesk Sidebar App
 * Analiza tickets con IA via Make.com webhook
 */

let CLIENT = null;
let TICKET = null;
let CONVERSATIONS = [];
let IPARAMS = null;

// ─── Init ────────────────────────────────────────────────────────
app.initialized().then(function (client) {
  CLIENT = client;
  initUI();
  loadData();
}).catch(function (err) {
  showStatus("Error al inicializar: " + err.message, "error");
});

// ─── UI Setup ────────────────────────────────────────────────────
function initUI() {
  // Collapsible sections
  document.querySelectorAll(".section-header[data-toggle]").forEach(function (header) {
    header.addEventListener("click", function () {
      const targetId = this.getAttribute("data-toggle");
      const body = document.getElementById(targetId);
      if (body) {
        this.classList.toggle("collapsed");
        body.classList.toggle("collapsed");
      }
    });
  });

  // Select all / none
  document.getElementById("selectAll").addEventListener("click", function (e) {
    e.preventDefault();
    toggleAllConversations(true);
  });

  document.getElementById("selectNone").addEventListener("click", function (e) {
    e.preventDefault();
    toggleAllConversations(false);
  });

  // Analyze button
  document.getElementById("analyzeBtn").addEventListener("click", function () {
    analyzeTicket();
  });

  // Feedback buttons
  document.getElementById("feedbackUp").addEventListener("click", function () {
    sendFeedback("positive");
  });

  document.getElementById("feedbackDown").addEventListener("click", function () {
    sendFeedback("negative");
  });
}

// ─── Load ticket + conversations ─────────────────────────────────
function loadData() {
  CLIENT.iparams.get().then(function (iparams) {
    IPARAMS = iparams;
    return CLIENT.data.get("ticket");
  }).then(function (data) {
    TICKET = data.ticket;
    document.getElementById("ticketInfo").textContent =
      "#" + TICKET.id + " — " + truncate(TICKET.subject, 50);

    const authToken = btoa(IPARAMS.freshdesk_api_key + ":X");

    // Fetch full ticket (for description_text) and conversations in parallel
    return Promise.all([
      CLIENT.request.invokeTemplate("getTicket", {
        context: { ticket_id: TICKET.id, auth_token: authToken }
      }),
      CLIENT.request.invokeTemplate("getConversations", {
        context: { ticket_id: TICKET.id, auth_token: authToken }
      })
    ]);
  }).then(function (responses) {
    const fullTicket = JSON.parse(responses[0].response);
    const convs = JSON.parse(responses[1].response);

    // Build unified list: ticket description first, then conversations
    CONVERSATIONS = [];

    // Add original ticket description as first item
    if (fullTicket.description_text) {
      CONVERSATIONS.push({
        id: "desc",
        from: fullTicket.requester_id,
        from_label: "Cliente (descripcion original)",
        body_text: fullTicket.description_text,
        created_at: fullTicket.created_at,
        is_private: false,
        is_description: true
      });
    }

    // Add conversations (exclude private notes)
    convs.forEach(function (conv) {
      if (!conv.private) {
        CONVERSATIONS.push({
          id: conv.id,
          from: conv.from_email || conv.user_id,
          from_label: conv.from_email || ("User " + conv.user_id),
          body_text: conv.body_text || stripHtml(conv.body || ""),
          created_at: conv.created_at,
          is_private: conv.private,
          is_description: false
        });
      }
    });

    renderConversations();
    document.getElementById("analyzeBtn").disabled = false;
  }).catch(function (err) {
    document.getElementById("convItems").innerHTML =
      '<div class="loading-msg" style="color:#d93025">Error al cargar: ' + escapeHtml(err.message) + '</div>';
    showStatus("No se pudieron cargar las conversaciones", "error");
  });
}

// ─── Render conversations ────────────────────────────────────────
function renderConversations() {
  const container = document.getElementById("convItems");
  document.getElementById("convCount").textContent = CONVERSATIONS.length;

  if (CONVERSATIONS.length === 0) {
    container.innerHTML = '<div class="loading-msg">No hay conversaciones publicas</div>';
    return;
  }

  let html = "";
  CONVERSATIONS.forEach(function (conv, idx) {
    const dateStr = formatDate(conv.created_at);
    const preview = truncate(conv.body_text, 150);
    const checkedAttr = ' checked';

    html += '<div class="conv-item">';
    html += '  <input type="checkbox" id="conv_' + idx + '" data-idx="' + idx + '"' + checkedAttr + '>';
    html += '  <div class="conv-body">';
    html += '    <div class="conv-meta">';
    html += '      <span class="conv-from">' + escapeHtml(conv.from_label) + '</span>';
    html += '      <span class="conv-date">' + dateStr + '</span>';
    html += '    </div>';
    if (conv.is_description) {
      html += '    <span class="conv-desc-tag">Descripcion original</span>';
    }
    html += '    <div class="conv-text">' + escapeHtml(preview) + '</div>';
    html += '  </div>';
    html += '</div>';
  });

  container.innerHTML = html;
}

function toggleAllConversations(checked) {
  document.querySelectorAll("#convItems input[type=checkbox]").forEach(function (cb) {
    cb.checked = checked;
  });
}

// ─── Analyze ticket ──────────────────────────────────────────────
function analyzeTicket() {
  const btn = document.getElementById("analyzeBtn");
  btn.disabled = true;
  btn.textContent = "Analizando...";
  btn.classList.add("loading");
  showStatus("Enviando al motor de IA, esto puede tardar unos segundos...", "info");

  // Gather selected conversations
  const selectedConvs = [];
  document.querySelectorAll("#convItems input[type=checkbox]:checked").forEach(function (cb) {
    const idx = parseInt(cb.getAttribute("data-idx"), 10);
    if (CONVERSATIONS[idx]) {
      selectedConvs.push(CONVERSATIONS[idx]);
    }
  });

  if (selectedConvs.length === 0) {
    showStatus("Selecciona al menos una conversacion para analizar", "error");
    btn.disabled = false;
    btn.textContent = "Analizar con IA";
    btn.classList.remove("loading");
    return;
  }

  const techNotes = document.getElementById("techNotes").value.trim();

  // Parse webhook URL into host + path
  const webhookUrl = IPARAMS.make_webhook_url;
  let webhookHost = "";
  let webhookPath = "/";
  try {
    const urlObj = new URL(webhookUrl);
    webhookHost = urlObj.host;
    webhookPath = urlObj.pathname + urlObj.search;
  } catch (e) {
    showStatus("URL del webhook no valida. Revisa iparams.", "error");
    btn.disabled = false;
    btn.textContent = "Analizar con IA";
    btn.classList.remove("loading");
    return;
  }

  // Build payload
  const payload = {
    ticket_id: TICKET.id,
    subject: TICKET.subject,
    requester_email: TICKET.requester_email || "",
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

  CLIENT.request.invokeTemplate("makeWebhook", {
    context: {
      webhook_host: webhookHost,
      webhook_path: webhookPath
    },
    body: JSON.stringify(payload)
  }).then(function (response) {
    btn.textContent = "Analizar con IA";
    btn.classList.remove("loading");
    btn.disabled = false;

    // Try to parse Make's response
    let result = null;
    try {
      result = JSON.parse(response.response);
    } catch (e) {
      // Make responded but not JSON — analysis was sent, note will be created
      showStatus("Analisis enviado. La nota privada se creara en el ticket.", "success");
      return;
    }

    // Show results in the app
    displayResults(result);
    showStatus("Analisis completado", "success");
  }).catch(function (err) {
    btn.textContent = "Analizar con IA";
    btn.classList.remove("loading");
    btn.disabled = false;
    showStatus("Error: " + err.message, "error");
  });
}

// ─── Display results ─────────────────────────────────────────────
function displayResults(result) {
  const section = document.getElementById("sectionResults");
  section.classList.remove("hidden");

  // Recommendation
  const recEl = document.getElementById("recommendation");
  if (result.recommendation || result.analysis || result.response) {
    recEl.textContent = result.recommendation || result.analysis || result.response;
  } else if (typeof result === "string") {
    recEl.textContent = result;
  } else {
    recEl.textContent = JSON.stringify(result, null, 2);
  }

  // Canned responses
  const cannedBlock = document.getElementById("resultCanned");
  const cannedEl = document.getElementById("cannedResponses");
  if (result.canned_responses && result.canned_responses.length > 0) {
    cannedBlock.classList.remove("hidden");
    let cannedHtml = "";
    result.canned_responses.forEach(function (cr) {
      cannedHtml += '<div class="canned-item">';
      if (cr.title) {
        cannedHtml += '<div class="canned-item-title">' + escapeHtml(cr.title) + '</div>';
      }
      if (cr.body || cr.content) {
        cannedHtml += '<div class="canned-item-body">' + escapeHtml(cr.body || cr.content) + '</div>';
      }
      cannedHtml += '</div>';
    });
    cannedEl.innerHTML = cannedHtml;
  } else {
    cannedBlock.classList.add("hidden");
  }

  // Articles
  const articlesBlock = document.getElementById("resultArticles");
  const articlesEl = document.getElementById("articles");
  if (result.articles && result.articles.length > 0) {
    articlesBlock.classList.remove("hidden");
    let artHtml = "";
    result.articles.forEach(function (art) {
      const title = art.title || art.url || "Articulo";
      const url = art.url || "#";
      artHtml += '<a class="article-item" href="' + escapeHtml(url) + '" target="_blank">' + escapeHtml(title) + '</a>';
    });
    articlesEl.innerHTML = artHtml;
  } else {
    articlesBlock.classList.add("hidden");
  }

  // Scroll to results
  section.scrollIntoView({ behavior: "smooth" });
}

// ─── Feedback ────────────────────────────────────────────────────
function sendFeedback(type) {
  const upBtn = document.getElementById("feedbackUp");
  const downBtn = document.getElementById("feedbackDown");
  const msg = document.getElementById("feedbackMsg");

  upBtn.classList.remove("selected");
  downBtn.classList.remove("selected");

  if (type === "positive") {
    upBtn.classList.add("selected");
  } else {
    downBtn.classList.add("selected");
  }

  // Parse webhook URL
  const webhookUrl = IPARAMS.make_webhook_url;
  let webhookHost = "";
  let webhookPath = "/";
  try {
    const urlObj = new URL(webhookUrl);
    webhookHost = urlObj.host;
    webhookPath = urlObj.pathname + urlObj.search;
  } catch (e) {
    return;
  }

  const payload = {
    ticket_id: TICKET.id,
    feedback: type,
    source: "doctor-flux-pro-feedback"
  };

  CLIENT.request.invokeTemplate("makeWebhook", {
    context: {
      webhook_host: webhookHost,
      webhook_path: webhookPath
    },
    body: JSON.stringify(payload)
  }).then(function () {
    msg.textContent = "Gracias por tu feedback";
  }).catch(function () {
    msg.textContent = "No se pudo enviar";
  });
}

// ─── Utilities ───────────────────────────────────────────────────
function showStatus(text, type) {
  const el = document.getElementById("statusMsg");
  el.textContent = text;
  el.className = "status-msg" + (type ? " " + type : "");
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
  } catch (e) {
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
