const state = {
  loaded: false, columns: [], dtypes: {}, numeric: [], categorical: [], datetime: [],
  maxStepReached: 1, aiEnabled: false,
};

const stepMeta = {
  1: { eyebrow: "Step 01 / Collect", title: "Bring in your data" },
  2: { eyebrow: "Step 02 / Clean", title: "Handle duplicates & missing values" },
  3: { eyebrow: "Step 03 / Validate", title: "Fix types & catch outliers" },
  4: { eyebrow: "Step 04 / Analyze", title: "Summarize what you have" },
  5: { eyebrow: "Step 05 / Visualize", title: "Build charts" },
  6: { eyebrow: "Step 06 / Export", title: "Take it with you" },
};

function toast(msg, type = "info") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 4000);
}

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

async function withLoading(btn, fn) {
  if (btn) { btn.classList.add("is-loading"); btn.disabled = true; }
  try { return await fn(); } finally {
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
  } finally { finishProgress(); }
}

const postJSON = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function renderTable(container, rows, maxRows = 15) {
  if (!rows || rows.length === 0) { container.innerHTML = `<p class="muted" style="padding:14px;">No rows to show.</p>`; return; }
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
    const o = document.createElement("option"); o.value = ""; o.textContent = placeholder;
    select.appendChild(o);
  }
  options.forEach(opt => {
    const o = document.createElement("option"); o.value = opt; o.textContent = opt;
    select.appendChild(o);
  });
}

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
  if (n === 6) prepStep6();
}

function unlockStep(n) {
  state.maxStepReached = Math.max(state.maxStepReached, n);
  const btn = document.querySelector(`.pipe-step[data-step="${n}"]`);
  btn.disabled = false;
}

document.querySelectorAll(".pipe-step").forEach(btn => {
  btn.addEventListener("click", () => { if (!btn.disabled) goToStep(parseInt(btn.dataset.step)); });
});

function applyStateSummary(data) {
  state.loaded = true;
  state.columns = data.columns;
  state.dtypes = data.dtypes;
  state.numeric = data.numeric_columns;
  state.categorical = data.categorical_columns;
  state.datetime = data.datetime_columns;
  state.aiEnabled = !!data.ai_enabled;

  document.getElementById("datasetChip").classList.add("loaded");
  document.getElementById("datasetName").textContent = `${data.base_name} · ${data.rows}×${data.cols}`;
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
  document.getElementById("dupeText").textContent = data.duplicates > 0 ? `${data.duplicates} duplicate row(s) found.` : "No duplicate rows found.";
  document.getElementById("removeDupesBtn").disabled = data.duplicates === 0;
}

function refreshActiveStep() {
  const active = document.querySelector(".panel.active");
  const n = active ? parseInt(active.id.replace("panel-", "")) : 1;
  document.getElementById("outlierResult").classList.add("hidden");
  if (n === 3) prepStep3();
  if (n === 4) prepStep4();
  if (n === 6) prepStep6();
}

async function historyAction(path, doneMsg) {
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
    const s = await api("/api/state").catch(() => null);
    if (s) applyStateSummary(s);
  }
}

document.getElementById("undoBtn").onclick = () => historyAction("/api/undo", "Last change undone.");
document.getElementById("resetBtn").onclick = () => {
  if (!confirm("Discard all changes and restore the original upload?")) return;
  historyAction("/api/reset", "Restored the original upload.");
};

const dropzone = document.getElementById("dropzone");
dropzone.addEventListener("click", () => document.getElementById("fileInput").click());
dropzone.addEventListener("dragover", e => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", e => {
  e.preventDefault(); dropzone.classList.remove("dragover");
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
    loadBtn.onclick = () => withLoading(loadBtn, () => handleFile(pendingFile, { sheet: document.getElementById("sheetSelect").value }));
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
  toast(`Loaded ${data.base_name} — ${data.rows} rows.`);
}

document.getElementById("toCleanBtn").onclick = () => goToStep(2);

document.getElementById("removeDupesBtn").onclick = () =>
  withLoading(document.getElementById("removeDupesBtn"), async () => {
    const data = await api("/api/clean/duplicates", { method: "POST" });
    applyStateSummary(data);
    toast("Duplicates removed.");
  });

const fillOptionsNumeric = [
  ["mean", "Fill with mean (average)"], ["median", "Fill with median (middle value)"], ["mode", "Fill with mode (most common)"],
  ["knn", "KNN (uses other numeric cols)"], ["iterative", "Iterative / MICE"], ["group_median", "Median within group…"],
  ["group_mean", "Mean within group…"], ["interpolate", "Interpolate (time series)"], ["ffill", "Forward-fill"],
  ["bfill", "Backward-fill"], ["custom", "Fill with a custom value"], ["drop", "Drop rows with this gap"], ["skip", "Leave as-is"],
];
const fillOptionsText = [
  ["mode", "Fill with mode (most common)"], ["group_mode", "Mode within group…"], ["ffill", "Forward-fill"],
  ["bfill", "Backward-fill"], ["unknown", "Fill with 'Unknown'"], ["custom", "Fill with a custom value"],
  ["drop", "Drop rows with this gap"], ["skip", "Leave as-is"],
];

function renderMissingList(missing) {
  const container = document.getElementById("missingList");
  const cols = Object.keys(missing);
  if (cols.length === 0) { container.innerHTML = `<p class="all-clear">✓ No missing values — you're clean.</p>`; return; }
  container.innerHTML = "";
  cols.forEach(col => {
    const isNumeric = state.numeric.includes(col);
    const options = isNumeric ? fillOptionsNumeric : fillOptionsText;
    const row = document.createElement("div");
    row.className = "missing-row";
    row.innerHTML = `
      <span class="col-name">${col}</span>
      <span class="col-count">${missing[col]} missing</span>
      <select class="fill-method">${options.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
      <select class="fill-group hidden"></select>
      <input type="text" class="fill-custom hidden" placeholder="value…">
      ${state.aiEnabled ? `<button class="btn btn-secondary btn-sm ai-suggest" title="Ask AI which method fits">✨ Suggest</button>` : ""}
      <button class="btn btn-primary apply-fill">Apply</button>
      <p class="ai-reasoning hidden"></p>
    `;
    const methodSelect = row.querySelector(".fill-method");
    const groupSelect  = row.querySelector(".fill-group");
    const customInput  = row.querySelector(".fill-custom");
    const note         = row.querySelector(".ai-reasoning");

    function syncRowControls() {
      const m = methodSelect.value;
      customInput.classList.toggle("hidden", m !== "custom");
      const needsGroup = m.startsWith("group_");
      groupSelect.classList.toggle("hidden", !needsGroup);
      if (needsGroup && !groupSelect.options.length) {
        groupSelect.innerHTML = state.categorical.filter(c => c !== col).map(c => `<option value="${c}">${c}</option>`).join("");
      }
    }
    methodSelect.addEventListener("change", syncRowControls);
    syncRowControls();

    row.querySelector(".ai-suggest")?.addEventListener("click", e =>
      withLoading(e.target, async () => {
        try {
          const s = await postJSON("/api/ai/impute-suggest", { column: col });
          const valid = Array.from(methodSelect.options).some(o => o.value === s.method);
          note.classList.remove("hidden");
          if (!valid) { note.textContent = `✨ AI suggested "${s.method}" but it doesn't apply. ${s.reasoning}`; return; }
          methodSelect.value = s.method;
          if (s.method.startsWith("group_") && s.group_col) groupSelect.value = s.group_col;
          syncRowControls();
          note.textContent = `✨ ${s.reasoning} (${Math.round((s.confidence ?? 0) * 100)}% confident)`;
        } catch (err) { }
      })
    );

    row.querySelector(".apply-fill").addEventListener("click", e =>
      withLoading(e.target, async () => {
        const data = await postJSON("/api/clean/missing", {
          column: col, method: methodSelect.value, custom_value: customInput.value,
          group_col: methodSelect.value.startsWith("group_") ? groupSelect.value : null,
        });
        applyStateSummary(data);
        toast(`'${col}' updated.`);
      })
    );
    container.appendChild(row);
  });
}

document.getElementById("toValidateBtn").onclick = () => { unlockStep(3); goToStep(3); };

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
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ column, type }),
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
    container.innerHTML = `<label class="muted mono" style="font-size:11px;">threshold</label><select id="zThreshold"><option value="2">2</option><option value="2.5">2.5</option><option value="3" selected>3</option></select>`;
  } else if (method === "percentile") {
    container.innerHTML = `<label class="muted mono" style="font-size:11px;">low %</label><input type="number" id="pctLow" value="1" style="width:60px;"><label class="muted mono" style="font-size:11px;">high %</label><input type="number" id="pctHigh" value="99" style="width:60px;">`;
  } else { container.innerHTML = ""; }
}

document.getElementById("detectBtn").onclick = () =>
  withLoading(document.getElementById("detectBtn"), async () => {
  const column = document.getElementById("outlierCol").value;
  const method = document.getElementById("outlierMethod").value;
  if (!column) { toast("Pick a numeric column first.", "error"); return; }
  let params = {};
  if (method === "zscore") params.threshold = document.getElementById("zThreshold").value;
  if (method === "percentile") { params.low = document.getElementById("pctLow").value; params.high = document.getElementById("pctHigh").value; }
  const data = await api("/api/validate/outliers/detect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ column, method, params }) });
  const methodLabels = { iqr: "IQR", zscore: "Z-score", percentile: "Percentile" };
  const resultDiv = document.getElementById("outlierResult");
  resultDiv.classList.remove("hidden");
  if (data.count === 0) { resultDiv.innerHTML = `<p class="all-clear">✓ No outliers found using ${methodLabels[method]}.</p>`; return; }
  resultDiv.innerHTML = `
    <p class="range">Normal range: [${data.lower.toFixed(2)}, ${data.upper.toFixed(2)}] — <b>${data.count}</b> potential outlier(s)</p>
    <div class="treat-row"><button class="btn btn-secondary" data-treat="cap">Cap to range</button><button class="btn btn-danger" data-treat="remove">Remove rows</button><button class="btn btn-secondary" data-treat="leave">Leave as-is</button></div>
  `;
  resultDiv.querySelectorAll("[data-treat]").forEach(btn => {
    btn.addEventListener("click", () => withLoading(btn, async () => {
      const result = await api("/api/validate/outliers/treat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ column, lower: data.lower, upper: data.upper, treatment: btn.dataset.treat, method_label: methodLabels[method] }) });
      applyStateSummary(result);
      resultDiv.classList.add("hidden");
      toast(`Outlier treatment applied to '${column}'.`);
    }));
  });
  });

document.getElementById("toAnalyzeBtn").onclick = () => { unlockStep(4); goToStep(4); };

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
  } else { corrContainer.innerHTML = `<p class="muted" style="padding:14px;">Need at least two numeric columns.</p>`; }
  fillSelect(document.getElementById("groupCol"), state.categorical);
  fillSelect(document.getElementById("groupNumCol"), state.numeric);
}

document.getElementById("groupByBtn").onclick = () =>
  withLoading(document.getElementById("groupByBtn"), async () => {
    const groupTable = document.getElementById("groupTable");
    skeleton(groupTable, "Grouping…");
    const group_col = document.getElementById("groupCol").value;
    const num_col = document.getElementById("groupNumCol").value;
    const data = await api("/api/analyze/groupby", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group_col, num_col }) });
    renderTable(groupTable, data.rows, 50);
  });

document.getElementById("toVisualizeBtn").onclick = () => { unlockStep(5); goToStep(5); };

let currentChartType = "histogram";
document.querySelectorAll(".chart-type-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".chart-type-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentChartType = btn.dataset.type;
    renderChartParams();
  });
});

function prepStep5() { renderChartParams(); }
function renderChartParams() {
  const container = document.getElementById("chartParams");
  const num = state.numeric, cat = state.categorical, dt = state.datetime;
  const opt = (arr, id, placeholder) => `<select id="${id}">${placeholder ? `<option value="">${placeholder}</option>` : ""}${arr.map(c => `<option value="${c}">${c}</option>`).join("")}</select>`;
  if (currentChartType === "histogram") container.innerHTML = `${opt(num, "p_col")}`;
  else if (currentChartType === "boxplot") container.innerHTML = `${opt(num, "p_col")} ${opt(cat, "p_group", "(no grouping)")}`;
  else if (currentChartType === "bar_counts") container.innerHTML = `${opt(cat, "p_col")}`;
  else if (currentChartType === "bar_avg") container.innerHTML = `Group ${opt(cat, "p_group_col")} Average ${opt(num, "p_num_col")}`;
  else if (currentChartType === "line") container.innerHTML = `X ${opt([...dt, ...num], "p_x")} Y ${opt(num, "p_y")}`;
  else if (currentChartType === "scatter") container.innerHTML = `X ${opt(num, "p_x")} Y ${opt(num, "p_y")} Color ${opt(cat, "p_hue", "(none)")}`;
  else if (currentChartType === "pie") container.innerHTML = `${opt(cat, "p_col")}`;
  else if (currentChartType === "heatmap") container.innerHTML = `<span class="muted">Uses all numeric columns.</span>`;
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
    skeleton(preview, "Rendering chart…");
    const data = await api("/api/visualize/chart", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: currentChartType, params }) });
    preview.innerHTML = `<img src="data:image/png;base64,${data.image_b64}" alt="${data.name}">`;
    await loadGallery();
    toast(`Chart '${data.name}' added to gallery.`);
  });

async function loadGallery() {
  const data = await api("/api/charts");
  document.getElementById("chartCount").textContent = `${data.charts.length} chart${data.charts.length === 1 ? "" : "s"}`;
  const gallery = document.getElementById("chartGallery");
  gallery.innerHTML = data.charts.map(c => `
    <figure data-name="${c.name}">
      <button type="button" class="chart-remove-btn" title="Remove chart" aria-label="Remove chart ${c.name}">&times;</button>
      <img src="data:image/png;base64,${c.image_b64}" alt="${c.name}">
      <figcaption>${c.name}</figcaption>
    </figure>
  `).join("");
}

document.getElementById("chartGallery").addEventListener("click", async (e) => {
  const btn = e.target.closest(".chart-remove-btn");
  if (!btn) return;
  const figure = btn.closest("figure");
  const name = figure.dataset.name;
  btn.disabled = true;
  try {
    await api(`/api/charts/${encodeURIComponent(name)}`, { method: "DELETE" });
    figure.remove();
    const remaining = document.querySelectorAll("#chartGallery figure").length;
    document.getElementById("chartCount").textContent = `${remaining} chart${remaining === 1 ? "" : "s"}`;
    toast(`Chart '${name}' removed.`);
  } catch (err) { btn.disabled = false; }
});

document.getElementById("toExportBtn").onclick = () => { unlockStep(6); goToStep(6); };

async function prepStep6() {
  const data = await api("/api/state");
  document.getElementById("logBox").textContent = data.log.map(l => `· ${l}`).join("\n");
}
