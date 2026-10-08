const select = (selector) => document.querySelector(selector);
const escapeText = (text) =>
  String(text ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const icons = () => window.lucide?.createIcons();
const ACTIVE = new Set([
  "queued",
  "opening",
  "waiting",
  "capturing",
  "assembling",
]);
let state = { jobs: [], browser: "closed" };
let token = "";
let selectedId = null;
let view = "workspace";
let pendingDelete = null;
let toastTimer;
let submitting = false;
let browserActionPending = false;
const pendingDownloads = new Set(readStored("pagepress-pending-downloads", []));
const requestedDownloads = new Set(
  readStored("pagepress-requested-downloads", []),
);

function readStored(key, fallback) {
  try {
    return JSON.parse(sessionStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function storeDownloads() {
  try {
    sessionStorage.setItem(
      "pagepress-pending-downloads",
      JSON.stringify([...pendingDownloads]),
    );
    sessionStorage.setItem(
      "pagepress-requested-downloads",
      JSON.stringify([...requestedDownloads]),
    );
  } catch {}
}

function trackDownloads() {
  const automatic = select("#auto-download").checked;
  for (const job of state.jobs) {
    if (ACTIVE.has(job.status) && automatic && !requestedDownloads.has(job.id))
      pendingDownloads.add(job.id);
    if (job.status === "complete" && pendingDownloads.has(job.id)) {
      pendingDownloads.delete(job.id);
      if (!automatic || requestedDownloads.has(job.id)) continue;
      requestedDownloads.add(job.id);
      const link = document.createElement("a");
      link.href = `/api/jobs/${job.id}/download`;
      link.download = job.filename;
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      notify(
        `${job.title}: download requested. Allow downloads if your browser asks.`,
      );
    } else if (!ACTIVE.has(job.status)) pendingDownloads.delete(job.id);
  }
  storeDownloads();
}

function sizeLabel(bytes = 0) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function notify(message) {
  clearTimeout(toastTimer);
  select("#toast").textContent = message;
  select("#toast").hidden = false;
  toastTimer = setTimeout(() => {
    select("#toast").hidden = true;
  }, 5500);
}

async function api(url, method = "POST", body) {
  const response = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "X-Pagepress-Token": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || "The local request failed.");
  return result;
}

function captureEnabled() {
  select("#capture-button").disabled =
    submitting ||
    !token ||
    !select("#permission").checked ||
    !select("#drive-links").value.trim();
}

const statusIcons = {
  complete: "check",
  queued: "clock-3",
  opening: "loader-circle",
  waiting: "user-round-key",
  capturing: "scan-line",
  assembling: "file-cog",
  failed: "circle-alert",
  interrupted: "circle-alert",
  cancelled: "circle-slash",
};

function statusLabel(job) {
  if (job.status === "capturing")
    return `Capturing page ${job.pageNumber || 1} of ${job.sourcePages || job.total}`;
  if (job.status === "queued") {
    const queued = [...state.jobs]
      .reverse()
      .filter((candidate) => candidate.status === "queued");
    return `Queued #${queued.findIndex((candidate) => candidate.id === job.id) + 1}`;
  }
  return (
    {
      complete: "PDF ready",
      opening: "Opening document",
      waiting: "Waiting for sign-in",
      assembling: "Assembling PDF",
      failed: "Capture failed",
      interrupted: "Interrupted",
      cancelled: "Cancelled",
    }[job.status] || job.status
  );
}

function jobDetail(job) {
  if (job.status === "queued") {
    if (
      state.browser === "signin" ||
      state.jobs.some((candidate) => candidate.status === "waiting")
    )
      return "Waiting for sign-in window to close";
    if (
      state.jobs.some(
        (candidate) =>
          candidate.id !== job.id &&
          ACTIVE.has(candidate.status) &&
          candidate.status !== "queued",
      )
    )
      return "Waiting for the current capture";
    return "Preparing to start";
  }
  if (job.status === "waiting")
    return "Close the Chrome sign-in window after login. Capture resumes automatically.";
  if (job.status === "complete")
    return requestedDownloads.has(job.id)
      ? "Download requested. The Download button remains available."
      : "Ready to download";
  return job.message || "";
}

function progressMarkup(job, compact = false) {
  if (!ACTIVE.has(job.status)) return "";
  const determinate = job.status === "capturing" || job.status === "assembling";
  const busy = job.status === "opening" || job.status === "assembling";
  const amount = Number(job.progress) || 0;
  const detail =
    job.status === "capturing"
      ? `${job.completed || 0} of ${job.total} pages captured`
      : job.status === "assembling"
        ? "Verifying and saving PDF"
        : jobDetail(job);
  return `<div class="job-progress ${compact ? "compact" : ""}">
    <div class="progress-label"><span>${escapeText(detail)}</span>${determinate ? `<strong>${amount}%</strong>` : ""}</div>
    <div class="progress-track ${busy && !determinate ? "indeterminate" : ""}" role="progressbar" aria-label="${escapeText(statusLabel(job))}" ${determinate ? `aria-valuenow="${amount}"` : ""} aria-valuemin="0" aria-valuemax="100" aria-valuetext="${escapeText(detail)}"><span data-progress="${determinate ? amount : 0}"></span></div>
  </div>`;
}

function actionButton(action, icon, title, id) {
  return `<button class="icon-button" data-action="${action}" data-id="${id}" title="${title}" aria-label="${title}"><i data-lucide="${icon}"></i></button>`;
}

function renderJobs() {
  const query = select("#search").value.trim().toLowerCase();
  const jobs = state.jobs.filter(
    (job) =>
      (view !== "completed" || job.status === "complete") &&
      job.title.toLowerCase().includes(query),
  );
  const focused = document.activeElement?.closest("[data-action]");
  const focusKey = focused
    ? { action: focused.dataset.action, id: focused.dataset.id }
    : null;
  select("#library-count").textContent = jobs.length;
  select("#empty-state").hidden = jobs.length > 0;
  select("#empty-state h3").textContent = query
    ? "No matching captures"
    : view === "completed"
      ? "No completed PDFs"
      : "No captures yet";
  select("#empty-detail").textContent = query
    ? "No files match this search."
    : view === "completed"
      ? "Completed files will appear here."
      : "Your library is empty.";
  select("#jobs").innerHTML = jobs
    .map((job) => {
      const active = ACTIVE.has(job.status);
      const metadata = job.total
        ? `${job.completed ?? job.pages ?? 0} / ${job.total} pages${job.size ? ` &middot; ${sizeLabel(job.size)}` : ""}`
        : job.kind === "sample"
          ? "Sample document"
          : "Google Drive";
      let actions = "";
      if (job.status === "complete")
        actions += `<a class="button button-outline row-command" href="/api/jobs/${job.id}/download" title="Download PDF" aria-label="Download ${escapeText(job.title)}"><i data-lucide="download"></i>Download</a>`;
      else if (!active)
        actions += `<button class="button button-outline row-command" data-action="retry" data-id="${job.id}" aria-label="Retry capture"><i data-lucide="rotate-ccw"></i>Retry</button>`;
      actions += active
        ? `<button class="button button-outline row-command cancel-command" data-action="cancel" data-id="${job.id}" aria-label="Cancel capture"><i data-lucide="x"></i>Cancel</button>`
        : actionButton("delete", "trash-2", "Delete capture", job.id);
      return `<article class="job-row ${job.id === selectedId ? "selected" : ""}" data-job-id="${job.id}"><div class="job-main">
      <button class="job-select" data-action="select" data-id="${job.id}" title="${escapeText(job.title)}" aria-label="Preview ${escapeText(job.title)}">
        <span class="job-thumb">${job.preview ? `<img src="/api/jobs/${job.id}/preview" alt="" loading="lazy">` : '<i data-lucide="file-text"></i>'}</span>
        <span class="job-text"><span class="job-title">${escapeText(job.title)}</span><span class="job-meta">${metadata}</span><span class="job-status ${job.status}"><i data-lucide="${statusIcons[job.status] || "file"}"></i>${statusLabel(job)}</span></span>
      </button><div class="job-controls">${actions}</div>
      </div>${progressMarkup(job)}${!active && job.status !== "complete" ? `<p class="job-error">${escapeText(job.message)}</p>` : ""}</article>`;
    })
    .join("");
  document.querySelectorAll("[data-progress]").forEach((element) => {
    element.style.width = `${element.dataset.progress}%`;
  });
  icons();
  if (focusKey)
    select(
      `[data-action="${focusKey.action}"][data-id="${focusKey.id}"]`,
    )?.focus({ preventScroll: true });
}

function renderPreview() {
  const job = state.jobs.find((candidate) => candidate.id === selectedId);
  const image = select("#preview-image");
  const download = select("#download-main");
  const stage = select(".preview-stage");
  stage.classList.toggle("has-job", Boolean(job));
  select("#preview-empty").hidden = !job || Boolean(job.preview);
  select("#expand-preview").disabled = Boolean(job && !job.preview);
  const source = job?.preview
    ? `/api/jobs/${job.id}/preview`
    : "/assets/sample-cover.png";
  if (image.getAttribute("src") !== source) image.src = source;
  image.alt = job
    ? `First captured page of ${job.title}`
    : "Sample document first page";
  select("#preview-stamp").textContent = job
    ? "FIRST CAPTURED PAGE"
    : "SAMPLE DOCUMENT";
  select("#preview-kind").textContent = job
    ? job.kind === "sample"
      ? "SAMPLE / PAGE CAPTURE"
      : "GOOGLE DRIVE / PAGE CAPTURE"
    : "FIELD NOTES / SAMPLE";
  select("#preview-title").textContent = job ? job.title : "A little clarity.";
  select("#preview-meta").innerHTML = job
    ? `<span>${job.total ? `${job.total} pages` : "Pending"}</span><span>${job.quality === "high" ? "High" : "Standard"}</span>${job.size ? `<span>${sizeLabel(job.size)}</span>` : ""}`
    : "<span>3 pages</span><span>PDF</span>";
  const message =
    job && (job.warnings?.length ? job.warnings.join(" ") : jobDetail(job));
  select("#preview-message").hidden = !message;
  select("#preview-message").textContent = message || "";
  select("#preview-progress").innerHTML = job ? progressMarkup(job) : "";
  select("#preview-progress")
    .querySelectorAll("[data-progress]")
    .forEach((element) => {
      element.style.width = `${element.dataset.progress}%`;
    });
  download.hidden = job?.status !== "complete";
  if (job?.status === "complete") {
    download.href = `/api/jobs/${job.id}/download`;
    download.setAttribute("download", job.filename);
  }
}

function render() {
  const completed = state.jobs.filter((job) => job.status === "complete");
  select("#all-count").textContent = state.jobs.length;
  select("#done-count").textContent = completed.length;
  select("#total-pages").textContent = completed
    .reduce((sum, job) => sum + job.pages, 0)
    .toLocaleString();
  select("#total-size").textContent = sizeLabel(
    completed.reduce((sum, job) => sum + job.size, 0),
  );
  select("#library-summary").textContent =
    `${completed.length} PDF${completed.length === 1 ? "" : "s"} saved`;
  const working = state.jobs.find(
    (job) => ACTIVE.has(job.status) && job.status !== "queued",
  );
  const queued = state.jobs.filter((job) => job.status === "queued").length;
  const summary = select("#queue-summary");
  summary.hidden = !working && !queued;
  summary.textContent = working
    ? `${statusLabel(working)}${queued ? ` | ${queued} queued` : ""}`
    : queued
      ? `${queued} queued${state.browser === "signin" ? " | Waiting for sign-in window to close" : ""}`
      : "";
  const signingIn = state.browser === "signin";
  select("#browser-state").innerHTML =
    `<span class="small-dot"></span>${signingIn ? "Sign-in window open" : state.browser === "connected" ? "Capture browser ready" : "Browser closed"}`;
  select("#browser-state").classList.toggle(
    "connected",
    state.browser === "connected",
  );
  select("#open-browser span").textContent = signingIn
    ? "Signing in"
    : state.browser === "connected" &&
        state.jobs.some((job) => job.kind === "drive" && ACTIVE.has(job.status))
      ? "Show browser"
      : "Sign in to Google";
  select("#open-browser").disabled = browserActionPending || signingIn;
  select("#close-browser").hidden = state.browser !== "connected";
  select("#signin-notice").hidden = !signingIn;
  if (!state.jobs.some((job) => job.id === selectedId))
    selectedId = state.jobs[0]?.id || null;
  renderJobs();
  renderPreview();
}

async function refresh() {
  const response = await fetch("/api/state");
  if (!response.ok) throw new Error("The local server is unavailable.");
  const result = await response.json();
  token = result.token;
  state = result;
  trackDownloads();
  captureEnabled();
  render();
}

select("#drive-links").addEventListener("input", () => {
  select("#form-error").hidden = true;
  captureEnabled();
});
select("#permission").addEventListener("change", captureEnabled);
select("#clear-links").addEventListener("click", () => {
  select("#drive-links").value = "";
  select("#form-error").hidden = true;
  captureEnabled();
  select("#drive-links").focus();
});
select("#search").addEventListener("input", renderJobs);
select("#auto-download").checked = readStored("pagepress-auto-download", true);
select("#auto-download").addEventListener("change", () => {
  try {
    sessionStorage.setItem(
      "pagepress-auto-download",
      JSON.stringify(select("#auto-download").checked),
    );
  } catch {}
  if (!select("#auto-download").checked) {
    pendingDownloads.clear();
    storeDownloads();
  }
});

select("#capture-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  submitting = true;
  captureEnabled();
  select("#capture-button").classList.add("is-busy");
  select("#form-error").hidden = true;
  try {
    const result = await api("/api/jobs", "POST", {
      links: select("#drive-links")
        .value.split(/\r?\n/)
        .map((link) => link.trim())
        .filter(Boolean),
      quality: select('input[name="quality"]:checked').value,
      permission: select("#permission").checked,
    });
    selectedId = result.jobs[0].id;
    if (select("#auto-download").checked)
      result.jobs.forEach((job) => pendingDownloads.add(job.id));
    storeDownloads();
    select("#drive-links").value = "";
    await refresh();
    notify(
      result.jobs.length === 1
        ? "Capture added to the queue"
        : `${result.jobs.length} captures added to the queue`,
    );
  } catch (error) {
    select("#form-error").textContent = error.message;
    select("#form-error").hidden = false;
  } finally {
    submitting = false;
    captureEnabled();
    select("#capture-button").classList.remove("is-busy");
  }
});

select("#sample-button").addEventListener("click", async () => {
  const button = select("#sample-button");
  button.disabled = true;
  select("#form-error").hidden = true;
  try {
    const result = await api("/api/jobs", "POST", {
      sample: true,
      quality: "standard",
    });
    if (select("#auto-download").checked)
      result.jobs.forEach((job) => pendingDownloads.add(job.id));
    storeDownloads();
    selectedId = result.jobs[0].id;
    await refresh();
    notify("Sample capture started");
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
});

select("#jobs").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const { action, id } = button.dataset;
  if (action === "select") {
    selectedId = id;
    render();
    return;
  }
  if (action === "delete") {
    pendingDelete = id;
    select("#delete-title").textContent = state.jobs.find(
      (job) => job.id === id,
    )?.title;
    select("#delete-dialog").showModal();
    return;
  }
  button.disabled = true;
  try {
    const result = await api(`/api/jobs/${id}/${action}`);
    if (result.jobs) {
      selectedId = result.jobs[0].id;
      if (select("#auto-download").checked)
        result.jobs.forEach((job) => pendingDownloads.add(job.id));
      storeDownloads();
    }
    await refresh();
  } catch (error) {
    notify(error.message);
    button.disabled = false;
  }
});

select("#confirm-delete").addEventListener("click", async () => {
  if (!pendingDelete) return;
  select("#confirm-delete").disabled = true;
  try {
    await api(`/api/jobs/${pendingDelete}`, "DELETE");
    select("#delete-dialog").close();
    pendingDelete = null;
    await refresh();
    notify("Capture deleted");
  } catch (error) {
    notify(error.message);
  } finally {
    select("#confirm-delete").disabled = false;
  }
});

document.querySelectorAll("[data-view]").forEach((button) =>
  button.addEventListener("click", () => {
    view = button.dataset.view;
    document.querySelectorAll("[data-view]").forEach((item) => {
      item.classList.toggle("active", item === button);
      if (item === button) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    select("#composer").hidden = view === "completed";
    select("#view-title").textContent =
      view === "completed" ? "Completed" : "Captures";
    select("#breadcrumb-view").textContent =
      view === "completed" ? "Completed" : "Captures";
    select("#library-title").textContent =
      view === "completed" ? "Saved PDFs" : "Recent captures";
    if (view === "completed")
      selectedId =
        state.jobs.find((job) => job.status === "complete")?.id || null;
    renderJobs();
    renderPreview();
  }),
);

for (const action of ["open", "close"]) {
  select(`#${action}-browser`).addEventListener("click", async () => {
    browserActionPending = true;
    const button = select(`#${action}-browser`);
    button.disabled = true;
    button.classList.add("is-busy");
    try {
      await api(`/api/browser/${action}`);
      await refresh();
    } catch (error) {
      notify(error.message);
    } finally {
      browserActionPending = false;
      button.disabled = false;
      button.classList.remove("is-busy");
      render();
    }
  });
}

select("#expand-preview").addEventListener("click", () => {
  select("#large-preview").src = select("#preview-image").src;
  select("#preview-dialog").showModal();
});
select("#close-preview").addEventListener("click", () =>
  select("#preview-dialog").close(),
);
select("#local-address").textContent = location.host;
icons();

refresh()
  .then(() => {
    const events = new EventSource("/api/events");
    events.onmessage = (event) => {
      state = { ...state, ...JSON.parse(event.data) };
      trackDownloads();
      render();
    };
    events.onopen = () => {
      select("#service-status").textContent = "Local session";
      select("#footer-status").textContent = "All systems local";
      refresh().catch(() => {});
    };
    events.onerror = () => {
      select("#service-status").textContent = "Reconnecting";
      select("#footer-status").textContent = "Server connection interrupted";
    };
  })
  .catch((error) => {
    select("#service-status").textContent = "Server offline";
    notify(error.message);
  });
