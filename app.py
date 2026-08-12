"""
Automated Data Analysis Tool — Flask backend
API-driven backend for the custom HTML/CSS/JS frontend.

RUN LOCALLY:
    pip install -r requirements.txt
    python app.py
    -> open http://localhost:5000
"""
import io
import os
import uuid
import zipfile
import base64
import warnings
warnings.filterwarnings("ignore")
from datetime import datetime

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns
from flask import Flask, request, jsonify, session, send_file, render_template

sns.set_theme(style="whitegrid")

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-change-me")

# In-memory session store: {session_id: {"df": DataFrame, "base_name": str,
#                                          "log": [...], "charts": {name: png_bytes}}}
SESSIONS = {}


def get_state():
    sid = session.get("sid")
    if not sid or sid not in SESSIONS:
        sid = str(uuid.uuid4())
        session["sid"] = sid
        SESSIONS[sid] = {"df": None, "base_name": None, "log": [], "charts": {}}
    return SESSIONS[sid]


def log(state, msg):
    state["log"].append(msg)


def df_or_error():
    state = get_state()
    if state["df"] is None:
        return None, (jsonify({"error": "No data loaded yet. Upload a file first."}), 400)
    return state, None


def clean_json(obj):
    """Recursively replace NaN/NaT/inf with None so jsonify doesn't choke."""
    if isinstance(obj, dict):
        return {k: clean_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [clean_json(v) for v in obj]
    if isinstance(obj, float) and (np.isnan(obj) or np.isinf(obj)):
        return None
    if pd.isna(obj):
        return None
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating,)):
        return float(obj)
    if isinstance(obj, (pd.Timestamp,)):
        return obj.isoformat()
    return obj


def df_preview(df, n=10):
    return clean_json(df.head(n).to_dict(orient="records"))


def df_summary(state):
    df = state["df"]
    missing = df.isnull().sum()
    missing = missing[missing > 0]
    return {
        "columns": df.columns.tolist(),
        "dtypes": {c: str(t) for c, t in df.dtypes.items()},
        "rows": int(df.shape[0]),
        "cols": int(df.shape[1]),
        "preview": df_preview(df),
        "missing": {k: int(v) for k, v in missing.items()},
        "duplicates": int(df.duplicated().sum()),
        "numeric_columns": df.select_dtypes(include=np.number).columns.tolist(),
        "categorical_columns": df.select_dtypes(include=["object", "category"]).columns.tolist(),
        "datetime_columns": df.select_dtypes(include=["datetime64[ns]"]).columns.tolist(),
        "log": state["log"],
        "base_name": state["base_name"],
    }


def fig_to_b64(fig):
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=150, bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


# --------------------------------------------------------------------------
# PAGE
# --------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


# --------------------------------------------------------------------------
# STEP 1: UPLOAD
# --------------------------------------------------------------------------
@app.route("/api/upload", methods=["POST"])
def upload():
    state = get_state()
    file = request.files.get("file")
    if not file or file.filename == "":
        return jsonify({"error": "No file provided."}), 400

    ext = file.filename.rsplit(".", 1)[-1].lower()
    base_name = file.filename.rsplit(".", 1)[0]

    try:
        if ext in ("xlsx", "xls", "xlsm"):
            data = file.read()
            xls = pd.ExcelFile(io.BytesIO(data))
            sheet = request.form.get("sheet")
            if len(xls.sheet_names) > 1 and not sheet:
                return jsonify({"need_sheet": True, "sheets": xls.sheet_names})
            df = pd.read_excel(io.BytesIO(data), sheet_name=sheet or xls.sheet_names[0])
        elif ext in ("csv", "txt"):
            delim = request.form.get("delimiter", "auto")
            data = file.read()
            if delim == "auto":
                df = pd.read_csv(io.BytesIO(data), sep=None, engine="python")
            else:
                delim_map = {"comma": ",", "tab": "\t", "semicolon": ";", "pipe": "|"}
                df = pd.read_csv(io.BytesIO(data), sep=delim_map.get(delim, ","))
        else:
            return jsonify({"error": f"Unsupported file type '.{ext}'."}), 400
    except Exception as e:
        return jsonify({"error": f"Could not read file: {e}"}), 400

    state["df"] = df
    state["base_name"] = base_name
    state["log"] = [f"Loaded '{file.filename}' ({df.shape[0]} rows x {df.shape[1]} cols)"]
    state["charts"] = {}
    return jsonify(df_summary(state))


@app.route("/api/state", methods=["GET"])
def state_endpoint():
    state, err = df_or_error()
    if err:
        return err
    return jsonify(df_summary(state))


# --------------------------------------------------------------------------
# STEP 2: CLEANING
# --------------------------------------------------------------------------
@app.route("/api/clean/duplicates", methods=["POST"])
def clean_duplicates():
    state, err = df_or_error()
    if err:
        return err
    df = state["df"]
    n = int(df.duplicated().sum())
    df = df.drop_duplicates().reset_index(drop=True)
    state["df"] = df
    log(state, f"Removed {n} duplicate row(s).")
    return jsonify(df_summary(state))


@app.route("/api/clean/missing", methods=["POST"])
def clean_missing():
    state, err = df_or_error()
    if err:
        return err
    df = state["df"]
    body = request.get_json()
    col = body.get("column")
    method = body.get("method")
    custom_value = body.get("custom_value")

    if col not in df.columns:
        return jsonify({"error": "Unknown column."}), 400

    is_numeric = pd.api.types.is_numeric_dtype(df[col])
    n_missing = int(df[col].isnull().sum())

    if method == "mean":
        v = df[col].mean(); df[col] = df[col].fillna(v)
        log(state, f"'{col}': filled {n_missing} missing with mean ({v:.4f})")
    elif method == "median":
        v = df[col].median(); df[col] = df[col].fillna(v)
        log(state, f"'{col}': filled {n_missing} missing with median ({v:.4f})")
    elif method == "mode":
        m = df[col].mode(dropna=True)
        if len(m):
            df[col] = df[col].fillna(m.iloc[0])
            log(state, f"'{col}': filled {n_missing} missing with mode ({m.iloc[0]})")
    elif method == "custom":
        val = custom_value
        if is_numeric:
            try:
                val = float(val)
            except (TypeError, ValueError):
                return jsonify({"error": "Enter a valid number."}), 400
        df[col] = df[col].fillna(val)
        log(state, f"'{col}': filled {n_missing} missing with custom value ({val})")
    elif method == "drop":
        before = len(df)
        df = df.dropna(subset=[col]).reset_index(drop=True)
        log(state, f"'{col}': dropped {before - len(df)} row(s) with missing value")
    elif method == "skip":
        log(state, f"'{col}': left {n_missing} missing value(s) as-is")
    else:
        return jsonify({"error": "Unknown method."}), 400

    state["df"] = df
    return jsonify(df_summary(state))


# --------------------------------------------------------------------------
# STEP 3: VALIDATION
# --------------------------------------------------------------------------
@app.route("/api/validate/convert", methods=["POST"])
def validate_convert():
    state, err = df_or_error()
    if err:
        return err
    df = state["df"]
    body = request.get_json()
    col, target = body.get("column"), body.get("type")
    try:
        if target == "int":
            df[col] = pd.to_numeric(df[col], errors="coerce").astype("Int64")
        elif target == "float":
            df[col] = pd.to_numeric(df[col], errors="coerce")
        elif target == "str":
            df[col] = df[col].astype(str)
        elif target == "datetime":
            df[col] = pd.to_datetime(df[col], errors="coerce")
        else:
            return jsonify({"error": "Unknown type."}), 400
    except Exception as e:
        return jsonify({"error": f"Conversion failed: {e}"}), 400

    state["df"] = df
    log(state, f"'{col}' converted to {target}")
    return jsonify(df_summary(state))


def _outlier_bounds(series, method, params):
    if method == "iqr":
        q1, q3 = series.quantile(0.25), series.quantile(0.75)
        iqr = q3 - q1
        return q1 - 1.5 * iqr, q3 + 1.5 * iqr
    if method == "zscore":
        threshold = float(params.get("threshold", 3))
        mean, std = series.mean(), series.std()
        if not std or np.isnan(std):
            return None, None
        return mean - threshold * std, mean + threshold * std
    if method == "percentile":
        low_p = float(params.get("low", 1))
        high_p = float(params.get("high", 99))
        return np.percentile(series, low_p), np.percentile(series, high_p)
    return None, None


@app.route("/api/validate/outliers/detect", methods=["POST"])
def detect_outliers():
    state, err = df_or_error()
    if err:
        return err
    df = state["df"]
    body = request.get_json()
    col = body.get("column")
    method = body.get("method", "iqr")
    params = body.get("params", {})

    series = df[col].dropna()
    lower, upper = _outlier_bounds(series, method, params)
    if lower is None:
        return jsonify({"error": "Could not compute bounds (e.g. zero variance)."}), 400

    outliers = df[(df[col] < lower) | (df[col] > upper)]
    return jsonify({
        "lower": float(lower), "upper": float(upper),
        "count": int(len(outliers)),
        "sample": df_preview(outliers, 10),
    })


@app.route("/api/validate/outliers/treat", methods=["POST"])
def treat_outliers():
    state, err = df_or_error()
    if err:
        return err
    df = state["df"]
    body = request.get_json()
    col = body.get("column")
    lower, upper = float(body["lower"]), float(body["upper"])
    treatment = body.get("treatment")
    method_label = body.get("method_label", "")

    outliers = df[(df[col] < lower) | (df[col] > upper)]
    n = len(outliers)

    if treatment == "cap":
        df[col] = df[col].clip(lower, upper)
        log(state, f"'{col}': capped {n} outlier(s) ({method_label})")
    elif treatment == "remove":
        before = len(df)
        df = df[(df[col] >= lower) & (df[col] <= upper)].reset_index(drop=True)
        log(state, f"'{col}': removed {before - len(df)} outlier row(s) ({method_label})")
    else:
        log(state, f"'{col}': {n} outlier(s) left as-is ({method_label})")

    state["df"] = df
    return jsonify(df_summary(state))


# --------------------------------------------------------------------------
# STEP 4: ANALYSIS
# --------------------------------------------------------------------------
@app.route("/api/analyze/summary", methods=["GET"])
def analyze_summary():
    state, err = df_or_error()
    if err:
        return err
    df = state["df"]
    desc = df.describe(include="all").transpose()
    desc.insert(0, "column", desc.index)
    return jsonify({"rows": clean_json(desc.to_dict(orient="records"))})


@app.route("/api/analyze/correlation", methods=["GET"])
def analyze_correlation():
    state, err = df_or_error()
    if err:
        return err
    df = state["df"]
    numeric_df = df.select_dtypes(include=np.number)
    if numeric_df.shape[1] < 2:
        return jsonify({"columns": [], "matrix": []})
    corr = numeric_df.corr(numeric_only=True).round(3)
    return jsonify({"columns": corr.columns.tolist(), "matrix": clean_json(corr.values.tolist())})


@app.route("/api/analyze/groupby", methods=["POST"])
def analyze_groupby():
    state, err = df_or_error()
    if err:
        return err
    df = state["df"]
    body = request.get_json()
    group_col, num_col = body.get("group_col"), body.get("num_col")
    summary = df.groupby(group_col)[num_col].agg(["mean", "median", "min", "max", "count"]).reset_index()
    return jsonify({"rows": clean_json(summary.to_dict(orient="records"))})


# --------------------------------------------------------------------------
# STEP 5: VISUALIZATION
# --------------------------------------------------------------------------
@app.route("/api/visualize/chart", methods=["POST"])
def make_chart():
    state, err = df_or_error()
    if err:
        return err
    df = state["df"]
    body = request.get_json()
    chart_type = body.get("type")
    p = body.get("params", {})

    fig = None
    name = chart_type

    try:
        if chart_type == "histogram":
            col = p["column"]
            fig, ax = plt.subplots(figsize=(7, 4))
            sns.histplot(df[col].dropna(), kde=True, ax=ax, color="#2A6F6F")
            ax.set_title(f"Distribution of {col}")
            name = f"hist_{col}"

        elif chart_type == "boxplot":
            col = p["column"]; group = p.get("group")
            fig, ax = plt.subplots(figsize=(7, 4))
            if group:
                sns.boxplot(data=df, x=group, y=col, ax=ax, color="#D9A441")
                ax.tick_params(axis="x", rotation=45)
            else:
                sns.boxplot(y=df[col].dropna(), ax=ax, color="#D9A441")
            ax.set_title(f"Boxplot of {col}")
            name = f"box_{col}"

        elif chart_type == "bar_counts":
            col = p["column"]
            vals = df[col].value_counts().head(15)
            fig, ax = plt.subplots(figsize=(8, 4))
            sns.barplot(x=vals.values, y=vals.index, ax=ax, color="#3F8F5F")
            ax.set_title(f"Top categories in {col}"); ax.set_xlabel("Count")
            name = f"bar_{col}"

        elif chart_type == "bar_avg":
            group_col, num_col = p["group_col"], p["num_col"]
            vals = df.groupby(group_col)[num_col].mean().sort_values(ascending=False).head(15)
            fig, ax = plt.subplots(figsize=(8, 4))
            sns.barplot(x=vals.values, y=vals.index, ax=ax, color="#3F8F5F")
            ax.set_title(f"Average {num_col} by {group_col}")
            name = f"bar_{num_col}_by_{group_col}"

        elif chart_type == "line":
            x_col, y_col = p["x_col"], p["y_col"]
            plot_df = df[[x_col, y_col]].dropna().sort_values(x_col)
            fig, ax = plt.subplots(figsize=(8, 4))
            ax.plot(plot_df[x_col], plot_df[y_col], color="#2A6F6F", linewidth=2)
            ax.set_title(f"{y_col} over {x_col}")
            ax.tick_params(axis="x", rotation=45)
            name = f"line_{y_col}"

        elif chart_type == "scatter":
            x_col, y_col, hue = p["x_col"], p["y_col"], p.get("hue")
            fig, ax = plt.subplots(figsize=(7, 5))
            if hue:
                sns.scatterplot(data=df, x=x_col, y=y_col, hue=hue, ax=ax)
            else:
                sns.scatterplot(data=df, x=x_col, y=y_col, ax=ax, color="#2A6F6F")
            ax.set_title(f"{y_col} vs {x_col}")
            name = f"scatter_{x_col}_{y_col}"

        elif chart_type == "pie":
            col = p["column"]
            vals = df[col].value_counts().head(8)
            fig, ax = plt.subplots(figsize=(6, 6))
            colors = sns.color_palette(["#2A6F6F", "#D9A441", "#3F8F5F", "#16213E",
                                         "#E4572E", "#7FA99B", "#C9A66B", "#5C6F7C"])
            ax.pie(vals.values, labels=vals.index, autopct="%1.1f%%", startangle=90, colors=colors)
            ax.set_title(f"Share of {col}")
            name = f"pie_{col}"

        elif chart_type == "heatmap":
            numeric_cols = df.select_dtypes(include=np.number).columns.tolist()
            fig, ax = plt.subplots(figsize=(1 + len(numeric_cols) * 0.8, 1 + len(numeric_cols) * 0.6))
            sns.heatmap(df[numeric_cols].corr(), annot=True, cmap="coolwarm", fmt=".2f", ax=ax)
            ax.set_title("Correlation Heatmap")
            name = "correlation_heatmap"

        else:
            return jsonify({"error": "Unknown chart type."}), 400
    except Exception as e:
        return jsonify({"error": f"Could not build chart: {e}"}), 400

    b64 = fig_to_b64(fig)
    uniq = name
    i = 1
    while uniq in state["charts"]:
        i += 1
        uniq = f"{name}_{i}"
    state["charts"][uniq] = base64.b64decode(b64)
    log(state, f"Chart created: {uniq}")

    return jsonify({"name": uniq, "image_b64": b64,
                     "chart_count": len(state["charts"])})


@app.route("/api/charts", methods=["GET"])
def list_charts():
    state, err = df_or_error()
    if err:
        return err
    return jsonify({"charts": [
        {"name": n, "image_b64": base64.b64encode(png).decode("utf-8")}
        for n, png in state["charts"].items()
    ]})


@app.route("/api/charts/<name>", methods=["DELETE"])
def delete_chart(name):
    state, err = df_or_error()
    if err:
        return err
    if name not in state["charts"]:
        return jsonify({"error": "Chart not found."}), 404
    del state["charts"][name]
    log(state, f"Chart removed: {name}")
    return jsonify({"removed": name, "chart_count": len(state["charts"])})


# --------------------------------------------------------------------------
# STEP 6: EXPORT
# --------------------------------------------------------------------------
@app.route("/api/export/xlsx", methods=["GET"])
def export_xlsx():
    state, err = df_or_error()
    if err:
        return err
    buf = io.BytesIO()
    state["df"].to_excel(buf, index=False, engine="openpyxl")
    buf.seek(0)
    name = f"{state['base_name']}_clean_for_powerbi.xlsx"
    return send_file(buf, as_attachment=True, download_name=name,
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@app.route("/api/export/csv", methods=["GET"])
def export_csv():
    state, err = df_or_error()
    if err:
        return err
    buf = io.BytesIO(state["df"].to_csv(index=False).encode("utf-8"))
    name = f"{state['base_name']}_clean_for_powerbi.csv"
    return send_file(buf, as_attachment=True, download_name=name, mimetype="text/csv")


@app.route("/api/export/charts", methods=["GET"])
def export_charts():
    state, err = df_or_error()
    if err:
        return err
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for n, png in state["charts"].items():
            zf.writestr(f"{n}.png", png)
    buf.seek(0)
    return send_file(buf, as_attachment=True,
                      download_name=f"{state['base_name']}_charts.zip", mimetype="application/zip")


@app.route("/api/export/powerbi_guide", methods=["GET"])
def export_guide():
    state, err = df_or_error()
    if err:
        return err
    guide = f"""POWER BI DASHBOARD GUIDE
Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}

1. Open Power BI Desktop -> Home -> Get Data -> Excel workbook.
2. Select '{state['base_name']}_clean_for_powerbi.xlsx' and load the table.
3. In Model view, confirm each column's type matches Step 3.
4. In Report view, add cards for key totals, bar/column charts for category
   breakdowns, a line chart for date trends, a table for drill-down, and
   slicers for interactive filtering.
5. Apply a theme (View -> Themes), add a title, arrange your visuals.
6. Publish: Home -> Publish -> choose your workspace.
"""
    buf = io.BytesIO(guide.encode("utf-8"))
    return send_file(buf, as_attachment=True, download_name="POWER_BI_GUIDE.txt", mimetype="text/plain")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    app.run(host="0.0.0.0", port=port, debug=debug)
