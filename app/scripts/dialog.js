/**
 * Doctor Flux Pro v3 - Dialog (autonomous)
 * Loads ticket data, conversations, sends to Make, shows results,
 * fetches real canned responses from Freshdesk, allows inserting into editor.
 */

let TICKET_ID = null;
let CONVERSATIONS = [];
let AUTH_TOKEN = null;

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

  document.getElementById("insertCloseBtn").addEventListener("click", function () {
    insertAndClose(client);
  });
}

// ─── Load ticket + conversations ─────────────────────────────────
function loadData(client) {
  let iparams = null;

  client.iparams.get().then(function (ip) {
    iparams = ip;
    AUTH_TOKEN = btoa(ip.freshdesk_api_key + ":X");
    return client.data.get("ticket");
  }).then(function (data) {
    const ticket = data.ticket;
    TICKET_ID = ticket.id;
    document.getElementById("ticketInfo").textContent =
      "#" + ticket.id + " — " + truncate(ticket.subject, 60);

    return Promise.all([
      client.request.invokeTemplate("getTicket", {
        context: { ticket_id: ticket.id, auth_token: AUTH_TOKEN }
      }),
      client.request.invokeTemplate("getConversations", {
        context: { ticket_id: ticket.id, auth_token: AUTH_TOKEN }
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

  client.request.invokeTemplate("makeWebhook", {
    body: JSON.stringify(payload)
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

    displayResults(result, client);
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
function displayResults(result, client) {
  document.getElementById("sectionResults").classList.remove("hidden");

  const recEl = document.getElementById("recommendation");
  recEl.textContent = result.recommendation || result.analysis || result.response ||
    (typeof result === "string" ? result : JSON.stringify(result, null, 2));

  renderArticles(result);

  // Fetch real canned responses from Freshdesk based on titles from AI
  if (result.canned_responses && result.canned_responses.length > 0) {
    const titles = result.canned_responses.map(function (cr) {
      return typeof cr === "string" ? cr : (cr.title || "");
    }).filter(function (t) { return t.length > 0; });

    if (titles.length > 0) {
      fetchAndMatchCanned(client, titles);
    } else {
      document.getElementById("resultCanned").classList.add("hidden");
    }
  } else {
    document.getElementById("resultCanned").classList.add("hidden");
  }

  document.getElementById("sectionResults").scrollIntoView({ behavior: "smooth" });
}

// ─── Fetch ALL canned responses from Freshdesk ──────────────────
function fetchAndMatchCanned(client, suggestedTitles) {
  const block = document.getElementById("resultCanned");
  const el = document.getElementById("cannedResponses");
  block.classList.remove("hidden");
  el.innerHTML = '<div class="dlg-loading">Buscando respuestas en Freshdesk...</div>';

  fetchAllCannedPages(client, 1, []).then(function (allCanned) {
    const matched = matchCannedByTitle(allCanned, suggestedTitles);

    if (matched.length === 0) {
      el.innerHTML = '<div class="dlg-loading">No se encontraron canned responses coincidentes</div>';
      document.getElementById("insertCloseBtn").classList.add("hidden");
      return;
    }

    renderCannedWithCheckboxes(matched);
    document.getElementById("insertCloseBtn").classList.remove("hidden");
  }).catch(function () {
    el.innerHTML = '<div class="dlg-loading" style="color:#d93025">Error al cargar canned responses</div>';
  });
}

function fetchAllCannedPages(client, page, accumulated) {
  return client.request.invokeTemplate("getCannedResponses", {
    context: { page: String(page), auth_token: AUTH_TOKEN }
  }).then(function (response) {
    const items = JSON.parse(response.response);
    const all = accumulated.concat(items);

    // Freshdesk returns up to 30 per page
    if (items.length >= 30) {
      return fetchAllCannedPages(client, page + 1, all);
    }
    return all;
  });
}

function matchCannedByTitle(allCanned, suggestedTitles) {
  const results = [];
  const usedIds = {};

  suggestedTitles.forEach(function (suggested) {
    const lower = suggested.toLowerCase().trim();
    let bestMatch = null;
    let bestScore = 0;

    allCanned.forEach(function (cr) {
      if (usedIds[cr.id]) return;
      const crTitle = (cr.title || "").toLowerCase().trim();

      let score = 0;
      if (crTitle === lower) {
        score = 100;
      } else if (crTitle.indexOf(lower) >= 0 || lower.indexOf(crTitle) >= 0) {
        score = 80;
      } else {
        // Fuzzy: count word matches
        const words = lower.split(/\s+/);
        let hits = 0;
        words.forEach(function (w) {
          if (w.length > 2 && crTitle.indexOf(w) >= 0) hits++;
        });
        score = (words.length > 0) ? Math.round((hits / words.length) * 60) : 0;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = cr;
      }
    });

    if (bestMatch && bestScore >= 30) {
      usedIds[bestMatch.id] = true;
      results.push(bestMatch);
    }
  });

  return results;
}

// ─── Render canned responses with checkboxes ─────────────────────
function renderCannedWithCheckboxes(cannedList) {
  const el = document.getElementById("cannedResponses");
  const parts = [];

  cannedList.forEach(function (cr, idx) {
    const preview = truncate(stripHtml(cr.content_html || cr.content || ""), 200);

    parts.push(
      '<div class="dlg-canned-item dlg-canned-selectable">' +
      '<div class="dlg-canned-check">' +
      '<input type="checkbox" id="canned_' + idx + '" data-canned-idx="' + idx + '" checked>' +
      '</div>' +
      '<div class="dlg-canned-info">' +
      '<div class="dlg-canned-title">' + escapeHtml(cr.title) + '</div>' +
      '<div class="dlg-canned-body">' + escapeHtml(preview) + '</div>' +
      '</div>' +
      '</div>'
    );
  });

  el.innerHTML = parts.join("");

  // Store matched list for retrieval when inserting
  el.setAttribute("data-matched", JSON.stringify(cannedList.map(function (cr) {
    return { id: cr.id, title: cr.title, content_html: cr.content_html || cr.content || "" };
  })));
}

// ─── Insert selected canned and close ────────────────────────────
function insertAndClose(client) {
  const el = document.getElementById("cannedResponses");
  const matchedData = el.getAttribute("data-matched");
  if (!matchedData) {
    client.instance.close();
    return;
  }

  const matched = JSON.parse(matchedData);
  const selectedContents = [];

  document.querySelectorAll("#cannedResponses input[type=checkbox]:checked").forEach(function (cb) {
    const idx = parseInt(cb.getAttribute("data-canned-idx"), 10);
    if (matched[idx] && matched[idx].content_html) {
      selectedContents.push(matched[idx].content_html);
    }
  });

  if (selectedContents.length === 0) {
    client.instance.close();
    return;
  }

  const combined = selectedContents.join("<br><hr><br>");

  client.db.set("selected_canned", { content: combined }).then(function () {
    client.instance.close();
  }).catch(function () {
    client.instance.close();
  });
}

// ─── Render articles ─────────────────────────────────────────────
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

  client.request.invokeTemplate("makeWebhook", {
    body: JSON.stringify({
      ticket_id: TICKET_ID,
      feedback: type,
      source: "doctor-flux-pro-feedback"
    })
  }).then(function () {
    document.getElementById("feedbackMsg").textContent = "Gracias por tu feedback";
  }).catch(function () {
    document.getElementById("feedbackMsg").textContent = "No se pudo enviar";
  });
}

// ─── Utilities ───────────────────────────────────────────────────
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
