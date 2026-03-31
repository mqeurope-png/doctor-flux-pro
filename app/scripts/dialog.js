/**
 * Doctor Flux Pro v3d - Dialog with POLLING
 * 1. Sends webhook to Make (fire & forget)
 * 2. Polls ticket conversations every 5s looking for new Doctor IA note
 * 3. When found, displays note content in dialog
 */

let TICKET_ID = null;
let CONVERSATIONS = [];
let AUTH_TOKEN = null;
let INITIAL_NOTE_IDS = {};
let POLL_TIMER = null;
let POLL_COUNT = 0;
const MAX_POLLS = 24;
const POLL_INTERVAL = 5000;
let ANALYZE_TIMESTAMP = null;

/* ================================================================
   INIT
   ================================================================ */
app.initialized().then(function (client) {
  showStatus("v3d-polling cargado", "success");
  loadData(client);
  bindEvents(client);
}).catch(function () {
  showStatus("Error al inicializar la app", "error");
});

/* ================================================================
   BIND EVENTS
   ================================================================ */
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
    sendFeedback("positive");
  });

  document.getElementById("feedbackDown").addEventListener("click", function () {
    sendFeedback("negative");
  });

  document.getElementById("closeBtn").addEventListener("click", function () {
    stopPolling();
    client.instance.close();
  });

  document.getElementById("insertCloseBtn").addEventListener("click", function () {
    insertAndClose(client);
  });
}

/* ================================================================
   LOAD TICKET DATA + CONVERSATIONS
   ================================================================ */
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
        context: { ticket_id: String(ticket.id), auth_token: AUTH_TOKEN }
      }),
      client.request.invokeTemplate("getConversations", {
        context: { ticket_id: String(ticket.id), auth_token: AUTH_TOKEN }
      })
    ]);
  }).then(function (responses) {
    const fullTicket = JSON.parse(responses[0].response);
    const convs = JSON.parse(responses[1].response);

    CONVERSATIONS = [];
    INITIAL_NOTE_IDS = {};

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
      INITIAL_NOTE_IDS[String(conv.id)] = true;

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
    showStatus("Listo para analizar", "success");
  }).catch(function (err) {
    document.getElementById("convItems").innerHTML =
      '<div class="dlg-loading" style="color:#d93025">Error: ' +
      escapeHtml(err.message || "No se pudieron cargar las conversaciones") + '</div>';
  });
}

/* ================================================================
   RENDER CONVERSATIONS
   ================================================================ */
function renderConversations() {
  const container = document.getElementById("convItems");
  document.getElementById("convCount").textContent = CONVERSATIONS.length;

  if (CONVERSATIONS.length === 0) {
    container.innerHTML = '<div class="dlg-loading">No hay conversaciones publicas</div>';
    return;
  }

  const html = [];
  CONVERSATIONS.forEach(function (conv, idx) {
    const dateStr = formatDate(conv.created_at);
    const preview = truncate(conv.body_text, 200);
    const descTag = conv.is_description
      ? '<span class="dlg-conv-desc-tag">Descripcion original</span>' : "";

    html.push(
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

  container.innerHTML = html.join("");
}

function setAllCheckboxes(checked) {
  document.querySelectorAll("#convItems input[type=checkbox]").forEach(function (cb) {
    cb.checked = checked;
  });
}

/* ================================================================
   ANALYZE TICKET — FIRE WEBHOOK + START POLLING
   ================================================================ */
function analyzeTicket(client) {
  const btn = document.getElementById("analyzeBtn");
  btn.disabled = true;
  btn.textContent = "Enviando...";
  btn.classList.add("loading");

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

  ANALYZE_TIMESTAMP = new Date().getTime();

  showStatus("Enviando al webhook de Make...", "info");

  client.request.invokeTemplate("makeWebhook", {
    body: JSON.stringify(payload)
  }).then(function () {
    showStatus("Webhook OK. Esperando nota de Doctor IA... 0s", "info");
    btn.textContent = "Esperando IA...";
    startPolling(client);
  }).catch(function (err) {
    let errMsg = "desconocido";
    if (err && err.status) {
      errMsg = "HTTP " + err.status;
    } else if (err && err.message) {
      errMsg = err.message;
    }
    showStatus("Webhook: " + errMsg + " — buscando nota igualmente...", "info");
    btn.textContent = "Esperando IA...";
    startPolling(client);
  });
}

/* ================================================================
   POLLING — check conversations every 5s for new private note
   ================================================================ */
function startPolling(client) {
  POLL_COUNT = 0;
  stopPolling();

  POLL_TIMER = setInterval(function () {
    POLL_COUNT++;

    if (POLL_COUNT > MAX_POLLS) {
      stopPolling();
      showStatus("Timeout (" + (MAX_POLLS * 5) + "s). Revisa el ticket.", "error");
      resetButton(document.getElementById("analyzeBtn"));
      return;
    }

    const elapsed = POLL_COUNT * 5;
    showStatus("Esperando nota de Doctor IA... " + elapsed + "s", "info");

    client.request.invokeTemplate("getConversations", {
      context: { ticket_id: String(TICKET_ID), auth_token: AUTH_TOKEN }
    }).then(function (response) {
      const convs = JSON.parse(response.response);
      const newNote = findNewDoctorNote(convs);

      if (newNote) {
        stopPolling();
        handleNewNote(newNote, client);
      }
    }).catch(function () { /* retry next interval */ });
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (POLL_TIMER) {
    clearInterval(POLL_TIMER);
    POLL_TIMER = null;
  }
}

function findNewDoctorNote(convs) {
  let found = null;

  for (let i = convs.length - 1; i >= 0; i--) {
    const conv = convs[i];

    if (!conv.private) { continue; }
    if (INITIAL_NOTE_IDS[String(conv.id)]) { continue; }

    const noteTime = new Date(conv.created_at).getTime();
    if (ANALYZE_TIMESTAMP && noteTime < ANALYZE_TIMESTAMP - 120000) { continue; }

    const body = conv.body_text || conv.body || "";
    if (body.length < 100) { continue; }
    if (body.indexOf('"processing"') >= 0 && body.length < 200) { continue; }

    found = conv;
    break;
  }

  return found;
}

/* ================================================================
   HANDLE NEW NOTE — display results
   ================================================================ */
function handleNewNote(note, client) {
  resetButton(document.getElementById("analyzeBtn"));

  const noteHtml = note.body || "";
  const noteText = note.body_text || stripHtml(noteHtml);

  document.getElementById("sectionResults").classList.remove("hidden");

  const jsonData = extractEmbeddedJson(noteHtml);

  if (jsonData && jsonData.recommendation) {
    showStatus("Analisis completado (datos estructurados)", "success");
    displayStructuredResults(jsonData, client);
  } else {
    showStatus("Analisis completado", "success");
    document.getElementById("recommendation").innerHTML = noteHtml || escapeHtml(noteText);
    document.getElementById("resultCanned").classList.add("hidden");
    document.getElementById("resultArticles").classList.add("hidden");
  }

  document.getElementById("sectionResults").scrollIntoView({ behavior: "smooth" });
}

function extractEmbeddedJson(html) {
  if (!html) { return null; }
  const match = html.match(/<!--\s*FLUX_JSON:([\s\S]*?)-->/);
  if (match && match[1]) {
    try {
      return JSON.parse(match[1].trim());
    } catch {
      return null;
    }
  }
  return null;
}

/* ================================================================
   DISPLAY STRUCTURED RESULTS
   ================================================================ */
function displayStructuredResults(result, client) {
  document.getElementById("recommendation").textContent = result.recommendation || "";

  renderArticles(result);

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
  if (!btn) { return; }
  btn.textContent = "Analizar con IA";
  btn.classList.remove("loading");
  btn.disabled = false;
}

/* ================================================================
   FETCH & MATCH CANNED RESPONSES
   ================================================================ */
function fetchAndMatchCanned(client, suggestedTitles) {
  const block = document.getElementById("resultCanned");
  const el = document.getElementById("cannedResponses");
  block.classList.remove("hidden");
  el.innerHTML = '<div class="dlg-loading">Buscando respuestas en Freshdesk...</div>';

  fetchAllCannedPages(client, 1, []).then(function (allCanned) {
    const matched = matchCannedByTitle(allCanned, suggestedTitles);

    if (matched.length === 0) {
      el.innerHTML = '<div class="dlg-loading">No se encontraron canned responses</div>';
      document.getElementById("insertCloseBtn").classList.add("hidden");
      return;
    }

    renderCannedWithCheckboxes(matched);
    document.getElementById("insertCloseBtn").classList.remove("hidden");
  }).catch(function () {
    el.innerHTML = '<div class="dlg-loading" style="color:#d93025">Error al cargar canned</div>';
  });
}

function fetchAllCannedPages(client, page, accumulated) {
  return client.request.invokeTemplate("getCannedResponses", {
    context: { page: String(page), auth_token: AUTH_TOKEN }
  }).then(function (response) {
    const items = JSON.parse(response.response);
    const all = accumulated.concat(items);
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
      if (usedIds[cr.id]) { return; }
      const crTitle = (cr.title || "").toLowerCase().trim();
      let score = 0;

      if (crTitle === lower) {
        score = 100;
      } else if (crTitle.indexOf(lower) >= 0 || lower.indexOf(crTitle) >= 0) {
        score = 80;
      } else {
        const words = lower.split(/\s+/);
        let hits = 0;
        words.forEach(function (w) {
          if (w.length > 2 && crTitle.indexOf(w) >= 0) { hits++; }
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
      '</div></div>'
    );
  });

  el.innerHTML = parts.join("");
  el.setAttribute("data-matched", JSON.stringify(cannedList.map(function (cr) {
    return { id: cr.id, title: cr.title, content_html: cr.content_html || cr.content || "" };
  })));
}

/* ================================================================
   INSERT SELECTED CANNED & CLOSE
   ================================================================ */
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

/* ================================================================
   ARTICLES
   ================================================================ */
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

/* ================================================================
   FEEDBACK
   ================================================================ */
function sendFeedback(type) {
  const upBtn = document.getElementById("feedbackUp");
  const downBtn = document.getElementById("feedbackDown");
  upBtn.classList.remove("selected");
  downBtn.classList.remove("selected");
  if (type === "positive") {
    upBtn.classList.add("selected");
  } else {
    downBtn.classList.add("selected");
  }
  document.getElementById("feedbackMsg").textContent = "Gracias por tu feedback";
}

/* ================================================================
   UTILITIES
   ================================================================ */
function showStatus(text, type) {
  const el = document.getElementById("statusMsg");
  el.textContent = text;
  el.className = "dlg-status" + (type ? " " + type : "");
}

function truncate(str, max) {
  if (!str) { return ""; }
  return str.length > max ? str.substring(0, max) + "..." : str;
}

function formatDate(dateStr) {
  if (!dateStr) { return ""; }
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" }) +
      " " + d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return dateStr;
  }
}

function escapeHtml(str) {
  if (!str) { return ""; }
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function stripHtml(html) {
  const tmp = document.createElement("div");
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || "";
}
