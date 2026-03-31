/**
 * Doctor Flux Pro v3c - Dialog with POLLING
 * Sends webhook (fire & forget), then polls for new private notes.
 * No more 504 timeouts!
 */

var TICKET_ID = null;
var CONVERSATIONS = [];
var AUTH_TOKEN = null;
var INITIAL_NOTE_IDS = {};
var POLL_TIMER = null;
var POLL_COUNT = 0;
var MAX_POLLS = 24;
var POLL_INTERVAL = 5000;
var ANALYZE_STARTED_AT = null;

app.initialized().then(function (client) {
  loadData(client);
  bindEvents(client);
}).catch(function () {
  showStatus("Error al inicializar la app", "error");
});

// --- Bind UI events ---
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
    stopPolling();
    client.instance.close();
  });

  document.getElementById("insertCloseBtn").addEventListener("click", function () {
    insertAndClose(client);
  });
}

// --- Load ticket + conversations ---
function loadData(client) {
  client.iparams.get().then(function (ip) {
    AUTH_TOKEN = btoa(ip.freshdesk_api_key + ":X");
    return client.data.get("ticket");
  }).then(function (data) {
    var ticket = data.ticket;
    TICKET_ID = ticket.id;
    document.getElementById("ticketInfo").textContent =
      "#" + ticket.id + " — " + truncate(ticket.subject, 60);

    return Promise.all([
      client.request.invokeTemplate("getTicket", {
        context: { ticket_id: String(ticket.id), auth_token: AUTH_TOKEN }
      }),
      client.request.invokeTemplate("getConversations", {
        context: { ticket_id: String(ticket.id), auth_token: AUTH_TOKEN }
      })
    ]);
  }).then(function (responses) {
    var fullTicket = JSON.parse(responses[0].response);
    var convs = JSON.parse(responses[1].response);

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
      // Track ALL conversation IDs (including private) for polling baseline
      INITIAL_NOTE_IDS[String(conv.id)] = true;

      // Only show public conversations in the UI list
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

// --- Render conversations ---
function renderConversations() {
  var container = document.getElementById("convItems");
  document.getElementById("convCount").textContent = CONVERSATIONS.length;

  if (CONVERSATIONS.length === 0) {
    container.innerHTML = '<div class="dlg-loading">No hay conversaciones publicas</div>';
    return;
  }

  var fragments = [];
  CONVERSATIONS.forEach(function (conv, idx) {
    var dateStr = formatDate(conv.created_at);
    var preview = truncate(conv.body_text, 200);
    var descTag = conv.is_description
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

// --- Analyze ticket (fire webhook + start polling) ---
function analyzeTicket(client) {
  var btn = document.getElementById("analyzeBtn");
  btn.disabled = true;
  btn.textContent = "Analizando...";
  btn.classList.add("loading");
  showStatus("Enviando al motor de IA...", "info");

  var selectedConvs = getSelectedConversations();
  if (selectedConvs.length === 0) {
    showStatus("Selecciona al menos una conversacion", "error");
    resetButton(btn);
    return;
  }

  var techNotes = document.getElementById("techNotes").value.trim();

  var payload = {
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

  // Record timestamp BEFORE sending — used to filter old notes
  ANALYZE_STARTED_AT = new Date().toISOString();

  // Fire the webhook — we expect a quick "processing" response
  client.request.invokeTemplate("makeWebhook", {
    body: JSON.stringify(payload)
  }).then(function () {
    // Webhook accepted — start polling for the AI note
    showStatus("IA procesando... esperando nota de Doctor IA (0/" + MAX_POLLS + ")", "info");
    startPolling(client);
  }).catch(function (err) {
    // Even on timeout/error, Make may still be processing
    var errMsg = "";
    if (err && err.status) {
      errMsg = "HTTP " + err.status;
    } else if (err && err.message) {
      errMsg = err.message;
    }

    // On any error, still start polling — Make is likely still processing
    showStatus("Webhook enviado (respuesta: " + (errMsg || "ok") + "). Buscando nota...", "info");
    startPolling(client);
  });
}

// --- Polling for new private notes ---
function startPolling(client) {
  POLL_COUNT = 0;
  stopPolling();

  POLL_TIMER = setInterval(function () {
    POLL_COUNT++;

    if (POLL_COUNT > MAX_POLLS) {
      stopPolling();
      showStatus("Timeout: la IA tardo demasiado. Revisa el ticket por si la nota aparece.", "error");
      resetButton(document.getElementById("analyzeBtn"));
      return;
    }

    var elapsed = POLL_COUNT * 5;
    showStatus("IA procesando... " + elapsed + "s (" + POLL_COUNT + "/" + MAX_POLLS + ")", "info");

    client.request.invokeTemplate("getConversations", {
      context: { ticket_id: String(TICKET_ID), auth_token: AUTH_TOKEN }
    }).then(function (response) {
      var convs = JSON.parse(response.response);
      var newNote = findNewPrivateNote(convs);

      if (newNote) {
        stopPolling();
        handleNewNote(newNote, client);
      }
    }).catch(function () {
      // Ignore poll errors, will retry next interval
    });
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (POLL_TIMER) {
    clearInterval(POLL_TIMER);
    POLL_TIMER = null;
  }
}

function findNewPrivateNote(convs) {
  for (var i = convs.length - 1; i >= 0; i--) {
    var conv = convs[i];

    // Must be private and not in initial set
    if (!conv.private || INITIAL_NOTE_IDS[String(conv.id)]) continue;

    // Must be created AFTER we clicked Analyze (with 60s tolerance for clock skew)
    if (ANALYZE_STARTED_AT && conv.created_at) {
      var noteTime = new Date(conv.created_at).getTime();
      var startTime = new Date(ANALYZE_STARTED_AT).getTime() - 60000;
      if (noteTime < startTime) continue;
    }

    // Must contain real content (not just a JSON status or empty)
    var bodyText = conv.body_text || conv.body || "";
    if (bodyText.length < 50) continue;
    if (bodyText.indexOf("processing") >= 0 && bodyText.length < 200) continue;

    return conv;
  }
  return null;
}

// --- Handle the new AI note ---
function handleNewNote(note, client) {
  resetButton(document.getElementById("analyzeBtn"));
  showStatus("Analisis completado", "success");

  // The note body contains the AI analysis HTML
  var noteHtml = note.body || "";
  var noteText = note.body_text || stripHtml(noteHtml);

  // Show results section
  document.getElementById("sectionResults").classList.remove("hidden");

  // Try to extract structured data from the note
  // Make scenario might embed JSON in an HTML comment: <!-- FLUX_JSON:{...} -->
  var jsonData = extractEmbeddedJson(noteHtml);

  if (jsonData) {
    // Structured response — show recommendation, canned, articles
    displayStructuredResults(jsonData, client);
  } else {
    // Plain note — show the full note content as recommendation
    var recEl = document.getElementById("recommendation");
    recEl.innerHTML = noteHtml || escapeHtml(noteText);
    document.getElementById("resultCanned").classList.add("hidden");
    document.getElementById("resultArticles").classList.add("hidden");
  }

  document.getElementById("sectionResults").scrollIntoView({ behavior: "smooth" });
}

function extractEmbeddedJson(html) {
  // Look for <!-- FLUX_JSON:{...} --> in the note HTML
  var match = html.match(/<!--\s*FLUX_JSON:([\s\S]*?)-->/);
  if (match && match[1]) {
    try {
      return JSON.parse(match[1].trim());
    } catch {
      return null;
    }
  }
  return null;
}

// --- Display structured results (if JSON embedded) ---
function displayStructuredResults(result, client) {
  var recEl = document.getElementById("recommendation");
  recEl.textContent = result.recommendation || result.analysis || "";

  renderArticles(result);

  if (result.canned_responses && result.canned_responses.length > 0) {
    var titles = result.canned_responses.map(function (cr) {
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
}

function getSelectedConversations() {
  var selected = [];
  document.querySelectorAll("#convItems input[type=checkbox]:checked").forEach(function (cb) {
    var idx = parseInt(cb.getAttribute("data-idx"), 10);
    if (CONVERSATIONS[idx]) {
      selected.push(CONVERSATIONS[idx]);
    }
  });
  return selected;
}

function resetButton(btn) {
  if (!btn) return;
  btn.textContent = "Analizar con IA";
  btn.classList.remove("loading");
  btn.disabled = false;
}

// --- Fetch ALL canned responses from Freshdesk ---
function fetchAndMatchCanned(client, suggestedTitles) {
  var block = document.getElementById("resultCanned");
  var el = document.getElementById("cannedResponses");
  block.classList.remove("hidden");
  el.innerHTML = '<div class="dlg-loading">Buscando respuestas en Freshdesk...</div>';

  fetchAllCannedPages(client, 1, []).then(function (allCanned) {
    var matched = matchCannedByTitle(allCanned, suggestedTitles);

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
    var items = JSON.parse(response.response);
    var all = accumulated.concat(items);

    if (items.length >= 30) {
      return fetchAllCannedPages(client, page + 1, all);
    }
    return all;
  });
}

function matchCannedByTitle(allCanned, suggestedTitles) {
  var results = [];
  var usedIds = {};

  suggestedTitles.forEach(function (suggested) {
    var lower = suggested.toLowerCase().trim();
    var bestMatch = null;
    var bestScore = 0;

    allCanned.forEach(function (cr) {
      if (usedIds[cr.id]) return;
      var crTitle = (cr.title || "").toLowerCase().trim();

      var score = 0;
      if (crTitle === lower) {
        score = 100;
      } else if (crTitle.indexOf(lower) >= 0 || lower.indexOf(crTitle) >= 0) {
        score = 80;
      } else {
        var words = lower.split(/\s+/);
        var hits = 0;
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

// --- Render canned responses with checkboxes ---
function renderCannedWithCheckboxes(cannedList) {
  var el = document.getElementById("cannedResponses");
  var parts = [];

  cannedList.forEach(function (cr, idx) {
    var preview = truncate(stripHtml(cr.content_html || cr.content || ""), 200);

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

  el.setAttribute("data-matched", JSON.stringify(cannedList.map(function (cr) {
    return { id: cr.id, title: cr.title, content_html: cr.content_html || cr.content || "" };
  })));
}

// --- Insert selected canned and close ---
function insertAndClose(client) {
  var el = document.getElementById("cannedResponses");
  var matchedData = el.getAttribute("data-matched");
  if (!matchedData) {
    client.instance.close();
    return;
  }

  var matched = JSON.parse(matchedData);
  var selectedContents = [];

  document.querySelectorAll("#cannedResponses input[type=checkbox]:checked").forEach(function (cb) {
    var idx = parseInt(cb.getAttribute("data-canned-idx"), 10);
    if (matched[idx] && matched[idx].content_html) {
      selectedContents.push(matched[idx].content_html);
    }
  });

  if (selectedContents.length === 0) {
    client.instance.close();
    return;
  }

  var combined = selectedContents.join("<br><hr><br>");

  client.db.set("selected_canned", { content: combined }).then(function () {
    client.instance.close();
  }).catch(function () {
    client.instance.close();
  });
}

// --- Render articles ---
function renderArticles(result) {
  var block = document.getElementById("resultArticles");
  var el = document.getElementById("articles");

  if (!result.articles || result.articles.length === 0) {
    block.classList.add("hidden");
    return;
  }

  block.classList.remove("hidden");
  var parts = [];
  result.articles.forEach(function (art) {
    var title = art.title || art.url || "Articulo";
    var url = art.url || "#";
    parts.push('<a class="dlg-article-item" href="' + escapeHtml(url) + '" target="_blank">' + escapeHtml(title) + '</a>');
  });
  el.innerHTML = parts.join("");
}

// --- Feedback ---
function sendFeedback(client, type) {
  var upBtn = document.getElementById("feedbackUp");
  var downBtn = document.getElementById("feedbackDown");

  upBtn.classList.remove("selected");
  downBtn.classList.remove("selected");

  if (type === "positive") {
    upBtn.classList.add("selected");
  } else {
    downBtn.classList.add("selected");
  }

  document.getElementById("feedbackMsg").textContent = "Gracias por tu feedback";
}

// --- Utilities ---
function showStatus(text, type) {
  var el = document.getElementById("statusMsg");
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
    var d = new Date(dateStr);
    return d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }) +
      " " + d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return dateStr;
  }
}

function escapeHtml(str) {
  if (!str) return "";
  var div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function stripHtml(html) {
  var tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
}
