"""
Automated Data Analysis Tool — Flask backend
"""
import functools
import io
import os
import uuid
import zipfile
import base64
import json
import re
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

# ---- AI SETUP: Hardcoded Groq Key -------------------------------------------
AI_API_KEY = "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"
AI_BASE_URL = "https://api.groq.com/openai/v1"
AI_MODEL    = "llama-3.3-70b-versatile"

try:
    from openai import OpenAI
    _client = OpenAI(
        api_key=AI_API_KEY,
        base_url=AI_BASE_URL,
    )
    _AI_OK = True
    print("[AI] Groq API initialized successfully!")
except Exception as e:
    _client, _AI_OK = None, False
    print(f"[AI] Failed to initialize: {e}")

# ---- optional scikit-learn: model-based imputation only ---------------------
try:
    from sklearn.impute import KNNImputer
    from sklearn.experimental import enable_iterative_imputer  # noqa: F401
    from sklearn.impute import IterativeImputer
    _SKLEARN_OK = True
except ImportError:
    _SKLEARN_OK = False

IMPUTE_METHODS = {
    "mean", "median", "mode", "custom", "drop", "skip",
    "group_mean", "group_median", "group_mode",
    "ffill", "bfill", "interpolate", "unknown",
    "knn", "iterative",
}

sns.set_theme(style="whitegrid")

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-change-me")

MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "10"))
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024

@app.errorhandler(413)
def too_large(_e):
    return jsonify({"error": f"File too large. The maximum upload size is {MAX_UPLOAD_MB} MB."}), 413

MAX_HISTORY = int(os.environ.get("MAX_HISTORY", "10"))
SESSIONS = {}

def get_state():
    sid = session.get("sid")
    if not sid or sid not in SESSIONS:
        sid = str(uuid.uuid4())
        session["sid"] = sid
        SESSIONS[sid] = {"df": None, "base_name": None, "log": [], "charts": {},
                         "history": [], "original": None}
    return SESSIONS[sid]

def log(state, msg):
    state["log"].append(msg)

def mutates(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        state = get_state()
        if state["df"] is None:
            return jsonify({"error": "No data loaded yet. Upload a file first."}), 400
        snap = (state["df"].copy(), list(state["log"]))
        state["history"].append(snap)
        evicted = state["history"][:-MAX_HISTORY]
        del state["history"][:-MAX_HISTORY]
        resp = fn(*args, **kwargs)
        status = resp[1] if isinstance(resp, tuple) else getattr(resp, "status_code", 200)
        if status >= 400:
            state["df"], state["log"] = snap
            state["history"].pop()
            state["history"][:0] = evicted
        return resp
    return wrapper

def df_or_error():
    state = get_state()
    if state["df"] is None:
        return None, (jsonify({"error": "No data loaded yet. Upload a file first."}), 400)
    return state, None

def clean_json(obj):
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

def _extract_json(text):
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z]*\s*|\s*```$", "", text, flags=re.DOTALL)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            return json.loads(m.group(0))
        raise

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
        "undo_depth": len(state["history"]),
        "can_reset": state["original"] is not None and bool(state["history"]),
        "ai_enabled": _AI_OK,
    }

def fig_to_b64(fig):
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=150, bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.getvalue()).decode("utf-8")

@app.route("/")
def index():
    return render_template("index.html")

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
    state["original"] = (df.copy(), list(state["log"]))
    state["history"] = []
    return jsonify(df_summary(state))

@app.route("/api/state", methods=["GET"])
def state_endpoint():
    state, err = df_or_error()
    if err: return err
    return jsonify(df_summary(state))

@app.route("/api/undo", methods=["POST"])
def undo():
    state, err = df_or_error()
    if err: return err
    if not state["history"]:
        return jsonify({"error": "Nothing to undo."}), 400
    state["df"], state["log"] = state["history"].pop()
    return jsonify(df_summary(state))

@app.route("/api/reset", methods=["POST"])
def reset():
    state, err = df_or_error()
    if err: return err
    if state["original"] is None or not state["history"]:
        return jsonify({"error": "Data is already in its original state."}), 400
    df, lg = state["original"]
    state["df"], state["log"] = df.copy(), list(lg)
    state["history"] = []
    return jsonify(df_summary(state))

@app.route("/api/clean/duplicates", methods=["POST"])
@mutates
def clean_duplicates():
    state, err = df_or_error()
    if err: return err
    df = state["df"]
    n = int(df.duplicated().sum())
    df = df.drop_duplicates().reset_index(drop=True)
    state["df"] = df
    log(state, f"Removed {n} duplicate row(s).")
    return jsonify(df_summary(state))

@app.route("/api/clean/missing", methods=["POST"])
@mutates
def clean_missing():
    state, err = df_or_error()
    if err: return err
    df = state["df"]
    b = request.get_json() or {}
    col          = b.get("column")
    method       = b.get("method")
    custom_value = b.get("custom_value")
    group_col    = b.get("group_col")
    n_neighbors  = int(b.get("n_neighbors", 5))

    if col not in df.columns: return jsonify({"error": "Unknown column."}), 400
    if method not in IMPUTE_METHODS: return jsonify({"error": "Unknown method."}), 400
    if df[col].notna().sum() == 0: return jsonify({"error": f"'{col}' is entirely missing — nothing to learn from."}), 400

    s = df[col]
    is_num = pd.api.types.is_numeric_dtype(s)
    is_dt  = pd.api.types.is_datetime64_any_dtype(s)
    n_missing = int(s.isnull().sum())

    if method in ("mean", "median") and not is_num:
        return jsonify({"error": f"'{col}' is not numeric."}), 400
    if method == "mean":
        v = s.mean(); df[col] = s.fillna(v); log(state, f"'{col}': filled {n_missing} missing with mean ({v:.4f})")
    elif method == "median":
        v = s.median(); df[col] = s.fillna(v); log(state, f"'{col}': filled {n_missing} missing with median ({v:.4f})")
    elif method == "mode":
        m = s.mode(dropna=True)
        if len(m):
            df[col] = s.fillna(m.iloc[0]); log(state, f"'{col}': filled {n_missing} missing with mode ({m.iloc[0]})")
    elif method == "custom":
        val = custom_value
        if is_num:
            try: val = float(val)
            except (TypeError, ValueError): return jsonify({"error": "Enter a valid number."}), 400
        df[col] = s.fillna(val); log(state, f"'{col}': filled {n_missing} missing with custom value ({val})")
    elif method == "drop":
        before = len(df); df = df.dropna(subset=[col]).reset_index(drop=True)
        log(state, f"'{col}': dropped {before - len(df)} row(s)")
    elif method == "skip":
        log(state, f"'{col}': left {n_missing} missing value(s) as-is")
    elif method in ("ffill", "bfill"):
        df[col] = getattr(s, method)(); log(state, f"'{col}': {method} filled gaps")
    elif method == "interpolate":
        if not is_num and not is_dt: return jsonify({"error": "Interpolate needs a numeric or datetime column."}), 400
        df[col] = s.interpolate(method="linear", limit_direction="both"); log(state, f"'{col}': interpolated gaps")
    elif method == "unknown":
        if is_num: return jsonify({"error": "'Unknown' only applies to text columns."}), 400
        df[col] = s.fillna("Unknown"); log(state, f"'{col}': filled {n_missing} with 'Unknown'")
    elif method in ("group_mean", "group_median", "group_mode"):
        if not group_col or group_col not in df.columns: return jsonify({"error": "Pick a grouping column."}), 400
        if method != "group_mode" and not is_num: return jsonify({"error": f"'{col}' is not numeric."}), 400
        def _fill(sub):
            if method == "group_mode":
                m = sub.mode(dropna=True)
                return sub.fillna(m.iloc[0]) if len(m) else sub
            return sub.fillna(sub.mean() if method == "group_mean" else sub.median())
        df[col] = df.groupby(group_col, dropna=False)[col].transform(_fill)
        if df[col].isnull().any():
            m2 = df[col].mode(dropna=True)
            fallback = (df[col].median() if method != "group_mode" else (m2.iloc[0] if len(m2) else None))
            if fallback is not None: df[col] = df[col].fillna(fallback)
        log(state, f"'{col}': {method} by '{group_col}' ({n_missing} gaps)")
    elif method in ("knn", "iterative"):
        if not _SKLEARN_OK: return jsonify({"error": "scikit-learn is not installed."}), 503
        if not is_num: return jsonify({"error": "Model-based imputation needs a numeric column."}), 400
        if len(df) > 20000: return jsonify({"error": "Too many rows (max 20,000)."}), 400
        num_cols = df.select_dtypes(include=np.number).columns.tolist()
        if col not in num_cols: num_cols.append(col)
        if len(num_cols) < 2: return jsonify({"error": "Need at least 2 numeric columns."}), 400
        orig_dtype = str(df[col].dtype)
        sub = df[num_cols].copy()
        for c in sub.columns:
            if str(sub[c].dtype).startswith("Int") or str(sub[c].dtype) == "boolean":
                sub[c] = sub[c].astype("float64")
        try:
            imp = KNNImputer(n_neighbors=min(n_neighbors, len(sub) - 1)) if method == "knn" else IterativeImputer(max_iter=10, random_state=0)
            filled = imp.fit_transform(sub)
        except Exception as e: return jsonify({"error": f"Imputation failed: {e}"}), 400
        df[col] = filled[:, num_cols.index(col)]
        if orig_dtype.startswith("Int"):
            try: df[col] = df[col].round().astype("Int64")
            except Exception: pass
        log(state, f"'{col}': {method} imputation using {len(num_cols)} numeric cols")

    state["df"] = df
    return jsonify(df_summary(state))

@app.route("/api/ai/impute-suggest", methods=["POST"])
def ai_impute_suggest():
    state, err = df_or_error()
    if err: return err
    if not _AI_OK: return jsonify({"error": "AI is not configured."}), 503
    df = state["df"]
    col = (request.get_json() or {}).get("column")
    if col not in df.columns: return jsonify({"error": "Unknown column."}), 400

    s = df[col]
    n_missing = int(s.isnull().sum())
    if n_missing == 0: return jsonify({"error": f"'{col}' has no missing values."}), 400

    profile = {"column": col, "dtype": str(s.dtype), "n_rows": len(s), "n_missing": n_missing, "pct_missing": round(100 * n_missing / len(s), 1)}
    if pd.api.types.is_numeric_dtype(s):
        d = s.dropna()
        profile["stats"] = {"mean": float(d.mean()), "median": float(d.median()), "std": float(d.std()), "skew": float(d.skew()) if len(d) > 2 else 0.0}
        others = [c for c in df.select_dtypes(include=np.number).columns if c != col]
        if others and len(df) > 5:
            corr = df[others + [col]].corr()[col].drop(col).dropna()
            top = corr.abs().sort_values(ascending=False).head(3)
            profile["correlated_with"] = {k: round(float(corr[k]), 2) for k in top.index}
    else:
        profile["top_values"] = s.dropna().value_counts().head(8).to_dict()

    cats = [c for c in df.select_dtypes(include=["object", "category"]).columns if c != col]
    if cats: profile["groupable_by"] = cats[:8]
    dts = df.select_dtypes(include="datetime64[ns]").columns.tolist()
    if dts: profile["datetime_columns"] = dts

    prompt = f"""Pick the best missing-value imputation method for this column.
Column profile:
{json.dumps(profile, indent=2, default=str)}

Valid methods: mean, median, mode, knn, iterative, group_median, group_mean, group_mode, ffill, bfill, interpolate, unknown, drop, custom.
Heuristics:
- >40% missing -> drop (or flag)
- <5% missing & numeric -> median is fine
- skewed distribution -> median over mean
- strong correlation (>0.5) -> knn or iterative
- time series -> ffill or interpolate
- categorical with a sensible grouping column -> group_mode
- missingness itself is informative -> unknown

Return JSON:
{{"method": "...", "group_col": null, "n_neighbors": 5, "confidence": 0.0, "reasoning": "one or two sentences"}}"""

    try:
        try:
            resp = _client.chat.completions.create(
                model=AI_MODEL, messages=[{"role": "user", "content": prompt}], max_tokens=250, response_format={"type": "json_object"}
            )
        except Exception:
            resp = _client.chat.completions.create(
                model=AI_MODEL, messages=[{"role": "user", "content": prompt}], max_tokens=250
            )
        suggestion = _extract_json(resp.choices[0].message.content)
    except Exception as e:
        return jsonify({"error": f"AI unavailable: {e}"}), 500

    if suggestion.get("method") not in IMPUTE_METHODS:
        suggestion["method"] = "median" if pd.api.types.is_numeric_dtype(s) else "mode"
        suggestion["reasoning"] = "Fallback (AI returned an unknown method)."
        suggestion["confidence"] = 0.3
    if suggestion["method"].startswith("group_") and suggestion.get("group_col") not in df.columns:
        suggestion["method"] = "mode"; suggestion["group_col"] = None
    return jsonify(suggestion)

@app.route("/api/validate/convert", methods=["POST"])
@mutates
def validate_convert():
    state, err = df_or_error()
    if err: return err
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
    if err: return err
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
@mutates
def treat_outliers():
    state, err = df_or_error()
    if err: return err
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

@app.route("/api/analyze/summary", methods=["GET"])
def analyze_summary():
    state, err = df_or_error()
    if err: return err
    df = state["df"]
    desc = df.describe(include="all").transpose()
    desc.insert(0, "column", desc.index)
    return jsonify({"rows": clean_json(desc.to_dict(orient="records"))})

@app.route("/api/analyze/correlation", methods=["GET"])
def analyze_correlation():
    state, err = df_or_error()
    if err: return err
    df = state["df"]
    numeric_df = df.select_dtypes(include=np.number)
    if numeric_df.shape[1] < 2:
        return jsonify({"columns": [], "matrix": []})
    corr = numeric_df.corr(numeric_only=True).round(3)
    return jsonify({"columns": corr.columns.tolist(), "matrix": clean_json(corr.values.tolist())})

@app.route("/api/analyze/groupby", methods=["POST"])
def analyze_groupby():
    state, err = df_or_error()
    if err: return err
    df = state["df"]
    body = request.get_json()
    group_col, num_col = body.get("group_col"), body.get("num_col")
    summary = df.groupby(group_col)[num_col].agg(["mean", "median", "min", "max", "count"]).reset_index()
    return jsonify({"rows": clean_json(summary.to_dict(orient="records"))})

@app.route("/api/visualize/chart", methods=["POST"])
def make_chart():
    state, err = df_or_error()
    if err: return err
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
            colors = sns.color_palette(["#2A6F6F", "#D9A441", "#3F8F5F", "#16213E", "#E4572E", "#7FA99B", "#C9A66B", "#5C6F7C"])
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

    return jsonify({"name": uniq, "image_b64": b64, "chart_count": len(state["charts"])})

@app.route("/api/charts", methods=["GET"])
def list_charts():
    state, err = df_or_error()
    if err: return err
    return jsonify({"charts": [
        {"name": n, "image_b64": base64.b64encode(png).decode("utf-8")}
        for n, png in state["charts"].items()
    ]})

@app.route("/api/charts/<name>", methods=["DELETE"])
def delete_chart(name):
    state, err = df_or_error()
    if err: return err
    if name not in state["charts"]:
        return jsonify({"error": "Chart not found."}), 404
    del state["charts"][name]
    log(state, f"Chart removed: {name}")
    return jsonify({"removed": name, "chart_count": len(state["charts"])})

@app.route("/api/export/xlsx", methods=["GET"])
def export_xlsx():
    state, err = df_or_error()
    if err: return err
    buf = io.BytesIO()
    state["df"].to_excel(buf, index=False, engine="openpyxl")
    buf.seek(0)
    name = f"{state['base_name']}_clean_for_powerbi.xlsx"
    return send_file(buf, as_attachment=True, download_name=name, mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")

@app.route("/api/export/csv", methods=["GET"])
def export_csv():
    state, err = df_or_error()
    if err: return err
    buf = io.BytesIO(state["df"].to_csv(index=False).encode("utf-8"))
    name = f"{state['base_name']}_clean_for_powerbi.csv"
    return send_file(buf, as_attachment=True, download_name=name, mimetype="text/csv")

@app.route("/api/export/charts", methods=["GET"])
def export_charts():
    state, err = df_or_error()
    if err: return err
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for n, png in state["charts"].items():
            zf.writestr(f"{n}.png", png)
    buf.seek(0)
    return send_file(buf, as_attachment=True, download_name=f"{state['base_name']}_charts.zip", mimetype="application/zip")

@app.route("/api/export/powerbi_guide", methods=["GET"])
def export_guide():
    state, err = df_or_error()
    if err: return err
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
