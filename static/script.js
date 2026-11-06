// ============================================================================
// Automated Data Analysis Tool — frontend logic
// ============================================================================
const state = {
  loaded: false,
  columns: [], dtypes: {}, numeric: [], categorical: [], datetime: [],
  maxStepReached: 1,
};

const stepMeta = {
  1: { eyebrow: "Step 01 / Collect", title: "Bring in your data" },
  2: { eyebrow: "Step 02 / Clean", title: "Handle duplicates & missing values" },
  3: { eyebrow: "Step 03 / Validate", title: "Fix types & catch outliers" },
  4: { eyebrow: "Step 04 / Analyze", title: "Summarize what you have" },
  5: { eyebrow: "Step 05 / Visualize", title: "Build charts" },
  6: { eyebrow: "Step 06 / Ask", title: "Chat with your data" },
  7: { eyebrow: "Step 07 / Workbench & Export", title: "Explore, then take it with you" },
};

// ---------------------------------------------------------------- helpers
function toast(msg, type = "info") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 4000);
}

// ---- top progress bar: ramps toward 90% while requests are pending,
// completes to 100% and fades out once all pending requests finish ----
let pendingRequests = 0;
let progressTimer = null;

function startProgress() {
  pendingRequests++;
  if (pendingRequests > 1) return;
  const fill = document.getElementById("progressFill");
  fill.style.transition = "none";
  fill.style.width = "0%";
  fill.classList.add("active");
  requestAnimationFrame(() => {
    fill.style.transition = "width 0.4s ease, opacity 0.25s ease";
    let width = 0;
    progressTimer = setInterval(() => {
      width += (88 - width) * 0.12;
      fill.style.width = Math.min(width, 88) + "%";
    }, 180);
  });
}

function finishProgress() {
  pendingRequests = Math.max(0, pendingRequests - 1);
  if (pendingRequests > 0) return;
  clearInterval(progressTimer);
  const fill = document.getElementById("progressFill");
  fill.style.width = "100%";
  setTimeout(() => fill.classList.remove("active"), 300);
  setTimeout(() => { fill.style.width = "0%"; }, 550);
}

// wrap a button with a spinner + disabled state while an async fn runs
async function withLoading(btn, fn) {
  if (btn) { btn.classList.add("is-loading"); btn.disabled = true; }
  try {
    return await fn();
  } finally {
    if (btn) { btn.classList.remove("is-loading"); btn.disabled = false; }
  }
}

function skeleton(container, label = "Loading…") {
  container.innerHTML = `
    <div class="skeleton-row">
      <span class="skeleton-dot"></span><span class="skeleton-dot"></span><span class="skeleton-dot"></span>
      <span>${label}</span>
    </div>`;
}

async function api(path, options = {}) {
  startProgress();
  try {
    const res = await fetch(path, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast(data.error || "Something went wrong.", "error");
      throw new Error(data.error || "request failed");
    }
    return data;
  } finally {
    finishProgress();
  }
}

function renderTable(container, rows, maxRows = 15) {
  if (!rows || rows.length === 0) {
    container.innerHTML = `<p class="muted" style="padding:14px;">No rows to show.</p>`;
    return;
  }
  const cols = Object.keys(rows[0]);
  let html = "<table class='data-table'><thead><tr>";
  cols.forEach(c => html += `<th>${c}</th>`);
  html += "</tr></thead><tbody>";
  rows.slice(0, maxRows).forEach(r => {
    html += "<tr>";
    cols.forEach(c => {
      let v = r[c];
      if (v === null || v === undefined) v = "—";
      if (typeof v === "number") v = Number.isInteger(v) ? v : v.toFixed(3);
      html += `<td>${v}</td>`;
    });
    html += "</tr>";
  });
  html += "</tbody></table>";
  container.innerHTML = html;
}

function fillSelect(select, options, placeholder) {
  select.innerHTML = "";
  if (placeholder) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = placeholder;
    select.appendChild(o);
  }
  options.forEach(opt => {
    const o = document.createElement("option");
    o.value = opt; o.textContent = opt;
    select.appendChild(o);
  });
}

// ---------------------------------------------------------------- navigation
function goToStep(n) {
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  document.getElementById(`panel-${n}`).classList.add("active");

  document.querySelectorAll(".pipe-step").forEach(btn => {
    const s = parseInt(btn.dataset.step);
    btn.classList.remove("active", "complete");
    if (s === n) btn.classList.add("active");
    else if (s < state.maxStepReached) btn.classList.add("complete");
  });

  document.getElementById("stepEyebrow").textContent = stepMeta[n].eyebrow;
  document.getElementById("stepTitle").textContent = stepMeta[n].title;

  if (n === 3) prepStep3();
  if (n === 4) { skeleton(document.getElementById("statsTable"), "Crunching statistics…"); prepStep4(); }
  if (n === 5) prepStep5();
  if (n === 6) prepStep6Chat();
  if (n === 7) prepStep7();
}

function unlockStep(n) {
  state.maxStepReached = Math.max(state.maxStepReached, n);
  const btn = document.querySelector(`.pipe-step[data-step="${n}"]`);
  btn.disabled = false;
}

document.querySelectorAll(".pipe-step").forEach(btn => {
  btn.addEventListener("click", () => {
    if (!btn.disabled) goToStep(parseInt(btn.dataset.step));
  });
});

// ---------------------------------------------------------------- state sync
function applyStateSummary(data) {
  state.loaded = true;
  state.baseName = data.base_name;
  state.columns = data.columns;
  state.dtypes = data.dtypes;
  state.numeric = data.numeric_columns;
  state.categorical = data.categorical_columns;
  state.datetime = data.datetime_columns;

  document.getElementById("datasetChip").classList.add("loaded");
  document.getElementById("datasetName").textContent =
    `${data.base_name} · ${data.rows}×${data.cols}`;

  document.getElementById("statRow").innerHTML = `
    <div class="stat"><b>${data.rows}</b><span>rows</span></div>
    <div class="stat"><b>${data.cols}</b><span>columns</span></div>
    <div class="stat"><b>${Object.keys(data.missing).length}</b><span>cols w/ gaps</span></div>
  `;

  document.getElementById("logBox").textContent = data.log.map(l => `· ${l}`).join("\n");

  const undoBtn = document.getElementById("undoBtn");
  undoBtn.disabled = !data.undo_depth;
  undoBtn.title = data.undo_depth ? `Undo the last change (${data.undo_depth} step${data.undo_depth > 1 ? "s" : ""} available)` : "Nothing to undo";
  document.getElementById("resetBtn").disabled = !data.can_reset;

  renderMissingList(data.missing);
  renderColumnEditor();
  renderTextTools();
  document.getElementById("dupeText").textContent =
    data.duplicates > 0 ? `${data.duplicates} duplicate row(s) found.` : "No duplicate rows found.";
  document.getElementById("removeDupesBtn").disabled = data.duplicates === 0;
}

// ---------------------------------------------------------------- undo / reset
function refreshActiveStep() {
  const active = document.querySelector(".panel.active");
  const n = active ? parseInt(active.id.replace("panel-", "")) : 1;
  document.getElementById("outlierResult").classList.add("hidden");
  if (n === 3) prepStep3();
  if (n === 4) prepStep4();
  if (n === 5) prepStep5();
  if (n === 7) prepStep7();
}

async function historyAction(path, doneMsg) {
  // Not withLoading(): it would re-enable the buttons after applyStateSummary
  // has decided whether they should be disabled.
  const btns = [document.getElementById("undoBtn"), document.getElementById("resetBtn")];
  btns.forEach(b => b.disabled = true);
  try {
    const data = await api(path, { method: "POST" });
    applyStateSummary(data);
    renderTable(document.getElementById("previewTable"), data.preview);
    document.getElementById("previewMeta").textContent = `${data.rows} rows × ${data.cols} columns`;
    refreshActiveStep();
    toast(doneMsg);
  } catch (e) {
    const s = await api("/api/state").catch(() => null);  // restore button state
    if (s) applyStateSummary(s);
  }
}

document.getElementById("undoBtn").onclick = () =>
  historyAction("/api/undo", "Last change undone.");

document.getElementById("resetBtn").onclick = () => {
  if (!confirm("Discard all changes and restore the original upload?")) return;
  historyAction("/api/reset", "Restored the original upload.");
};

// ============================================================================
// STEP 1 — COLLECT
// ============================================================================
const dropzone = document.getElementById("dropzone");

dropzone.addEventListener("click", () => document.getElementById("fileInput").click());
dropzone.addEventListener("dragover", e => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", e => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
document.getElementById("fileInput").addEventListener("change", () => {
  const f = document.getElementById("fileInput");
  if (f.files.length) handleFile(f.files[0]);
});

let pendingFile = null;

async function handleFile(file, extra = {}) {
  pendingFile = file;
  const fd = new FormData();
  fd.append("file", file);
  Object.entries(extra).forEach(([k, v]) => fd.append(k, v));

  document.getElementById("dropzone").classList.add("is-loading-zone");
  skeleton(document.getElementById("dropzone"), "Reading your file…");

  let data;
  try {
    startProgress();
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    data = await res.json();
  } finally {
    finishProgress();
    restoreDropzone();
  }

  if (data.error) { toast(data.error, "error"); return; }

  if (data.need_sheet) {
    const optionsDiv = document.getElementById("uploadOptions");
    optionsDiv.classList.remove("hidden");
    optionsDiv.innerHTML = `
      <span class="muted">Multiple sheets found:</span>
      <select id="sheetSelect">${data.sheets.map(s => `<option value="${s}">${s}</option>`).join("")}</select>
      <button class="btn btn-secondary" id="loadSheetBtn">Load sheet</button>
    `;
    const loadBtn = document.getElementById("loadSheetBtn");
    loadBtn.onclick = () => withLoading(loadBtn, () =>
      handleFile(pendingFile, { sheet: document.getElementById("sheetSelect").value }));
    return;
  }

  onUploadSuccess(data);
}

function restoreDropzone() {
  const dz = document.getElementById("dropzone");
  dz.classList.remove("is-loading-zone");
  dz.innerHTML = `
    <input type="file" id="fileInput" accept=".xlsx,.xls,.csv,.txt" hidden>
    <p class="drop-icon">⇪</p>
    <p class="drop-text">Drop a file here, or <span class="link">browse</span></p>
    <p class="drop-hint">.xlsx · .xls · .csv · .txt</p>
  `;
  document.getElementById("fileInput").addEventListener("change", () => {
    const f = document.getElementById("fileInput");
    if (f.files.length) handleFile(f.files[0]);
  });
}

function onUploadSuccess(data) {
  applyStateSummary(data);
  document.getElementById("previewCard").classList.remove("hidden");
  document.getElementById("previewMeta").textContent = `${data.rows} rows × ${data.cols} columns`;
  renderTable(document.getElementById("previewTable"), data.preview);
  unlockStep(2);
  chat.history = [];
  document.getElementById("chatLog").innerHTML = "";
  toast(`Loaded ${data.base_name} — ${data.rows} rows.`);
}

document.getElementById("toCleanBtn").onclick = () => goToStep(2);

// ============================================================================
// STEP 2 — CLEAN
// ============================================================================
document.getElementById("removeDupesBtn").onclick = () =>
  withLoading(document.getElementById("removeDupesBtn"), async () => {
    const data = await api("/api/clean/duplicates", { method: "POST" });
    applyStateSummary(data);
    toast("Duplicates removed.");
  });

const fillOptionsNumeric = [
  ["mean", "Fill with mean (average)"],
  ["median", "Fill with median (middle value)"],
  ["mode", "Fill with mode (most common)"],
  ["custom", "Fill with a custom value"],
  ["drop", "Drop rows with this gap"],
  ["skip", "Leave as-is"],
];
const fillOptionsText = [
  ["mode", "Fill with mode (most common)"],
  ["custom", "Fill with a custom value"],
  ["drop", "Drop rows with this gap"],
  ["skip", "Leave as-is"],
];

function renderMissingList(missing) {
  const container = document.getElementById("missingList");
  const cols = Object.keys(missing);
  if (cols.length === 0) {
    container.innerHTML = `<p class="all-clear">✓ No missing values — you're clean.</p>`;
    return;
  }
  container.innerHTML = "";
  cols.forEach(col => {
    const isNumeric = state.numeric.includes(col);
    const options = isNumeric ? fillOptionsNumeric : fillOptionsText;
    const row = document.createElement("div");
    row.className = "missing-row";
    row.innerHTML = `
      <span class="col-name">${col}</span>
      <span class="col-count">${missing[col]} missing</span>
      <select class="fill-method">
        ${options.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}
      </select>
      <input type="text" class="fill-custom hidden" placeholder="value…">
      <button class="btn btn-primary apply-fill">Apply</button>
    `;
    const methodSelect = row.querySelector(".fill-method");
    const customInput = row.querySelector(".fill-custom");
    methodSelect.addEventListener("change", () => {
      customInput.classList.toggle("hidden", methodSelect.value !== "custom");
    });
    row.querySelector(".apply-fill").addEventListener("click", () => {
      const applyBtn = row.querySelector(".apply-fill");
      withLoading(applyBtn, async () => {
        const data = await api("/api/clean/missing", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            column: col, method: methodSelect.value, custom_value: customInput.value,
          }),
        });
        applyStateSummary(data);
        toast(`'${col}' updated.`);
      });
    });
    container.appendChild(row);
  });
}

// ---- column editor: rename / reorder / drop, applied as one undoable step ----
let colDraft = [];

function renderColumnEditor() {
  colDraft = state.columns.map(c => ({ name: c, new_name: String(c), dropped: false }));
  drawColumnEditor();
}

function drawColumnEditor() {
  document.getElementById("columnList").innerHTML = colDraft.map((c, i) => `
    <div class="col-edit-row${c.dropped ? " is-dropped" : ""}" data-i="${i}">
      <button type="button" class="btn btn-secondary btn-sm" data-act="up" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
      <button type="button" class="btn btn-secondary btn-sm" data-act="down" aria-label="Move down" ${i === colDraft.length - 1 ? "disabled" : ""}>↓</button>
      <input type="text" class="col-name-input" value="${esc(c.new_name)}" ${c.dropped ? "disabled" : ""}>
      <span class="muted mono col-orig">${c.new_name !== String(c.name) ? "was " + esc(c.name) : ""}</span>
      <button type="button" class="btn btn-secondary btn-sm" data-act="drop">${c.dropped ? "Restore" : "Drop"}</button>
    </div>`).join("");
}

document.getElementById("columnList").addEventListener("input", e => {
  const row = e.target.closest(".col-edit-row");
  if (!row || !e.target.classList.contains("col-name-input")) return;
  const c = colDraft[+row.dataset.i];
  c.new_name = e.target.value;
  row.querySelector(".col-orig").textContent = c.new_name !== String(c.name) ? "was " + c.name : "";
});

document.getElementById("columnList").addEventListener("click", e => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const i = +btn.closest(".col-edit-row").dataset.i;
  if (btn.dataset.act === "drop") colDraft[i].dropped = !colDraft[i].dropped;
  else {
    const j = btn.dataset.act === "up" ? i - 1 : i + 1;
    [colDraft[i], colDraft[j]] = [colDraft[j], colDraft[i]];
  }
  drawColumnEditor();
});

document.getElementById("applyColumnsBtn").onclick = () =>
  withLoading(document.getElementById("applyColumnsBtn"), async () => {
    const columns = colDraft.filter(c => !c.dropped).map(c => ({ name: c.name, new_name: c.new_name }));
    if (!columns.length) { toast("Keep at least one column.", "error"); return; }
    const data = await api("/api/clean/columns", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ columns }),
    });
    applyStateSummary(data);
    renderTable(document.getElementById("previewTable"), data.preview);
    document.getElementById("previewMeta").textContent = `${data.rows} rows × ${data.cols} columns`;
    toast("Columns updated.");
  });

// ---- text tools: cleanup, merge similar labels, find & replace ----
function renderTextTools() {
  [["textCol", state.categorical], ["mergeCol", state.categorical], ["replCol", state.columns]].forEach(([id, opts]) => {
    const el = document.getElementById(id), prev = el.value;
    fillSelect(el, opts);
    if (opts.includes(prev)) el.value = prev;
  });
  document.getElementById("mergeResult").innerHTML = "";
}

const postJSON = (path, body) => api(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

document.getElementById("textCleanBtn").onclick = () =>
  withLoading(document.getElementById("textCleanBtn"), async () => {
    const column = document.getElementById("textCol").value;
    if (!column) { toast("Pick a text column first.", "error"); return; }
    const data = await postJSON("/api/clean/text", {
      column, trim: document.getElementById("textTrim").checked,
      blank_to_missing: document.getElementById("textBlank").checked,
      case: document.getElementById("textCase").value,
    });
    applyStateSummary(data);
    toast(`'${column}' cleaned.`);
  });

document.getElementById("replaceBtn").onclick = () =>
  withLoading(document.getElementById("replaceBtn"), async () => {
    const column = document.getElementById("replCol").value;
    const data = await postJSON("/api/clean/replace", {
      column, find: document.getElementById("replFind").value, replace: document.getElementById("replWith").value,
      mode: document.getElementById("replMode").value, case_sensitive: document.getElementById("replCase").checked,
    });
    applyStateSummary(data);
    toast(`Replaced in '${column}'.`);
  });

let lastClusters = [], lastMergeCol = "";

document.getElementById("findSimilarBtn").onclick = () =>
  withLoading(document.getElementById("findSimilarBtn"), async () => {
    const column = document.getElementById("mergeCol").value;
    if (!column) { toast("Pick a text column first.", "error"); return; }
    const data = await postJSON("/api/clean/similar", { column, threshold: +document.getElementById("mergeSens").value });
    lastClusters = data.clusters; lastMergeCol = column;
    const box = document.getElementById("mergeResult");
    if (!data.clusters.length) {
      box.innerHTML = `<p class="all-clear">✓ No similar labels found in '${esc(column)}' (${data.distinct} distinct).</p>`;
      return;
    }
    box.innerHTML = data.clusters.map((c, i) => `
      <div class="merge-row" data-i="${i}">
        <label class="check"><input type="checkbox" class="merge-on" ${c.kind === "same" ? "checked" : ""}>
          <span class="muted mono">${c.kind === "same" ? "same text" : "similar"}</span></label>
        <span class="merge-labels">${c.labels.map(l => `${esc(l.value)} <small>×${l.count}</small>`).join(" · ")}</span>
        <span class="muted mono">→ keep</span>
        <select class="merge-target">${c.labels.map(l => `<option value="${esc(l.value)}">${esc(l.value)}</option>`).join("")}</select>
      </div>`).join("") + `<button class="btn btn-primary" id="applyMergeBtn">Merge selected</button>`;
    document.getElementById("applyMergeBtn").onclick = () => withLoading(document.getElementById("applyMergeBtn"), async () => {
      const mapping = {};
      box.querySelectorAll(".merge-row").forEach(row => {
        if (!row.querySelector(".merge-on").checked) return;
        const target = row.querySelector(".merge-target").value;
        lastClusters[+row.dataset.i].labels.forEach(l => { if (l.value !== target) mapping[l.value] = target; });
      });
      if (!Object.keys(mapping).length) { toast("Tick at least one group to merge.", "error"); return; }
      const res = await postJSON("/api/clean/merge", { column: lastMergeCol, mapping });
      applyStateSummary(res);
      toast(`Labels merged in '${lastMergeCol}'.`);
    });
  });

document.getElementById("toValidateBtn").onclick = () => { unlockStep(3); goToStep(3); };

// ============================================================================
// STEP 3 — VALIDATE
// ============================================================================
function prepStep3() {
  fillSelect(document.getElementById("convertCol"), state.columns);
  fillSelect(document.getElementById("outlierCol"), state.numeric);
  renderDtypeTable();
  renderOutlierParams();
}

function renderDtypeTable() {
  const rows = state.columns.map(c => ({ column: c, dtype: state.dtypes[c] }));
  renderTable(document.getElementById("dtypeTable"), rows, 50);
}

document.getElementById("convertBtn").onclick = () =>
  withLoading(document.getElementById("convertBtn"), async () => {
    const column = document.getElementById("convertCol").value;
    const type = document.getElementById("convertType").value;
    const data = await api("/api/validate/convert", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ column, type }),
    });
    applyStateSummary(data);
    prepStep3();
    toast(`'${column}' converted to ${type}.`);
  });

document.getElementById("outlierMethod").addEventListener("change", renderOutlierParams);
function renderOutlierParams() {
  const method = document.getElementById("outlierMethod").value;
  const container = document.getElementById("outlierParams");
  if (method === "zscore") {
    container.innerHTML = `
      <label class="muted mono" style="font-size:11px;">threshold</label>
      <select id="zThreshold"><option value="2">2 (strict)</option><option value="2.5">2.5</option><option value="3" selected>3 (standard)</option></select>`;
  } else if (method === "percentile") {
    container.innerHTML = `
      <label class="muted mono" style="font-size:11px;">low %</label>
      <input type="number" id="pctLow" value="1" style="width:60px;">
      <label class="muted mono" style="font-size:11px;">high %</label>
      <input type="number" id="pctHigh" value="99" style="width:60px;">`;
  } else {
    container.innerHTML = "";
  }
}

document.getElementById("detectBtn").onclick = () =>
  withLoading(document.getElementById("detectBtn"), async () => {
  const column = document.getElementById("outlierCol").value;
  const method = document.getElementById("outlierMethod").value;
  if (!column) { toast("Pick a numeric column first.", "error"); return; }
  let params = {};
  if (method === "zscore") params.threshold = document.getElementById("zThreshold").value;
  if (method === "percentile") {
    params.low = document.getElementById("pctLow").value;
    params.high = document.getElementById("pctHigh").value;
  }

  const data = await api("/api/validate/outliers/detect", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ column, method, params }),
  });

  const methodLabels = { iqr: "IQR", zscore: "Z-score", percentile: "Percentile" };
  const resultDiv = document.getElementById("outlierResult");
  resultDiv.classList.remove("hidden");

  if (data.count === 0) {
    resultDiv.innerHTML = `<p class="all-clear">✓ No outliers found using ${methodLabels[method]}.</p>`;
    return;
  }

  resultDiv.innerHTML = `
    <p class="range">Normal range: [${data.lower.toFixed(2)}, ${data.upper.toFixed(2)}] — <b>${data.count}</b> potential outlier(s)</p>
    <div class="treat-row">
      <button class="btn btn-secondary" data-treat="cap">Cap to range</button>
      <button class="btn btn-danger" data-treat="remove">Remove rows</button>
      <button class="btn btn-secondary" data-treat="leave">Leave as-is</button>
    </div>
  `;
  resultDiv.querySelectorAll("[data-treat]").forEach(btn => {
    btn.addEventListener("click", () => withLoading(btn, async () => {
      const result = await api("/api/validate/outliers/treat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          column, lower: data.lower, upper: data.upper,
          treatment: btn.dataset.treat, method_label: methodLabels[method],
        }),
      });
      applyStateSummary(result);
      resultDiv.classList.add("hidden");
      toast(`Outlier treatment applied to '${column}'.`);
    }));
  });
  });

document.getElementById("toAnalyzeBtn").onclick = () => { unlockStep(4); goToStep(4); };

// ============================================================================
// STEP 4 — ANALYZE
// ============================================================================
async function prepStep4() {
  const corrContainer = document.getElementById("corrTable");
  skeleton(corrContainer, "Computing correlations…");

  const summary = await api("/api/analyze/summary");
  renderTable(document.getElementById("statsTable"), summary.rows, 50);

  const corr = await api("/api/analyze/correlation");
  if (corr.columns.length) {
    const rows = corr.matrix.map((row, i) => {
      const r = { column: corr.columns[i] };
      corr.columns.forEach((c, j) => r[c] = row[j]);
      return r;
    });
    renderTable(corrContainer, rows, 50);
  } else {
    corrContainer.innerHTML = `<p class="muted" style="padding:14px;">Need at least two numeric columns.</p>`;
  }

  fillSelect(document.getElementById("groupCol"), state.categorical);
  fillSelect(document.getElementById("groupNumCol"), state.numeric);
}

document.getElementById("groupByBtn").onclick = () =>
  withLoading(document.getElementById("groupByBtn"), async () => {
    const groupTable = document.getElementById("groupTable");
    skeleton(groupTable, "Grouping…");
    const group_col = document.getElementById("groupCol").value;
    const num_col = document.getElementById("groupNumCol").value;
    const data = await api("/api/analyze/groupby", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_col, num_col }),
    });
    renderTable(groupTable, data.rows, 50);
  });

document.getElementById("toVisualizeBtn").onclick = () => { unlockStep(5); goToStep(5); };

// ============================================================================
// STEP 5 — VISUALIZE
// ============================================================================
let currentChartType = "histogram";

document.querySelectorAll(".chart-type-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".chart-type-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentChartType = btn.dataset.type;
    renderChartParams();
  });
});

function prepStep5() { renderChartParams(); dashInit().catch(() => {}); }

function renderChartParams() {
  const container = document.getElementById("chartParams");
  const num = state.numeric, cat = state.categorical, dt = state.datetime;
  const opt = (arr, id, placeholder) =>
    `<select id="${id}">${placeholder ? `<option value="">${placeholder}</option>` : ""}${arr.map(c => `<option value="${c}">${c}</option>`).join("")}</select>`;

  if (currentChartType === "histogram") {
    container.innerHTML = `${opt(num, "p_col")}`;
  } else if (currentChartType === "boxplot") {
    container.innerHTML = `${opt(num, "p_col")} ${opt(cat, "p_group", "(no grouping)")}`;
  } else if (currentChartType === "bar_counts") {
    container.innerHTML = `${opt(cat, "p_col")}`;
  } else if (currentChartType === "bar_avg") {
    container.innerHTML = `Group ${opt(cat, "p_group_col")} Average ${opt(num, "p_num_col")}`;
  } else if (currentChartType === "line") {
    container.innerHTML = `X ${opt([...dt, ...num], "p_x")} Y ${opt(num, "p_y")}`;
  } else if (currentChartType === "scatter") {
    container.innerHTML = `X ${opt(num, "p_x")} Y ${opt(num, "p_y")} Color ${opt(cat, "p_hue", "(none)")}`;
  } else if (currentChartType === "pie") {
    container.innerHTML = `${opt(cat, "p_col")}`;
  } else if (currentChartType === "heatmap") {
    container.innerHTML = `<span class="muted">Uses all numeric columns.</span>`;
  }
}

// ---- interactive charts (Plotly) ------------------------------------------
const PALETTES = {
  default:    ["#2A6F6F", "#D9A441", "#3F8F5F", "#16213E", "#E4572E", "#7FA99B", "#C9A66B", "#5C6F7C"],
  vivid:      ["#636EFA", "#EF553B", "#00CC96", "#AB63FA", "#FFA15A", "#19D3F3", "#FF6692", "#B6E880"],
  pastel:     ["#8DD3C7", "#FFFFB3", "#BEBADA", "#FB8072", "#80B1D3", "#FDB462", "#B3DE69", "#FCCDE5"],
  colorblind: ["#0072B2", "#E69F00", "#009E73", "#D55E00", "#CC79A7", "#56B4E9", "#F0E442", "#000000"],
};
const PALETTE_LABELS = { custom: "Shades of my colour", default: "App default", vivid: "Vivid", pastel: "Pastel", colorblind: "Colour-blind safe" };
const COLORSCALES = {
  coolwarm: [[0, "#3b4cc0"], [0.5, "#f7f7f7"], [1, "#b40426"]],
  Viridis: "Viridis", Cividis: "Cividis", Blues: "Blues", YlOrRd: "YlOrRd",
};

const chartStore = {};   // name -> {name, spec, style}; kept in sync with the server
const saveTimers = {};
const esc = s => String(s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

function hexToHsl(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return "#" + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
}
function colorsFor(style, n) {
  if (style.palette === "custom") {
    const [h, s] = hexToHsl(style.color);
    return Array.from({ length: n }, (_, i) => hslToHex(h, Math.max(s, 0.35), n === 1 ? 0.45 : 0.3 + 0.45 * i / (n - 1)));
  }
  const p = PALETTES[style.palette] || PALETTES.default;
  return Array.from({ length: n }, (_, i) => p[i % p.length]);
}
const isMulti = spec => spec.type === "pie" || (spec.type === "scatter" && !!spec.hue);

function buildFigure(spec, style) {
  const c = style.color, t = spec.type;
  const coarse = window.matchMedia("(pointer: coarse)").matches;   // let touch users scroll the page
  const axis = title => ({ title: { text: title || "" }, automargin: true, gridcolor: "#ECEAE4", zerolinecolor: "#D9D5CB" });
  const layout = {
    title: { text: esc(spec.title), x: 0.02, xanchor: "left", font: { size: 15 } },
    font: { family: "Inter, system-ui, sans-serif", size: 12, color: "#16213E" },
    paper_bgcolor: "#fff", plot_bgcolor: "#fff", showlegend: false, hovermode: "closest",
    margin: { l: 56, r: 20, t: 48, b: 48 }, dragmode: coarse ? false : "zoom", uirevision: "keep",
    xaxis: axis(spec.x_label), yaxis: axis(spec.y_label),
  };
  let data = [];

  if (t === "histogram") {
    data = [{ type: "histogram", x: spec.values, marker: { color: c, line: { color: "#fff", width: 1 } },
              hovertemplate: "%{x}<br>Count: %{y}<extra></extra>" }];
    layout.yaxis = axis("Count");
  } else if (t === "boxplot") {
    const names = Object.keys(spec.groups);
    data = names.map(n => ({ type: "box", y: spec.groups[n], name: n, marker: { color: c }, boxpoints: "outliers" }));
    if (names.length === 1 && names[0] === "") layout.xaxis.showticklabels = false;
  } else if (t === "bar_counts" || t === "bar_avg") {
    data = [{ type: "bar", orientation: "h", x: spec.values, y: spec.labels, marker: { color: c },
              hovertemplate: "%{y}: %{x:,.2f}<extra></extra>" }];
    layout.yaxis = { ...axis(""), autorange: "reversed" };
  } else if (t === "line") {
    data = [{ type: "scatter", mode: "lines", x: spec.x, y: spec.y, line: { color: c, width: 2 } }];
  } else if (t === "scatter") {
    const names = Object.keys(spec.groups), cols = colorsFor(style, names.length);
    data = names.map((n, i) => ({ type: "scatter", mode: "markers", name: n, x: spec.groups[n].x, y: spec.groups[n].y,
                                  marker: { color: spec.hue ? cols[i] : c, size: 7, opacity: 0.75 } }));
    if (spec.hue) { layout.showlegend = true; layout.legend = { title: { text: spec.hue } }; }
  } else if (t === "pie") {
    data = [{ type: "pie", labels: spec.labels, values: spec.values, sort: false, textinfo: "percent",
              marker: { colors: colorsFor(style, spec.labels.length) },
              hovertemplate: "%{label}: %{value} (%{percent})<extra></extra>" }];
    layout.showlegend = true;
  } else if (t === "heatmap") {
    data = [{ type: "heatmap", z: spec.matrix, x: spec.columns, y: spec.columns, zmin: -1, zmax: 1,
              colorscale: COLORSCALES[style.colorscale] || COLORSCALES.coolwarm, texttemplate: "%{z:.2f}",
              hovertemplate: "%{y} × %{x}: %{z:.3f}<extra></extra>" }];
    layout.yaxis = { ...axis(""), autorange: "reversed" };
    layout.xaxis = axis("");
    layout.margin = { l: 90, r: 20, t: 48, b: 80 };
  }
  return { data, layout };
}

const plotConfig = name => ({ responsive: true, displaylogo: false,
  toImageButtonOptions: { format: "png", filename: name, scale: 2 } });

function drawCard(card) {
  const entry = chartStore[card.dataset.name];
  const fig = buildFigure(entry.spec, entry.style);
  Plotly.react(card.querySelector(".chart-plot"), fig.data, fig.layout, plotConfig(entry.name));
}

function syncControls(card, style) {
  const set = (sel, v) => { const el = card.querySelector(sel); if (el) el.value = v; };
  set(".ct-color", style.color); set(".ct-palette", style.palette); set(".ct-scale", style.colorscale);
}

function updateStyle(name, patch) {
  const entry = chartStore[name];
  if (!entry) return;
  Object.assign(entry.style, patch);
  document.querySelectorAll(".chart-card").forEach(card => {
    if (card.dataset.name !== name) return;
    syncControls(card, entry.style);
    drawCard(card);
  });
  clearTimeout(saveTimers[name]);   // persist so the gallery reloads with the same look
  saveTimers[name] = setTimeout(() => {
    fetch(`/api/charts/${encodeURIComponent(name)}/style`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(entry.style),
    }).catch(() => {});
  }, 400);
}

function chartCard(entry) {
  chartStore[entry.name] = entry;
  const { spec, style } = entry;
  const card = document.createElement("div");
  card.className = "chart-card";
  card.dataset.name = entry.name;
  const opts = (obj, labels) => Object.keys(obj).map(k => `<option value="${k}">${labels ? labels[k] : k}</option>`).join("");
  let tools = "";
  if (spec.type === "heatmap") {
    tools = `<label>Colour scale <select class="ct-scale">${opts(COLORSCALES)}</select></label>`;
  } else {
    tools = `<label>Colour <input type="color" class="ct-color"></label>`;
    if (isMulti(spec)) tools += `<label>Palette <select class="ct-palette">${opts(PALETTE_LABELS, PALETTE_LABELS)}</select></label>`;
  }
  card.innerHTML = `
    <div class="chart-toolbar">${tools}</div>
    <div class="chart-plot${spec.type === "pie" || spec.type === "heatmap" ? " tall" : ""}"></div>
    ${spec.note ? `<p class="chart-note">${esc(spec.note)}</p>` : ""}`;
  syncControls(card, style);
  card.querySelector(".ct-color")?.addEventListener("input", e =>
    updateStyle(entry.name, isMulti(spec) ? { color: e.target.value, palette: "custom" } : { color: e.target.value }));
  card.querySelector(".ct-palette")?.addEventListener("change", e => updateStyle(entry.name, { palette: e.target.value }));
  card.querySelector(".ct-scale")?.addEventListener("change", e => updateStyle(entry.name, { colorscale: e.target.value }));
  return card;
}

function purgeCharts(container) {
  container.querySelectorAll(".chart-plot").forEach(el => Plotly.purge(el));
}

document.getElementById("generateChartBtn").onclick = () =>
  withLoading(document.getElementById("generateChartBtn"), async () => {
    const g = id => document.getElementById(id)?.value;
    let params = {};
    if (currentChartType === "histogram") params = { column: g("p_col") };
    else if (currentChartType === "boxplot") params = { column: g("p_col"), group: g("p_group") || null };
    else if (currentChartType === "bar_counts") params = { column: g("p_col") };
    else if (currentChartType === "bar_avg") params = { group_col: g("p_group_col"), num_col: g("p_num_col") };
    else if (currentChartType === "line") params = { x_col: g("p_x"), y_col: g("p_y") };
    else if (currentChartType === "scatter") params = { x_col: g("p_x"), y_col: g("p_y"), hue: g("p_hue") || null };
    else if (currentChartType === "pie") params = { column: g("p_col") };

    const preview = document.getElementById("chartPreview");
    preview.classList.remove("hidden");
    purgeCharts(preview);
    skeleton(preview, "Building chart…");

    let data;
    try {
      data = await api("/api/visualize/chart", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: currentChartType, params }),
      });
    } catch (e) { preview.classList.add("hidden"); throw e; }

    preview.innerHTML = "";
    preview.appendChild(chartCard({ name: data.name, spec: data.spec, style: data.style }));
    drawCard(preview.firstChild);

    await loadGallery();
    toast(`Chart '${data.name}' added to gallery.`);
  });

async function loadGallery() {
  const data = await api("/api/charts");
  document.getElementById("chartCount").textContent = `${data.charts.length} chart${data.charts.length === 1 ? "" : "s"}`;
  const gallery = document.getElementById("chartGallery");
  purgeCharts(gallery);
  gallery.innerHTML = "";
  data.charts.forEach(c => {
    const fig = document.createElement("figure");
    fig.dataset.name = c.name;
    fig.appendChild(chartCard(c));
    fig.insertAdjacentHTML("beforeend", `
      <figcaption>${esc(c.name)}
        <button type="button" class="chart-remove-btn" title="Remove chart" aria-label="Remove chart ${esc(c.name)}">&times;</button>
      </figcaption>`);
    gallery.appendChild(fig);
    drawCard(fig.querySelector(".chart-card"));
  });
  // keep the preview in step with the freshly loaded copy of its chart
  document.querySelectorAll("#chartPreview .chart-card").forEach(card => {
    if (chartStore[card.dataset.name]) { syncControls(card, chartStore[card.dataset.name].style); drawCard(card); }
  });
}

document.getElementById("chartGallery").addEventListener("click", async (e) => {
  const btn = e.target.closest(".chart-remove-btn");
  if (!btn) return;
  const figure = btn.closest("figure");
  const name = figure.dataset.name;

  btn.disabled = true;
  try {
    await api(`/api/charts/${encodeURIComponent(name)}`, { method: "DELETE" });
    purgeCharts(figure);
    figure.remove();
    delete chartStore[name];
    const remaining = document.querySelectorAll("#chartGallery figure").length;
    document.getElementById("chartCount").textContent = `${remaining} chart${remaining === 1 ? "" : "s"}`;
    toast(`Chart '${name}' removed.`);
  } catch (err) {
    btn.disabled = false; // api() already showed the error toast
  }
});

// ---- export all charts as a zip of PNGs, built in the browser so the
// pictures match what is on screen (including your colours) ----
function crc32(b) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) {
    crc ^= b[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeZip(files) {           // minimal "stored" (uncompressed) zip; PNGs are already compressed
  const enc = new TextEncoder(), parts = [], central = [];
  let offset = 0, cdSize = 0;
  files.forEach(f => {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, size, true);
    lh.setUint32(22, size, true); lh.setUint16(26, name.length, true);
    parts.push(lh.buffer, name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true); ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + size;
    cdSize += 46 + name.length;
  });
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}

document.getElementById("exportChartsBtn").onclick = () =>
  withLoading(document.getElementById("exportChartsBtn"), async () => {
    const data = await api("/api/charts");
    if (!data.charts.length) { toast("No charts to export yet — build some in step 5.", "error"); return; }
    const tmp = document.createElement("div");
    tmp.style.cssText = "position:fixed;left:-9999px;top:0;width:900px;height:540px;";
    document.body.appendChild(tmp);
    const files = [];
    try {
      for (const c of data.charts) {
        const fig = buildFigure(c.spec, c.style);
        Object.assign(fig.layout, { width: 900, height: 540 });
        await Plotly.newPlot(tmp, fig.data, fig.layout, { staticPlot: true });
        const url = await Plotly.toImage(tmp, { format: "png", width: 900, height: 540, scale: 2 });
        files.push({ name: `${c.name}.png`, data: Uint8Array.from(atob(url.split(",")[1]), ch => ch.charCodeAt(0)) });
        Plotly.purge(tmp);
      }
    } finally { tmp.remove(); }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(makeZip(files));
    a.download = `${state.baseName || "data"}_charts.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

document.getElementById("toChatBtn").onclick = () => { unlockStep(6); goToStep(6); };

// ============================================================================
// STEP 5b — INTERACTIVE DASHBOARD (KPI cards + slicers + several live charts)
// Tiles are drawn with the same buildFigure() as the chart gallery.
// ============================================================================
const dash = { widgets: [], kpis: [], slicers: [], filters: {}, sig: "", nextId: 1 };
const DASH_COLORS = ["#2A6F6F", "#D9A441", "#3F8F5F", "#4E79A7", "#E4572E", "#B07AA1"];
const dataSig = () => state.columns.map(c => `${c}:${state.dtypes[c]}`).join("|");
const fmtNum = v => v === null || v === undefined ? "—"
  : Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 })
  : Number.isInteger(v) ? String(v) : v.toFixed(2);

async function dashInit() {
  renderDashFields();
  const sig = dataSig();
  if (sig !== dash.sig) { dash.sig = sig; await dashAuto(); return; }
  // same columns: data may have changed (undo/reset), so drop slicer picks that no longer exist
  const auto = await api("/api/dashboard/auto");
  dash.slicers = auto.slicers;
  auto.slicers.forEach(s => { if (dash.filters[s.col] && !s.values.includes(dash.filters[s.col])) delete dash.filters[s.col]; });
  renderSlicers();
  await dashRefresh();
}

function dashClearTiles() {
  const grid = document.getElementById("dashGrid");
  grid.querySelectorAll(".dash-plot").forEach(p => Plotly.purge(p));
  grid.innerHTML = "";
}

async function dashAuto() {
  const auto = await api("/api/dashboard/auto");
  dash.widgets = auto.widgets; dash.kpis = auto.kpis; dash.slicers = auto.slicers;
  dash.filters = {}; dash.nextId = auto.widgets.length + 1;
  dashClearTiles(); renderSlicers();
  await dashRefresh();
}

function renderSlicers() {
  const box = document.getElementById("dashSlicers");
  box.innerHTML = dash.slicers.map(s => `
    <label class="slicer">${esc(s.col)}
      <select data-col="${esc(s.col)}"><option value="">All</option>
        ${s.values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join("")}
      </select>
    </label>`).join("");
  box.querySelectorAll("select").forEach(sel => {
    sel.value = dash.filters[sel.dataset.col] || "";
    sel.onchange = () => { dash.filters[sel.dataset.col] = sel.value; dashRefresh(); };
  });
}

function renderDashFields() {
  const t = document.getElementById("dw_type").value;
  const sel = (id, arr, label) => `${label} <select id="${id}">${arr.map(c => `<option>${esc(c)}</option>`).join("")}</select>`;
  const aggSel = `<select id="dw_agg"><option value="sum">Sum</option><option value="mean">Average</option><option value="count">Count</option><option value="min">Min</option><option value="max">Max</option></select>`;
  document.getElementById("dw_fields").innerHTML =
    t === "histogram" ? sel("dw_x", state.numeric, "Column")
    : t === "scatter" ? sel("dw_x", state.numeric, "X") + sel("dw_y", state.numeric, "Y")
    : sel("dw_x", state.columns, "Group by") + aggSel + sel("dw_y", state.numeric, "of");
}
document.getElementById("dw_type").onchange = renderDashFields;

document.getElementById("dashAddBtn").onclick = () => {
  const g = id => document.getElementById(id)?.value;
  if (!g("dw_x")) { toast("Pick a column first.", "error"); return; }
  dash.widgets.push({ id: dash.nextId++, type: g("dw_type"), x: g("dw_x"), y: g("dw_y") || null, agg: g("dw_agg") || "sum" });
  dashRefresh();
};
document.getElementById("dashAutoBtn").onclick = () => withLoading(document.getElementById("dashAutoBtn"), dashAuto);
document.getElementById("dashClearBtn").onclick = () => { dash.widgets = []; dashClearTiles(); dashRefresh(); };

async function dashRefresh() {
  const data = await postJSON("/api/dashboard/data", { filters: dash.filters, kpis: dash.kpis, widgets: dash.widgets });
  document.getElementById("dashRows").textContent = `${data.rows} rows in view`;
  document.getElementById("dashKpis").innerHTML = data.kpis.map(k =>
    `<div class="kpi"><b>${fmtNum(k.value)}</b><span>${esc(k.label)}</span></div>`).join("");

  const grid = document.getElementById("dashGrid");
  const ids = new Set(dash.widgets.map(w => String(w.id)));
  grid.querySelectorAll(".dash-tile").forEach(t => {            // drop tiles for removed widgets
    if (!ids.has(t.dataset.id)) { Plotly.purge(t.querySelector(".dash-plot")); t.remove(); }
  });
  dash.widgets.forEach(w => {
    const id = String(w.id);
    let tile = grid.querySelector(`.dash-tile[data-id="${id}"]`);
    if (!tile) {
      tile = document.createElement("div");
      tile.className = "dash-tile"; tile.dataset.id = id;
      tile.innerHTML = `<button type="button" class="chart-remove-btn" aria-label="Remove chart">&times;</button><div class="dash-plot"></div>`;
      tile.querySelector("button").onclick = () => { dash.widgets = dash.widgets.filter(x => x.id !== w.id); dashRefresh(); };
      grid.appendChild(tile);
    }
    drawTile(tile, w, data.widgets[id]);
  });
}

function drawTile(tile, w, spec) {
  const plot = tile.querySelector(".dash-plot");
  if (!spec || spec.error) {
    Plotly.purge(plot);
    plot.dataset.err = "1";
    plot.innerHTML = `<p class="dash-err muted">${esc(spec?.error || "No data")}</p>`;
    return;
  }
  if (plot.dataset.err) { plot.innerHTML = ""; delete plot.dataset.err; }
  const style = { color: DASH_COLORS[(w.id - 1) % DASH_COLORS.length], palette: "default", colorscale: "coolwarm" };
  const fig = buildFigure(spec, style);
  fig.layout.height = 300;
  fig.layout.title.font = { size: 13 };
  Plotly.react(plot, fig.data, fig.layout, plotConfig(`dashboard_${w.id}`));
}


// ============================================================================
// STEP 6 — ASK (chatbot)
// ============================================================================
const chat = { history: [], busy: false };

function chatEscape(t) {
  return String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// Minimal, safe formatting: escape first, then allow **bold**, `code` and line breaks.
function chatFormat(t) {
  return chatEscape(t)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\n/g, "<br>");
}

function chatAddMessage(role, text, tables = []) {
  const log = document.getElementById("chatLog");
  const el = document.createElement("div");
  el.className = `chat-msg ${role}`;
  el.innerHTML = `<div class="chat-bubble">${chatFormat(text)}</div>`;
  tables.forEach(t => {
    const wrap = document.createElement("div");
    wrap.className = "chat-table";
    wrap.innerHTML = `<p class="mono muted">${chatEscape(t.title || "Result")}${t.truncated ? " (first rows only)" : ""}</p><div class="table-scroll"></div>`;
    el.appendChild(wrap);
    renderTable(wrap.querySelector(".table-scroll"), t.rows, 50);
  });
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function chatSuggestionList() {
  const s = [];
  if (state.numeric.length && state.categorical.length)
    s.push(`What is the average ${state.numeric[0]} by ${state.categorical[0]}?`);
  if (state.categorical.length) s.push(`How many rows are there for each ${state.categorical[0]}?`);
  if (state.numeric.length) s.push(`What are the top 5 rows by ${state.numeric[0]}?`);
  s.push("Give me a quick summary of this dataset.");
  return s.slice(0, 4);
}

function prepStep6Chat() {
  const box = document.getElementById("chatSuggestions");
  box.innerHTML = "";
  if (chat.history.length) return;
  if (!document.getElementById("chatLog").children.length)
    chatAddMessage("assistant", "Hi! Ask me anything about your cleaned data. I can filter, group, rank and summarise it.");
  chatSuggestionList().forEach(q => {
    const b = document.createElement("button");
    b.className = "chat-chip";
    b.textContent = q;
    b.onclick = () => { document.getElementById("chatInput").value = q; sendChat(); };
    box.appendChild(b);
  });
}

async function sendChat() {
  const input = document.getElementById("chatInput");
  const text = input.value.trim();
  if (!text || chat.busy) return;
  chat.busy = true;
  input.value = "";
  input.style.height = "auto";
  document.getElementById("chatSuggestions").innerHTML = "";
  document.getElementById("chatSendBtn").disabled = true;
  chatAddMessage("user", text);
  const typing = chatAddMessage("assistant", "Thinking…");
  typing.classList.add("typing");
  try {
    const data = await api("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, history: chat.history.slice(-12) }),
    });
    typing.remove();
    chatAddMessage("assistant", data.reply, data.tables || []);
    chat.history.push({ role: "user", content: text }, { role: "assistant", content: data.reply });
  } catch (e) {
    typing.remove();
    chatAddMessage("assistant", "Sorry, I couldn't answer that. Please try again.");
  } finally {
    chat.busy = false;
    document.getElementById("chatSendBtn").disabled = false;
    input.focus();
  }
}

document.getElementById("chatSendBtn").onclick = sendChat;
document.getElementById("chatInput").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
document.getElementById("chatInput").addEventListener("input", e => {
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
});
document.getElementById("chatClearBtn").onclick = () => {
  chat.history = [];
  document.getElementById("chatLog").innerHTML = "";
  prepStep6Chat();
};

// ============================================================================
// STEP 7 — EXPORT
// ============================================================================
document.getElementById("toExportBtn").onclick = () => { unlockStep(7); goToStep(7); };

async function prepStep7() {
  wbInit().catch(() => {});
  const data = await api("/api/state");
  document.getElementById("logBox").textContent = data.log.map(l => `· ${l}`).join("\n");
}


// ============================================================================
// STEP 7a — WORKBENCH (Tableau-style: drag fields to shelves, filter, color)
// ============================================================================
const WB_RECORDS = "Number of Records";
const WB_COLORS = ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948", "#B07AA1", "#FF9DA7", "#9C755F", "#BAB0AC"];
const WB_AGGS = ["sum", "mean", "count", "min", "max"];
const wb = { sig: "", cols: [], rows: [], color: null, filters: [], mark: "auto", drawn: false, timer: null, seq: 0 };
const wbEl = id => document.getElementById(id);

async function wbInit() {
  const sig = dataSig();
  if (sig !== wb.sig) {
    wb.sig = sig; wb.cols = []; wb.rows = []; wb.color = null; wb.filters = [];
    const dim = state.categorical[0] || state.datetime[0];
    if (dim) wb.cols.push({ kind: "dim", col: dim });
    wb.rows.push(state.numeric[0] ? { kind: "meas", col: state.numeric[0], agg: "sum" }
                                  : { kind: "meas", col: WB_RECORDS, agg: "count" });
  } else {
    // same columns: values may have changed (undo/reset), so refresh each filter's list
    for (const f of wb.filters) {
      const r = await postJSON("/api/workbench/values", { column: f.col });
      const wasAll = f.selected.size === f.values.length;
      f.values = r.values;
      f.selected = wasAll ? new Set(r.values) : new Set(r.values.filter(v => f.selected.has(v)));
    }
  }
  wbRenderFields(); wbRenderShelves(); wbRenderFilters(); wbQuery();
}

function wbRenderFields() {
  const pill = (kind, c) => `<div class="wb-pill ${kind}" draggable="true" data-kind="${kind}" data-col="${esc(c)}">${esc(c)}</div>`;
  wbEl("wbDims").innerHTML = [...state.categorical, ...state.datetime].map(c => pill("dim", c)).join("") || '<span class="muted">none</span>';
  wbEl("wbMeas").innerHTML = [...state.numeric, WB_RECORDS].map(c => pill("meas", c)).join("");
}

function wbRenderShelves() {
  const x = (shelf, c) => `<button type="button" class="wb-x" data-shelf="${shelf}" data-col="${esc(c)}" aria-label="Remove">&times;</button>`;
  const shelfPill = (p, shelf) => {
    const agg = p.kind === "meas" && p.col !== WB_RECORDS
      ? `<select class="wb-agg" data-shelf="${shelf}" data-col="${esc(p.col)}">${WB_AGGS.map(a =>
          `<option value="${a}" ${a === p.agg ? "selected" : ""}>${a === "mean" ? "AVG" : a.toUpperCase()}</option>`).join("")}</select>` : "";
    return `<span class="wb-pill ${p.kind}" draggable="true" data-from="${shelf}" data-kind="${p.kind}" data-col="${esc(p.col)}">${agg}${esc(p.col)}${x(shelf, p.col)}</span>`;
  };
  const plain = (shelf, c) => `<span class="wb-pill dim">${esc(c)}${x(shelf, c)}</span>`;
  const set = (shelf, html) => document.querySelector(`.wb-shelf[data-shelf="${shelf}"] .wb-pills`).innerHTML =
    html || '<span class="wb-empty">drop field here</span>';
  set("cols", wb.cols.map(p => shelfPill(p, "cols")).join(""));
  set("rows", wb.rows.map(p => shelfPill(p, "rows")).join(""));
  set("color", wb.color ? plain("color", wb.color) : "");
  set("filters", wb.filters.map(f => plain("filters", f.col)).join(""));
}

function wbRenderFilters() {
  wbEl("wbFilters").innerHTML = wb.filters.map(f => `
    <div class="wb-fcard"><div class="wb-fhead">${esc(f.col)}</div>
      <label class="wb-fi"><input type="checkbox" class="wb-fall" data-col="${esc(f.col)}" ${f.selected.size === f.values.length ? "checked" : ""}> (All)</label>
      <div class="wb-flist">${f.values.map((v, i) => `<label class="wb-fi"><input type="checkbox" class="wb-fv" data-col="${esc(f.col)}" data-i="${i}" ${f.selected.has(v) ? "checked" : ""}> ${esc(v)}</label>`).join("")}</div>
    </div>`).join("");
}

async function wbPlace(shelf, it) {
  if (shelf === "cols" || shelf === "rows") {
    if (it.from === "cols" || it.from === "rows") wb[it.from] = wb[it.from].filter(p => p.col !== it.col);
    if (!wb[shelf].some(p => p.col === it.col))
      wb[shelf].push({ kind: it.kind, col: it.col, agg: it.col === WB_RECORDS ? "count" : "sum" });
  } else if (it.kind !== "dim") {
    toast("Only dimensions can go there.", "error"); return;
  } else if (shelf === "color") {
    wb.color = it.col;
  } else if (shelf === "filters" && !wb.filters.some(f => f.col === it.col)) {
    const r = await postJSON("/api/workbench/values", { column: it.col });
    wb.filters.push({ col: it.col, values: r.values, selected: new Set(r.values) });
    wbRenderFilters();
  }
  wbRenderShelves(); wbQuerySoon();
}

function wbRemove(shelf, col) {
  if (shelf === "cols" || shelf === "rows") wb[shelf] = wb[shelf].filter(p => p.col !== col);
  else if (shelf === "color") wb.color = null;
  else if (shelf === "filters") { wb.filters = wb.filters.filter(f => f.col !== col); wbRenderFilters(); }
  wbRenderShelves(); wbQuerySoon();
}

const wbCard = wbEl("wbCard");
wbCard.addEventListener("dragstart", e => {
  const p = e.target.closest(".wb-pill[draggable]"); if (!p) return;
  e.dataTransfer.setData("text/plain", JSON.stringify({ kind: p.dataset.kind, col: p.dataset.col, from: p.dataset.from || null }));
});
wbCard.addEventListener("dragover", e => { const s = e.target.closest(".wb-shelf"); if (s) { e.preventDefault(); s.classList.add("over"); } });
wbCard.addEventListener("dragleave", e => e.target.closest(".wb-shelf")?.classList.remove("over"));
wbCard.addEventListener("drop", e => {
  const s = e.target.closest(".wb-shelf"); if (!s) return;
  e.preventDefault(); s.classList.remove("over");
  try { wbPlace(s.dataset.shelf, JSON.parse(e.dataTransfer.getData("text/plain"))); } catch (_) { /* ignore bad drops */ }
});
wbCard.addEventListener("click", e => {
  const x = e.target.closest(".wb-x");
  if (x) { wbRemove(x.dataset.shelf, x.dataset.col); return; }
  const f = e.target.closest("#wbDims .wb-pill, #wbMeas .wb-pill");
  if (f) wbPlace(f.dataset.kind === "dim" ? "cols" : "rows", { kind: f.dataset.kind, col: f.dataset.col });
});
wbCard.addEventListener("change", e => {
  const t = e.target;
  if (t.id === "wbMark") { wb.mark = t.value; wbQuerySoon(); }
  else if (t.classList.contains("wb-agg")) {
    wb[t.dataset.shelf].find(p => p.col === t.dataset.col).agg = t.value; wbQuerySoon();
  } else if (t.classList.contains("wb-fall") || t.classList.contains("wb-fv")) {
    const f = wb.filters.find(x => x.col === t.dataset.col);
    const boxes = [...wbEl("wbFilters").querySelectorAll(".wb-fv")].filter(i => i.dataset.col === f.col);
    if (t.classList.contains("wb-fall")) {
      f.selected = t.checked ? new Set(f.values) : new Set();
      boxes.forEach(i => i.checked = t.checked);
    } else {
      const v = f.values[+t.dataset.i];
      t.checked ? f.selected.add(v) : f.selected.delete(v);
      const all = [...wbEl("wbFilters").querySelectorAll(".wb-fall")].find(i => i.dataset.col === f.col);
      all.checked = f.selected.size === f.values.length;
    }
    wbQuerySoon();
  }
});
wbEl("wbResetBtn").onclick = () => { wb.sig = ""; wbInit().catch(() => {}); };
wbEl("wbPngBtn").onclick = () => {
  if (!wb.drawn) { toast("Nothing to download yet.", "error"); return; }
  Plotly.downloadImage(wbEl("wbPlot"), { format: "png", filename: "workbench_chart", scale: 2 });
};

function wbQuerySoon() { clearTimeout(wb.timer); wb.timer = setTimeout(() => wbQuery().catch(() => {}), 150); }

async function wbQuery() {
  const all = [...wb.cols, ...wb.rows];
  const dims = [...new Set(all.filter(p => p.kind === "dim").map(p => p.col))];
  const measures = all.filter(p => p.kind === "meas").map(p => ({ col: p.col, agg: p.agg }));
  if (!dims.length || !measures.length) {
    Plotly.purge(wbEl("wbPlot")); wb.drawn = false; wbEl("wbTitle").textContent = "";
    wbEl("wbHint").textContent = "Drag a dimension to Columns and a measure to Rows to build a view.";
    return;
  }
  wbEl("wbHint").textContent = "";
  const filters = {};
  wb.filters.forEach(f => { if (f.selected.size < f.values.length) filters[f.col] = [...f.selected]; });
  const seq = ++wb.seq;
  const res = await postJSON("/api/workbench/query", { dims, measures, color: wb.color, filters });
  if (seq === wb.seq) wbDraw(res, dims);
}

function wbDraw(res, dims) {
  const isDate = state.datetime.includes(dims[0]);
  const line = wb.mark === "line" || (wb.mark === "auto" && isDate);
  const horizontal = !line && wb.rows.some(p => p.kind === "dim") && !wb.cols.some(p => p.kind === "dim");
  wbEl("wbTitle").textContent = res.series.length
    ? `${res.series.map(s => s.name).join(", ")} by ${dims.join(", ")}${res.truncated ? " (top 40 shown)" : ""}`
    : "No rows match the current filters";
  const traces = res.series.map((s, i) => {
    const c = WB_COLORS[i % WB_COLORS.length];
    return {
      type: line ? "scatter" : "bar", mode: line ? "lines+markers" : undefined, name: s.name,
      x: horizontal ? s.values : res.labels, y: horizontal ? res.labels : s.values,
      orientation: horizontal ? "h" : "v", marker: { color: c }, line: line ? { color: c, width: 2 } : undefined,
      connectgaps: false,
    };
  });
  const axis = isCat => ({ automargin: true, gridcolor: "#ECEAE4", zerolinecolor: "#D9D5CB", ...(isCat ? { type: "category" } : {}) });
  const layout = {
    font: { family: "Inter, system-ui, sans-serif", size: 12, color: "#16213E" },
    paper_bgcolor: "#fff", plot_bgcolor: "#fff", barmode: "group", height: 380, hovermode: "closest",
    margin: { l: 56, r: 20, t: 16, b: 48 }, uirevision: "keep",
    showlegend: res.series.length > 1,
    legend: { title: { text: res.colored ? wb.color : "Measure Names" } },
    xaxis: axis(!horizontal && !(line && isDate)),
    yaxis: { ...axis(horizontal), ...(horizontal ? { autorange: "reversed" } : {}) },
  };
  Plotly.react(wbEl("wbPlot"), traces, layout, plotConfig("workbench"));
  wb.drawn = true;
}

