const state = {
  currentCustomerId: localStorage.getItem("hotelQueueCustomerId") || "",
  ownerPin: sessionStorage.getItem("hotelQueueOwnerPin") || "",
  customerUrl: "",
  poll: null,
};

const $ = (selector) => document.querySelector(selector);
const minutes = (value) => `${value} min`;
const customerMessage = "Your Table is ready, please come!";

function setMode() {
  const mode = location.hash === "#owner" ? "owner" : "customer";
  $("#customerView").classList.toggle("hidden", mode !== "customer");
  $("#ownerView").classList.toggle("hidden", mode !== "owner");
  document.body.classList.toggle("owner-mode", mode === "owner");
  $("#ownerGate").classList.toggle("hidden", mode !== "owner" || Boolean(state.ownerPin));
  $(".owner-layout").classList.toggle("hidden", mode !== "owner" || !state.ownerPin);
  refresh();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function ownerApi(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Owner-Pin": state.ownerPin,
      ...(options.headers || {}),
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function formatWaited(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 1) return `${secs}s`;
  if (mins < 60) return `${mins}m ${secs}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function renderTicket(entry) {
  const ticket = $("#ticket");
  if (!entry) {
    ticket.classList.add("empty");
    $("#ticketToken").textContent = "--";
    $("#ticketMessage").textContent = "Fill the form to receive your token number, position, and wait time.";
    $("#ticketPosition").textContent = "--";
    $("#ticketWait").textContent = "--";
    return;
  }
  ticket.classList.remove("empty");
  $("#ticketToken").textContent = entry.token;
  if (entry.status === "ready") {
    $("#ticketMessage").textContent = "Your table is ready. Please come to the host counter.";
    $("#ticketPosition").textContent = "Ready";
    $("#ticketWait").textContent = "Now";
    return;
  }
  if (entry.status !== "waiting") {
    $("#ticketMessage").textContent = "This token is no longer in the waiting queue.";
    $("#ticketPosition").textContent = "--";
    $("#ticketWait").textContent = "--";
    return;
  }
  $("#ticketMessage").textContent = `Thanks, ${entry.name}. Keep this screen open for live updates.`;
  $("#ticketPosition").textContent = entry.position;
  $("#ticketWait").textContent = minutes(entry.estimatedWaitMinutes);
}

function whatsappUrl(phone) {
  let digits = phone.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(customerMessage)}`;
}

function renderQueue(data) {
  $("#hotelName").textContent = data.hotelName;
  $("#hotelInput").value = data.hotelName;
  $("#avgInput").value = data.averageMinutesPerTable;

  const active = data.entries.filter((entry) => entry.status === "waiting" || entry.status === "ready");
  const waiting = data.entries.filter((entry) => entry.status === "waiting");
  $("#waitingCount").textContent = waiting.length;

  if (!active.length) {
    $("#queueList").innerHTML = `<div class="empty-state">No customers waiting yet.</div>`;
    return;
  }

  $("#queueList").innerHTML = active
    .map((entry) => {
      const ready = entry.status === "ready";
      return `
        <article class="queue-card ${ready ? "ready" : ""}">
          <div class="queue-top">
            <div>
              <span class="token-pill">Token ${entry.token}</span>
              <div class="customer-name">${escapeHtml(entry.name)}</div>
            </div>
            <strong>${ready ? "Ready" : `#${entry.position} in queue`}</strong>
          </div>
          <div class="customer-meta">
            <div><span>Phone</span><strong>${escapeHtml(entry.phone)}</strong></div>
            <div><span>Seats</span><strong>${entry.seats}</strong></div>
            <div><span>Waiting</span><strong>${formatWaited(entry.waitedSeconds)}</strong></div>
            <div><span>Est. wait</span><strong>${ready ? "Now" : minutes(entry.estimatedWaitMinutes)}</strong></div>
          </div>
          <div class="queue-actions">
            <button class="whatsapp" data-whatsapp="${entry.id}" type="button">WhatsApp Ready</button>
            <button class="quiet" data-seated="${entry.id}" type="button">Mark Seated</button>
            <button class="quiet" data-cancel="${entry.id}" type="button">Remove</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function refresh() {
  try {
    const publicData = await api("/api/public");
    $("#hotelName").textContent = publicData.hotelName;
    if (location.hash === "#owner" && state.ownerPin) {
      const data = await ownerApi("/api/owner/state");
      renderQueue(data);
    }
    if (state.currentCustomerId) {
      try {
        const entry = await api(`/api/customer/${state.currentCustomerId}`);
        if (entry.status === "cancelled" || entry.status === "seated") {
          state.currentCustomerId = "";
          localStorage.removeItem("hotelQueueCustomerId");
          renderTicket(null);
        } else {
          renderTicket(entry);
        }
      } catch (error) {
        state.currentCustomerId = "";
        localStorage.removeItem("hotelQueueCustomerId");
        renderTicket(null);
      }
    }
  } catch (error) {
    console.warn(error);
  }
}

async function loadConfig() {
  const config = await api("/api/config").catch(() => ({ urls: [] }));
  const select = $("#urlSelect");
  select.innerHTML = "";
  const currentCustomerUrl = `${window.location.origin}/#customer`;
  const urls = [currentCustomerUrl, ...(config.urls || []).filter((url) => url !== currentCustomerUrl)];
  urls.forEach((url) => {
    const option = document.createElement("option");
    option.value = url.includes("#customer") ? url : `${url}/#customer`;
    option.textContent = option.value;
    select.append(option);
  });
  state.customerUrl = select.value;
  updateQr();
}

function updateQr() {
  state.customerUrl = $("#urlSelect").value;
  const src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(state.customerUrl)}`;
  $("#qrCode").innerHTML = `<img src="${src}" alt="QR code for customer queue form" />`;
}

$("#joinForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#formError").textContent = "";
  const form = new FormData(event.currentTarget);
  try {
    const entry = await api("/api/join", {
      method: "POST",
      body: JSON.stringify({
        name: form.get("name"),
        phone: form.get("phone"),
        seats: form.get("seats"),
      }),
    });
    state.currentCustomerId = entry.id;
    localStorage.setItem("hotelQueueCustomerId", entry.id);
    renderTicket(entry);
    event.currentTarget.reset();
  } catch (error) {
    $("#formError").textContent = error.message;
  }
});

$("#queueList").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const data = await ownerApi("/api/owner/state");
  const id = button.dataset.whatsapp || button.dataset.seated || button.dataset.cancel;
  const entry = data.entries.find((item) => item.id === id);
  if (!entry) return;
  if (button.dataset.whatsapp) {
    await ownerApi(`/api/status/${id}`, { method: "POST", body: JSON.stringify({ status: "ready" }) });
    window.open(whatsappUrl(entry.phone), "_blank", "noopener,noreferrer");
  }
  if (button.dataset.seated) {
    await ownerApi(`/api/status/${id}`, { method: "POST", body: JSON.stringify({ status: "seated" }) });
  }
  if (button.dataset.cancel) {
    await ownerApi(`/api/status/${id}`, { method: "POST", body: JSON.stringify({ status: "cancelled" }) });
  }
  refresh();
});

$("#ownerGate").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#pinError").textContent = "";
  state.ownerPin = $("#ownerPin").value.trim();
  try {
    await ownerApi("/api/owner/state");
    sessionStorage.setItem("hotelQueueOwnerPin", state.ownerPin);
    setMode();
  } catch (error) {
    state.ownerPin = "";
    sessionStorage.removeItem("hotelQueueOwnerPin");
    $("#pinError").textContent = "Wrong PIN. Please try again.";
  }
});

$("#saveSettings").addEventListener("click", async () => {
  await ownerApi("/api/settings", {
    method: "POST",
    body: JSON.stringify({
      hotelName: $("#hotelInput").value,
      averageMinutesPerTable: $("#avgInput").value,
      ownerPin: $("#newPinInput").value,
    }),
  });
  if ($("#newPinInput").value.trim()) {
    state.ownerPin = $("#newPinInput").value.trim();
    sessionStorage.setItem("hotelQueueOwnerPin", state.ownerPin);
    $("#newPinInput").value = "";
  }
  refresh();
});

$("#clearQueue").addEventListener("click", async () => {
  await ownerApi("/api/clear", { method: "POST", body: "{}" });
  refresh();
});

$("#refreshQueue").addEventListener("click", refresh);
$("#urlSelect").addEventListener("change", updateQr);
$("#copyLink").addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.customerUrl);
  $("#copyLink").textContent = "Copied";
  setTimeout(() => ($("#copyLink").textContent = "Copy Link"), 1200);
});

window.addEventListener("hashchange", setMode);
loadConfig().finally(setMode);
state.poll = setInterval(refresh, 5000);
