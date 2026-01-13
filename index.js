/* SiYuan Share - SiYuan plugin (no-build single file) */
/* eslint-disable no-console */

const {
  Plugin,
  fetchSyncPost,
  showMessage,
  getAllEditor,
  confirm,
  Setting,
  Dialog,
} = require("siyuan");

let fs;
let path;
try {
  fs = require("fs");
  path = require("path");
} catch (err) {
  // Browser / mobile frontend won't have Node.js builtins.
}

const STORAGE_SETTINGS = "settings";
const STORAGE_SHARES = "shares";
const STORAGE_SITE_SHARES = "sharesBySite";
const DOCK_TYPE = "siyuan-plugin-share-dock";
const MB = 1024 * 1024;
const UPLOAD_CHUNK_MIN_SIZE = 256 * 1024;
const UPLOAD_CHUNK_MAX_SIZE = 8 * MB;
const UPLOAD_CHUNK_HARD_MAX_SIZE = 10 * MB;
const UPLOAD_TARGET_CHUNK_MS = 1800;
const UPLOAD_DEFAULT_SPEED_BPS = 2 * MB;
const DEFAULT_UPLOAD_ASSET_CONCURRENCY = 8;
const DEFAULT_UPLOAD_CHUNK_CONCURRENCY = 4;
const UPLOAD_RETRY_LIMIT = 2;
const UPLOAD_RETRY_BASE_DELAY = 400;
const UPLOAD_RETRY_MAX_DELAY = 2000;

const REMOTE_API = {
  verify: "/api/v1/auth/verify",
  shares: "/api/v1/shares",
  shareDocInit: "/api/v1/shares/doc/init",
  shareDoc: "/api/v1/shares/doc",
  shareNotebookInit: "/api/v1/shares/notebook/init",
  shareNotebook: "/api/v1/shares/notebook",
  shareAssetChunk: "/api/v1/shares/asset/chunk",
  shareUploadComplete: "/api/v1/shares/upload/complete",
  shareUploadCancel: "/api/v1/shares/upload/cancel",
  shareAccessUpdate: "/api/v1/shares/access/update",
  deleteShare: "/api/v1/shares/delete",
};

const SHARE_TYPES = {
  DOC: "doc",
  NOTEBOOK: "notebook",
};

const TREE_SHARE_CLASS = "sps-tree-share";
const TREE_SHARED_CLASS = "sps-tree-item--shared";
const TREE_SHARE_ICON_ID = "iconSiyuanShare";

let globalI18nProvider = null;

function setGlobalI18nProvider(provider) {
  globalI18nProvider = typeof provider === "function" ? provider : null;
}

function tGlobal(key, vars) {
  if (globalI18nProvider) return globalI18nProvider(key, vars);
  if (!vars) return key;
  return key.replace(/\{(\w+)\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return match;
    const value = vars[name];
    return value == null ? "" : String(value);
  });
}

function getAPIToken() {
  try {
    const token = globalThis?.siyuan?.config?.api?.token;
    return typeof token === "string" ? token : "";
  } catch {
    return "";
  }
}

function getAuthHeaders() {
  const token = getAPIToken();
  if (!token) return {};
  return {Authorization: `Token ${token}`};
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

async function runTasksWithConcurrency(tasks, concurrency) {
  if (!Array.isArray(tasks) || tasks.length === 0) return;
  const limit = Math.max(1, Math.floor(concurrency || 1));
  let nextIndex = 0;
  const workers = new Array(Math.min(limit, tasks.length)).fill(null).map(async () => {
    while (nextIndex < tasks.length) {
      const current = nextIndex;
      nextIndex += 1;
      await tasks[current]();
    }
  });
  await Promise.all(workers);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err) {
  return err?.name === "AbortError" || /cancelled/i.test(String(err?.message || ""));
}

async function withRetry(task, {retries = 0, baseDelay = 0, maxDelay = 0, controller = null, onRetry = null} = {}) {
  let attempt = 0;
  while (true) {
    if (controller?.signal?.aborted) {
      throw new Error(tGlobal("siyuanShare.message.cancelled"));
    }
    try {
      return await task();
    } catch (err) {
      if (isAbortError(err) || attempt >= retries) {
        throw err;
      }
      attempt += 1;
      if (onRetry) {
        try {
          onRetry(attempt, err);
        } catch {
          // ignore
        }
      }
      const delay = Math.min(maxDelay || baseDelay, baseDelay * Math.pow(2, attempt - 1));
      const jitter = delay ? Math.floor(delay * (0.2 * Math.random())) : 0;
      if (delay + jitter > 0) {
        await sleep(delay + jitter);
      }
    }
  }
}

function nowTs() {
  return Date.now();
}

function normalizeTimestampMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num < 1e12 ? num * 1000 : num;
}

function toDateTimeLocalInput(value) {
  const ts = normalizeTimestampMs(value);
  if (!ts) return "";
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
}

function parseDateTimeLocalInput(value) {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) {
    return tGlobal("siyuanShare.format.sizeKb", {value: "0"});
  }
  const kb = value / 1024;
  if (kb < 1024) {
    const display = kb < 10 ? kb.toFixed(1) : kb.toFixed(0);
    return tGlobal("siyuanShare.format.sizeKb", {value: display});
  }
  const mb = kb / 1024;
  const display = mb < 10 ? mb.toFixed(1) : mb.toFixed(0);
  return tGlobal("siyuanShare.format.sizeMb", {value: display});
}

function getUrlHost(raw) {
  try {
    return new URL(String(raw || "")).host || "";
  } catch {
    return "";
  }
}

function tryDecodeAssetPath(value) {
  const raw = String(value || "");
  if (!/%[0-9a-fA-F]{2}/.test(raw)) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

function replaceAllText(input, search, replacement) {
  if (!search) return input;
  return String(input || "").split(search).join(replacement);
}

function appendAssetSuffix(path, index) {
  const raw = String(path || "");
  const slash = raw.lastIndexOf("/");
  const dir = slash >= 0 ? raw.slice(0, slash + 1) : "";
  const name = slash >= 0 ? raw.slice(slash + 1) : raw;
  const dot = name.lastIndexOf(".");
  if (dot > 0) {
    return `${dir}${name.slice(0, dot)}-${index}${name.slice(dot)}`;
  }
  return `${dir}${name}-${index}`;
}

function ensureUniqueAssetPath(path, used) {
  if (!path) return "";
  const taken = used || new Set();
  let candidate = path;
  let index = 1;
  while (taken.has(candidate)) {
    candidate = appendAssetSuffix(path, index);
    index += 1;
  }
  taken.add(candidate);
  return candidate;
}

function sanitizeAssetUploadPath(path, used) {
  const decoded = tryDecodeAssetPath(path) || "";
  const raw = decoded || String(path || "");
  const stripped = raw.replace(/\s+/g, "");
  const normalized = normalizeAssetPath(stripped);
  if (!normalized) return "";
  return ensureUniqueAssetPath(normalized, used);
}

function throwIfAborted(controller, message) {
  if (controller?.signal?.aborted) {
    throw new Error(message || tGlobal("siyuanShare.message.cancelled"));
  }
}

function randomSlug(len = 6) {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const pick = (bytes) => {
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  };

  try {
    if (globalThis.crypto?.getRandomValues) {
      const bytes = new Uint8Array(len);
      globalThis.crypto.getRandomValues(bytes);
      return pick(bytes);
    }
  } catch {
    // ignore
  }

  try {
    // Desktop (Node.js)
    const crypto = require("crypto");
    const bytes = crypto.randomBytes(len);
    return pick(bytes);
  } catch {
    // ignore
  }

  let out = "";
  while (out.length < len) out += Math.random().toString(36).slice(2);
  return out.slice(0, len);
}

function isValidDocId(id) {
  return typeof id === "string" && /^\d{14}-[a-z0-9]{7}$/i.test(id.trim());
}

function isValidNotebookId(id) {
  return isValidDocId(id);
}

function findAttrId(el) {
  if (!el || typeof el.getAttribute !== "function") return "";
  const attrs = [
    "data-node-id",
    "data-id",
    "data-doc-id",
    "data-root-id",
    "data-box",
    "data-url",
    "data-notebook-id",
    "data-notebook",
    "data-box-id",
    "data-boxid",
  ];
  for (const attr of attrs) {
    const v = el.getAttribute(attr);
    if (isValidDocId(v)) return v.trim();
  }
  if (el.dataset) {
    for (const v of Object.values(el.dataset)) {
      if (isValidDocId(v)) return String(v).trim();
    }
  }
  if (isValidDocId(el.id)) return el.id.trim();
  return "";
}

function findTitleFromTree(el) {
  if (!el) return "";
  const textEl =
    el.querySelector(".b3-list-item__text") ||
    el.querySelector(".b3-list-item__title") ||
    el.querySelector(".b3-list-item__name") ||
    el.querySelector(".b3-list-item__label") ||
    el.querySelector(".b3-list-item__content");
  const title = textEl?.textContent?.trim();
  if (title) return title;
  return el.textContent?.trim() || "";
}

function resolveTreeItemInfo(item) {
  if (!item) return {id: "", isNotebook: false};
  const dataType = item.getAttribute?.("data-type") || item.dataset?.type || "";
  const typeLower = String(dataType).toLowerCase();
  const notebookTypes = new Set(["notebook", "navigation-root"]);
  const docTypes = new Set(["navigation-file", "navigation-doc", "navigation-folder", "doc", "file"]);
  let isNotebook = notebookTypes.has(typeLower);
  const isDocType = docTypes.has(typeLower);
  const nextSibling = item.nextElementSibling;
  const parentList =
    item.closest?.(
      "ul[data-url], ul[data-box], ul[data-box-id], ul[data-boxid], ul[data-notebook-id], ul[data-notebook]",
    ) || item.parentElement?.closest?.(
      "ul[data-url], ul[data-box], ul[data-box-id], ul[data-boxid], ul[data-notebook-id], ul[data-notebook]",
    );
  const urlFromSelf = item.getAttribute?.("data-url") || item.dataset?.url;
  const urlFromNext = nextSibling?.getAttribute?.("data-url") || nextSibling?.dataset?.url;
  const urlFromParent = parentList?.getAttribute?.("data-url") || parentList?.dataset?.url;
  const docAttrs = ["data-node-id", "data-id", "data-doc-id", "data-root-id"];
  let docAttrValue = "";
  for (const attr of docAttrs) {
    const value = item.getAttribute?.(attr);
    if (isValidDocId(value)) {
      docAttrValue = value;
      break;
    }
  }
  if (!docAttrValue) {
    const docChild = item.querySelector?.("[data-node-id], [data-id], [data-doc-id], [data-root-id]");
    const childId = findAttrId(docChild);
    if (isValidDocId(childId)) docAttrValue = childId;
  }
  const hasDocAttr = isValidDocId(docAttrValue);
  const notebookAttrs = ["data-box", "data-box-id", "data-boxid", "data-notebook-id", "data-notebook"];
  let notebookAttrValue = "";
  for (const attr of notebookAttrs) {
    const value = item.getAttribute?.(attr);
    if (isValidDocId(value)) {
      notebookAttrValue = value;
      break;
    }
  }
  if (!notebookAttrValue) {
    const parentValues = [
      urlFromParent,
      parentList?.getAttribute?.("data-box"),
      parentList?.getAttribute?.("data-box-id"),
      parentList?.getAttribute?.("data-boxid"),
      parentList?.getAttribute?.("data-notebook-id"),
      parentList?.getAttribute?.("data-notebook"),
    ];
    for (const value of parentValues) {
      if (isValidDocId(value)) {
        notebookAttrValue = value;
        break;
      }
    }
  }
  if (isValidDocId(notebookAttrValue)) {
    isNotebook = true;
  }
  if (
    !isNotebook &&
    !isDocType &&
    !hasDocAttr &&
    (isValidDocId(urlFromSelf) || isValidDocId(urlFromNext) || isValidDocId(urlFromParent))
  ) {
    isNotebook = true;
  }
  if (isDocType || hasDocAttr) isNotebook = false;

  let id = "";
  if (isNotebook) {
    if (isValidDocId(notebookAttrValue)) id = notebookAttrValue.trim();
    else if (isValidDocId(urlFromSelf)) id = urlFromSelf.trim();
    else if (isValidDocId(urlFromNext)) id = urlFromNext.trim();
    else if (isValidDocId(urlFromParent)) id = urlFromParent.trim();
    else if (isValidDocId(docAttrValue)) id = docAttrValue.trim();
  } else if (isValidDocId(docAttrValue)) {
    id = docAttrValue.trim();
  }
  if (!id) id = findAttrId(item);

  return {id, isNotebook};
}

function pickDocTreeContainer() {
  const navItem = document.querySelector(
    ".b3-list-item[data-type^='navigation'], .b3-list-item[data-type*='navigation'], .b3-list-item[data-type='notebook']",
  );
  if (navItem) {
    return (
      navItem.closest(".file-tree") ||
      navItem.closest(".b3-list") ||
      navItem.closest(".b3-list--tree") ||
      navItem.parentElement
    );
  }
  const anyItem = document.querySelector(
    ".b3-list-item[data-node-id], .b3-list-item[data-id], .b3-list-item[data-doc-id], .b3-list-item[data-notebook-id], .b3-list-item[data-url]",
  );
  if (anyItem) {
    return anyItem.closest(".b3-list") || anyItem.parentElement;
  }
  const selectors = [
    "#dockFileTree",
    "#file-tree",
    "#fileTree",
    ".file-tree",
    ".file-tree__list",
    ".b3-list--tree",
    ".b3-list--background",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function isProbablyDocTreeItem(item) {
  if (!item) return false;
  if (item.closest?.("[data-sps-share-tree='1']")) return true;
  const dataType = item.getAttribute?.("data-type") || item.dataset?.type || "";
  if (String(dataType).toLowerCase().includes("navigation")) return true;
  const container = item.closest(
    "#dockFileTree, #file-tree, #fileTree, .file-tree, .file-tree__list, .b3-list--tree, .b3-list--background, .b3-list",
  );
  return Boolean(container);
}

function resolveDetailId(detail) {
  const candidates = [
    detail?.id,
    detail?.box,
    detail?.boxId,
    detail?.notebookId,
    detail?.data?.id,
    detail?.data?.box,
    detail?.data?.boxId,
  ];
  for (const value of candidates) {
    if (isValidDocId(value)) return String(value).trim();
  }
  return "";
}

function isElementVisiblySized(el) {
  try {
    if (!el || typeof el.getBoundingClientRect !== "function") return false;
    const r = el.getBoundingClientRect();
    return r.width > 20 && r.height > 20;
  } catch {
    return false;
  }
}

function normalizeUrlBase(url) {
  if (typeof url !== "string") return "";
  return url.trim().replace(/\s+/g, "").replace(/\/$/, "");
}

function sanitizeSlug(name) {
  const raw = String(name || "").trim();
  if (!raw) return "";
  const cleaned = raw
    .replace(/[^a-z0-9_-]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+/g, "")
    .replace(/[.-]+$/g, "");
  return cleaned.slice(0, 64);
}

function normalizeAssetPath(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const cleaned = raw.replace(/^[\\/]+/, "").split(/[?#]/)[0];
  if (!cleaned || cleaned.endsWith("/")) return "";
  return cleaned;
}

function extractAssetPaths(markdown) {
  if (typeof markdown !== "string" || !markdown) return [];
  const out = new Set();
  const patterns = [
    /\((\/?assets\/[^)\s]+)(?:\s+[^)]*)?\)/g,
    /src=["'](\/?assets\/[^"']+)["']/g,
    /href=["'](\/?assets\/[^"']+)["']/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(markdown))) {
      const normalized = normalizeAssetPath(match[1]);
      if (normalized) out.add(normalized);
    }
  }
  return Array.from(out);
}

function rewriteAssetLinks(markdown) {
  if (typeof markdown !== "string" || !markdown) return "";
  return markdown
    .replace(/\]\(\/assets\//g, "](assets/")
    .replace(/\]\(\.\/assets\//g, "](assets/")
    .replace(/src="\/assets\//g, 'src="assets/')
    .replace(/src="\.\/assets\//g, 'src="assets/')
    .replace(/href="\/assets\//g, 'href="assets/')
    .replace(/href="\.\/assets\//g, 'href="assets/');
}

function makeResourcePathsRelative(html) {
  if (typeof html !== "string") return "";
  return html
    .replace(/(src|href)="\/(assets|stage|appearance|emojis)\//g, '$1="$2/')
    .replace(/(src)="\/(emojis)/g, '$1="$2');
}

function safeJsonForHtmlScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function getSnippetCSSHtml() {
  let out = "";
  try {
    document.querySelectorAll("style").forEach((item) => {
      if (item?.id?.startsWith("snippetCSS")) out += item.outerHTML;
    });
  } catch {
    // ignore
  }
  return out;
}

function getSnippetJSHtml() {
  let out = "";
  try {
    document.querySelectorAll("script").forEach((item) => {
      if (item?.id?.startsWith("snippetJS")) out += item.outerHTML;
    });
  } catch {
    // ignore
  }
  return out;
}

function getExportIconScriptHtml() {
  const iconName = globalThis?.siyuan?.config?.appearance?.icon || "";
  if (!iconName) return "";
  const escaped = escapeAttr(iconName);
  const isBuiltInIcon = ["ant", "material"].includes(iconName);
  const fallback = isBuiltInIcon ? "" : `<script src="appearance/icons/material/icon.js"></script>`;
  return `${fallback}<script src="appearance/icons/${escaped}/icon.js"></script>`;
}

function buildExportIndexHtml({title, content, exportMode}) {
  const cfg = globalThis?.siyuan?.config || {};
  const appearance = cfg.appearance || {};
  const editor = cfg.editor || {};
  const lang = appearance.lang || "zh_CN";

  let themeName = appearance.themeLight || "daylight";
  let mode = 0;
  if (appearance.mode === 1) {
    themeName = appearance.themeDark || themeName;
    mode = 1;
  }
  const themeMode = mode === 1 ? "dark" : "light";

  const previewClass =
    exportMode === "htmlmd"
      ? "b3-typography"
      : `protyle-wysiwyg${editor.displayBookmarkIcon ? " protyle-wysiwyg--attr" : ""}`;

  const winSiyuan = {
    config: {
      appearance: {
        mode,
        codeBlockThemeDark: appearance.codeBlockThemeDark || "",
        codeBlockThemeLight: appearance.codeBlockThemeLight || "",
      },
      editor: {
        codeLineWrap: true,
        fontSize: Number(editor.fontSize) || 16,
        codeLigatures: !!editor.codeLigatures,
        plantUMLServePath: editor.plantUMLServePath || "",
        codeSyntaxHighlightLineNum: !!editor.codeSyntaxHighlightLineNum,
        katexMacros: editor.katexMacros || "",
      },
    },
    languages: {
      copy: globalThis?.siyuan?.languages?.copy || "Copy",
    },
  };

  const snippetCSS = getSnippetCSSHtml();
  const snippetJS = getSnippetJSHtml();
  const iconScript = getExportIconScriptHtml();
  const winSiyuanJson = safeJsonForHtmlScript(winSiyuan);

  return `<!DOCTYPE html>
<html lang="${escapeAttr(lang)}" data-theme-mode="${escapeAttr(themeMode)}" data-light-theme="${escapeAttr(
    appearance.themeLight || "",
  )}" data-dark-theme="${escapeAttr(appearance.themeDark || "")}">
<head>
    <base href="">
    <meta charset="utf-8">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0"/>
    <meta name="mobile-web-app-capable" content="yes"/>
    <meta name="apple-mobile-web-app-status-bar-style" content="black">
    <link rel="stylesheet" type="text/css" id="baseStyle" href="stage/build/export/base.css"/>
    <link rel="stylesheet" type="text/css" id="themeDefaultStyle" href="appearance/themes/${escapeAttr(themeName)}/theme.css"/>
    <script src="stage/protyle/js/protyle-html.js"></script>
    <title>${escapeHtml(title || "")}</title>
    <style>
        body {font-family: var(--b3-font-family);background-color: var(--b3-theme-background);color: var(--b3-theme-on-background)}
    </style>
    ${snippetCSS}
</head>
<body>
<div class="${previewClass}" style="max-width: 800px;margin: 0 auto;" id="preview">${content || ""}</div>
${iconScript}
<script src="stage/build/export/protyle-method.js"></script>
<script src="stage/protyle/js/lute/lute.min.js"></script>  
<script>
    window.siyuan = ${winSiyuanJson};
    const previewElement = document.getElementById('preview');
    Protyle.highlightRender(previewElement, "stage/protyle");
    Protyle.mathRender(previewElement, "stage/protyle", false);
    Protyle.mermaidRender(previewElement, "stage/protyle");
    Protyle.flowchartRender(previewElement, "stage/protyle");
    Protyle.graphvizRender(previewElement, "stage/protyle");
    Protyle.chartRender(previewElement, "stage/protyle");
    Protyle.mindmapRender(previewElement, "stage/protyle");
    Protyle.abcRender(previewElement, "stage/protyle");
    Protyle.htmlRender(previewElement);
    Protyle.plantumlRender(previewElement, "stage/protyle");
    document.querySelectorAll(".protyle-action__copy").forEach((item) => {
      item.addEventListener("click", (event) => {
            let text = item.parentElement.nextElementSibling.textContent.trimEnd();
            text = text.replace(/\\u00A0/g, " ");
            navigator.clipboard.writeText(text);
            event.preventDefault();
            event.stopPropagation();
      })
    });
</script>
${snippetJS}
</body></html>`;
}

function joinWorkspaceRelPath(...parts) {
  const cleaned = parts
    .flatMap((p) => (p == null ? [] : [String(p)]))
    .map((p) => p.replace(/^[\\/]+/, "").replace(/[\\/]+$/, ""))
    .filter(Boolean);
  return `/${cleaned.join("/")}`;
}

function normalizeWorkspaceRelPath(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\\/g, "/");
  return normalized.startsWith("/") ? normalized.replace(/\/+$/, "") : `/${normalized.replace(/\/+$/, "")}`;
}

function joinFsPath(base, ...parts) {
  const baseStr = String(base || "");
  const sep = baseStr.includes("\\") ? "\\" : "/";
  const baseTrimmed = baseStr.replace(/[\\/]+$/, "");
  const cleaned = parts
    .flatMap((p) => (p == null ? [] : [String(p)]))
    .map((p) => p.replace(/^[\\/]+/, "").replace(/[\\/]+$/, ""))
    .filter(Boolean);
  return [baseTrimmed, ...cleaned].join(sep);
}

async function resolveWorkspaceRoot(publishRootInput) {
  const wsInfo = await fetchSyncPost("/api/system/getWorkspaceInfo", {});
  if (!wsInfo || wsInfo.code !== 0) {
    throw new Error(wsInfo?.msg || tGlobal("siyuanShare.error.workspaceInfoFailed"));
  }
  const workspaceDir = wsInfo?.data?.workspaceDir;
  if (!workspaceDir) throw new Error(tGlobal("siyuanShare.error.workspacePathFailed"));

  const inputRaw = String(publishRootInput || "").trim();
  if (!inputRaw) throw new Error(tGlobal("siyuanShare.error.publishDirRequired"));
  const inputNorm = inputRaw.replace(/\\/g, "/").replace(/\/+$/, "");

  const wsNorm = String(workspaceDir).replace(/\\/g, "/").replace(/\/+$/, "");
  const isWindows = /^[a-zA-Z]:\//.test(wsNorm) || wsNorm.startsWith("//");

  // Windows absolute path or UNC path.
  const isWinAbs = /^[a-zA-Z]:\//.test(inputNorm) || inputNorm.startsWith("//");
  if (isWinAbs) {
    const wsCmp = isWindows ? wsNorm.toLowerCase() : wsNorm;
    const inputCmp = isWindows ? inputNorm.toLowerCase() : inputNorm;
    if (inputCmp === wsCmp) {
      return {workspaceDir, rootRel: "/"};
    }
    if (inputCmp.startsWith(`${wsCmp}/`)) {
      const rel = inputNorm.slice(wsNorm.length) || "/";
      return {workspaceDir, rootRel: rel.startsWith("/") ? rel : `/${rel}`};
    }
    throw new Error(
      tGlobal("siyuanShare.error.publishDirOutsideWorkspace", {workspace: workspaceDir}),
    );
  }

  const rel = normalizeWorkspaceRelPath(inputNorm);
  if (rel.includes("..")) throw new Error(tGlobal("siyuanShare.error.publishDirInvalid"));
  return {workspaceDir, rootRel: rel};
}

async function putWorkspaceFile(workspacePath, content, filename = "index.html", mime = "text/html") {
  const form = new FormData();
  form.append("path", workspacePath);
  form.append("isDir", "false");
  form.append("modTime", String(Date.now()));
  const blob = content instanceof Blob ? content : new Blob([String(content)], {type: mime});
  form.append("file", blob, filename);

  const resp = await fetch("/api/file/putFile", {
    method: "POST",
    body: form,
    credentials: "include",
    headers: {
      ...getAuthHeaders(),
    },
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(
      json?.msg || tGlobal("siyuanShare.error.writeFileFailedStatus", {status: resp.status}),
    );
  }
  if (json?.code !== 0) {
    throw new Error(json?.msg || tGlobal("siyuanShare.error.writeFileFailed"));
  }
}

async function safeRm(dirPath) {
  if (!fs) throw new Error(tGlobal("siyuanShare.error.nodeFsUnavailable"));
  const fsp = fs.promises;
  if (fsp.rm) {
    await fsp.rm(dirPath, {recursive: true, force: true});
    return;
  }
  // Node <14 fallback
  await fsp.rmdir(dirPath, {recursive: true});
}
function pickActiveProtyle() {
  const protyles = getAllEditor();
  if (!Array.isArray(protyles) || protyles.length === 0) return null;

  const visibles = protyles.filter((p) => isElementVisiblySized(p?.element));
  if (visibles.length === 0) return null;
  if (visibles.length === 1) return visibles[0];

  const activeWnd =
    document.querySelector(".layout__wnd--active") ||
    document.querySelector(".layout__wnd--focus") ||
    document.querySelector(".layout__wnd--current");
  if (activeWnd) {
    const hit = visibles.find((p) => p?.element && activeWnd.contains(p.element));
    if (hit) return hit;
  }

  const active = document.activeElement;
  if (active) {
    const hit = visibles.find((p) => p?.element && p.element.contains(active));
    if (hit) return hit;
  }
  return visibles[0];
}

function extractDocIdsFromDoctreeElements(elements) {
  if (!elements) return [];
  const els = Array.from(elements);
  const ids = [];
  for (const el of els) {
    if (!el || typeof el.getAttribute !== "function") continue;
    let found = "";
    const directAttrs = [
      "data-node-id",
      "data-id",
      "data-doc-id",
      "data-root-id",
      "data-block-id",
    ];
    for (const attr of directAttrs) {
      const v = el.getAttribute(attr);
      if (isValidDocId(v)) {
        found = v.trim();
        break;
      }
    }
    if (!found && el.dataset) {
      for (const v of Object.values(el.dataset)) {
        if (isValidDocId(v)) {
          found = v.trim();
          break;
        }
      }
    }
    if (!found && isValidDocId(el.id)) found = el.id.trim();
    if (found) ids.push(found);
  }
  return Array.from(new Set(ids));
}

function extractDocTreeNodes(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.tree)) return data.tree;
  if (Array.isArray(data.root?.children)) return data.root.children;
  if (Array.isArray(data.files)) return data.files;
  if (Array.isArray(data.children)) return data.children;
  return [];
}

function getDocTreeChildren(node) {
  if (!node) return [];
  const children = node.children || node.child || node.files || node.nodes;
  return Array.isArray(children) ? children : [];
}

function getDocTreeSortValue(node) {
  if (!node) return null;
  const candidates = [
    node.sort,
    node.sortOrder,
    node.sortIndex,
    node.sortId,
    node.sortID,
    node.sort_id,
    node.order,
    node.orderIndex,
    node.index,
  ];
  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function sortDocTreeNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((node, idx) => ({node, idx, sort: getDocTreeSortValue(node)}))
    .sort((a, b) => {
      const aSort = Number.isFinite(a.sort) ? a.sort : a.idx;
      const bSort = Number.isFinite(b.sort) ? b.sort : b.idx;
      if (aSort === bSort) return a.idx - b.idx;
      return aSort - bSort;
    })
    .map((entry) => entry.node);
}

function flattenDocTree(nodes, out = [], parentId = "") {
  if (!Array.isArray(nodes)) return out;
  const ordered = sortDocTreeNodes(nodes);
  ordered.forEach((node, index) => {
    const id = String(node?.id || node?.docId || node?.nodeId || node?.path || "");
    const title = String(node?.name || node?.title || node?.content || node?.label || "");
    const nodeParent =
      String(node?.parentId || node?.parentID || node?.parent_id || node?.parent || "") || "";
    const validId = isValidDocId(id);
    const sortValue = getDocTreeSortValue(node);
    const sortIndex = Number.isFinite(sortValue) ? sortValue : index;
    if (validId) {
      out.push({
        docId: id,
        title,
        parentId: nodeParent || parentId || "",
        sortIndex,
      });
    }
    const children = getDocTreeChildren(node);
    if (children.length) {
      const nextParent = validId ? id : parentId;
      flattenDocTree(children, out, nextParent);
    }
  });
  return out;
}

class SiYuanSharePlugin extends Plugin {
  constructor(options) {
    super(options);
    this.settings = {
      siteUrl: "",
      apiKey: "",
      uploadAssetConcurrency: DEFAULT_UPLOAD_ASSET_CONCURRENCY,
      uploadChunkConcurrency: DEFAULT_UPLOAD_CHUNK_CONCURRENCY,
      sites: [],
      activeSiteId: "",
    };
    this.remoteUploadLimits = null;
    this.uploadTuner = {avgSpeed: 0, samples: 0};
    this.shares = [];
    this.siteShares = {};
    this.dockElement = null;
    this.workspaceDir = "";
    this.hasNodeFs = !!(fs && path);
    this.currentDoc = {id: "", title: ""};
    this.remoteUser = null;
    this.remoteVerifiedAt = 0;
    this.notebooks = [];
    this.docTreeContainer = null;
    this.docTreeObserver = null;
    this.docTreeBindTimer = null;
    this.docTreeRefreshTimer = null;
    this.progressDialog = null;
    this.settingVisible = false;
    this.settingEls = {
      siteInput: null,
      apiKeyInput: null,
      siteSelect: null,
      siteNameInput: null,
      currentWrap: null,
      sharesWrap: null,
      envHint: null,
    };
    this.settingLayoutObserver = null;
  }

  t(key, vars) {
    const text = this.i18n?.[key] ?? key;
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (match, name) => {
      if (!Object.prototype.hasOwnProperty.call(vars, name)) return match;
      const value = vars[name];
      return value == null ? "" : String(value);
    });
  }

  notify(message, ...rest) {
    const prefix = this.displayName || this.name || "SiYuan Share";
    const text = prefix ? `${prefix}: ${message}` : message;
    showMessage(text, ...rest);
  }

  onload() {
    setGlobalI18nProvider(this.t.bind(this));
    this.loadState().catch((err) => {
      console.error(err);
      this.notify(this.t("siyuanShare.message.pluginInitFailed", {error: err.message || err}));
    });

    this.addIcons(`<symbol id="iconSiyuanShare" viewBox="0 0 24 24">
  <path fill="currentColor" d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.03-.47-.09-.7l7.02-4.11c.53.5 1.23.81 2.06.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.03.47.09.7L8.91 9.81C8.38 9.31 7.68 9 6.84 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.84 0 1.54-.31 2.07-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.52 1.23 2.75 2.75 2.75S21 23.52 21 22s-1.34-2.75-3-2.75z"/>
</symbol>`);

    this.initSettingPanel();
    this.addCommand({
      langKey: "siyuanShare.openDock",
      hotkey: "",
      callback: () => this.openShareDock(),
    });

    this.eventBus.on("click-editortitleicon", this.onEditorTitleMenu);
    this.eventBus.on("open-menu-doctree", this.onDocTreeMenu);
    this.eventBus.on("switch-protyle", this.onSwitchProtyle);
    this.eventBus.on("loaded-protyle-static", this.onLoadedProtyle);
    this.eventBus.on("loaded-protyle-dynamic", this.onLoadedProtyle);

    this.bindDocTreeLater();
    void this.refreshCurrentDocContext();
  }

  onunload() {
    setGlobalI18nProvider(null);
    if (this.dockElement) {
      this.dockElement.removeEventListener("click", this.onDockClick);
      this.dockElement.removeEventListener("change", this.onDockChange);
    }
    this.eventBus.off("click-editortitleicon", this.onEditorTitleMenu);
    this.eventBus.off("open-menu-doctree", this.onDocTreeMenu);
    this.eventBus.off("switch-protyle", this.onSwitchProtyle);
    this.eventBus.off("loaded-protyle-static", this.onLoadedProtyle);
    this.eventBus.off("loaded-protyle-dynamic", this.onLoadedProtyle);
    if (this.docTreeBindTimer) {
      clearInterval(this.docTreeBindTimer);
      this.docTreeBindTimer = null;
    }
    if (this.docTreeRefreshTimer) {
      clearTimeout(this.docTreeRefreshTimer);
      this.docTreeRefreshTimer = null;
    }
    this.detachDocTree();
    this.clearDocTreeMarks();
    if (this.settingEls.sharesWrap) {
      this.settingEls.sharesWrap.removeEventListener("click", this.onSettingSharesClick);
    }
    if (this.settingEls.currentWrap) {
      this.settingEls.currentWrap.removeEventListener("click", this.onSettingCurrentClick);
    }
    if (this.settingLayoutObserver) {
      try {
        this.settingLayoutObserver.disconnect();
      } catch {
        // ignore
      }
      this.settingLayoutObserver = null;
    }
    if (this.progressDialog) {
      try {
        this.progressDialog.destroy();
      } catch {
        // ignore
      }
      this.progressDialog = null;
    }
  }

  async uninstall() {
    await this.removeData(STORAGE_SETTINGS);
    await this.removeData(STORAGE_SHARES);
    await this.removeData(STORAGE_SITE_SHARES);
  }

  onSwitchProtyle = ({detail}) => {
    void this.refreshCurrentDocContext(detail?.protyle);
  };

  onLoadedProtyle = ({detail}) => {
    void this.refreshCurrentDocContext(detail?.protyle);
  };

  bindDocTreeLater() {
    if (this.docTreeBindTimer) clearInterval(this.docTreeBindTimer);
    this.docTreeBindTimer = setInterval(() => {
      const attached = this.attachDocTree();
      if (attached) {
        clearInterval(this.docTreeBindTimer);
        this.docTreeBindTimer = null;
      }
      this.refreshDocTreeMarks();
    }, 800);
  }

  attachDocTree({skipRefresh = false} = {}) {
    const container = pickDocTreeContainer();
    if (!container) return false;
    if (container === this.docTreeContainer && this.docTreeContainer?.isConnected) return false;
    this.detachDocTree();
    this.docTreeContainer = container;
    this.docTreeContainer.setAttribute("data-sps-share-tree", "1");
    this.docTreeContainer.addEventListener("click", this.onDocTreeClick, true);
    this.docTreeObserver = new MutationObserver(() => this.scheduleDocTreeRefresh());
    this.docTreeObserver.observe(this.docTreeContainer, {childList: true, subtree: true});
    if (!skipRefresh) {
      this.refreshDocTreeMarks();
    }
    return true;
  }

  detachDocTree() {
    if (this.docTreeContainer) {
      this.docTreeContainer.removeAttribute("data-sps-share-tree");
      this.docTreeContainer.removeEventListener("click", this.onDocTreeClick, true);
    }
    if (this.docTreeObserver) {
      this.docTreeObserver.disconnect();
      this.docTreeObserver = null;
    }
    this.docTreeContainer = null;
  }

  scheduleDocTreeRefresh() {
    if (this.docTreeRefreshTimer) return;
    this.docTreeRefreshTimer = setTimeout(() => {
      this.docTreeRefreshTimer = null;
      this.refreshDocTreeMarks();
    }, 80);
  }

  refreshDocTreeMarksLater() {
    this.attachDocTree({skipRefresh: true});
    this.refreshDocTreeMarks();
    this.scheduleDocTreeRefresh();
    this.bindDocTreeLater();
    setTimeout(() => this.scheduleDocTreeRefresh(), 300);
    setTimeout(() => this.scheduleDocTreeRefresh(), 800);
  }

  clearDocTreeMarks() {
    const clearScope = (scope) => {
      scope.querySelectorAll(`.${TREE_SHARE_CLASS}`).forEach((el) => el.remove());
      scope.querySelectorAll(`.${TREE_SHARED_CLASS}`).forEach((el) => {
        el.classList.remove(TREE_SHARED_CLASS);
      });
    };
    const hasTreeRoot = this.docTreeContainer && this.docTreeContainer.isConnected;
    if (hasTreeRoot) {
      clearScope(this.docTreeContainer);
      clearScope(document);
      return;
    }
    clearScope(document);
  }

  refreshDocTreeMarks() {
    if (this.docTreeContainer && !this.docTreeContainer.isConnected) {
      this.detachDocTree();
      this.bindDocTreeLater();
    }
    if (!this.docTreeContainer || !isElementVisiblySized(this.docTreeContainer)) {
      this.attachDocTree({skipRefresh: true});
    }
    const hasTreeRoot = this.docTreeContainer && this.docTreeContainer.isConnected;
    const applyMarks = (scope, requireFilter) => {
      let items = scope.querySelectorAll(".b3-list-item");
      if (!items.length) {
        items = scope.querySelectorAll("[data-type^='navigation'], [data-type*='navigation'], [data-type='notebook']");
      }
      items.forEach((rawItem) => {
        const item =
          rawItem.classList?.contains("b3-list-item") ? rawItem : rawItem.closest?.(".b3-list-item") || rawItem;
        if (requireFilter && !isProbablyDocTreeItem(item)) return;
        const info = resolveTreeItemInfo(item);
        if (!info?.id) return;
        const share = info.isNotebook ? this.getShareByNotebookId(info.id) : this.getShareByDocId(info.id);
        const titleEl =
          item.querySelector(".b3-list-item__text") ||
          item.querySelector(".b3-list-item__title") ||
          item.querySelector(".b3-list-item__name") ||
          item.querySelector(".b3-list-item__label") ||
          item.querySelector(".b3-list-item__content") ||
          item;
        const existing = titleEl.querySelector(`.${TREE_SHARE_CLASS}`);
        if (share) {
          item.classList.add(TREE_SHARED_CLASS);
          let icon = existing;
          if (!icon) {
            icon = document.createElement("span");
            icon.className = TREE_SHARE_CLASS;
            titleEl.appendChild(icon);
          }
          icon.setAttribute("data-share-type", share.type);
          icon.setAttribute("data-share-id", info.id);
          icon.innerHTML = `<svg><use xlink:href="#${TREE_SHARE_ICON_ID}"></use></svg>`;
        } else {
          item.classList.remove(TREE_SHARED_CLASS);
          if (existing) existing.remove();
        }
      });
    };
    if (hasTreeRoot) {
      applyMarks(this.docTreeContainer, false);
      applyMarks(document, true);
      return;
    }
    applyMarks(document, true);
  }

  onDocTreeClick = (event) => {
    const icon = event.target?.closest?.(`.${TREE_SHARE_CLASS}`);
    if (!icon) return;
    const type = icon.getAttribute("data-share-type");
    const id = icon.getAttribute("data-share-id");
    if (!type || !id) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    const item = icon.closest(".b3-list-item") || icon.parentElement;
    const title = findTitleFromTree(item) || id;
    void this.openShareDialogFor({type, id, title});
  };

  getDocIdFromProtyle(protyle) {
    const pid = protyle?.id;
    if (isValidDocId(pid)) return pid.trim();
    const rootID = protyle?.block?.rootID;
    if (isValidDocId(rootID)) return rootID.trim();
    const id = protyle?.block?.id;
    if (isValidDocId(id)) return id.trim();
    return "";
  }

  async fetchBlockRow(blockId) {
    if (!isValidDocId(blockId)) return null;
    try {
      const resp = await fetchSyncPost("/api/query/sql", {
        stmt: `SELECT id, root_id AS rootId, content AS content, type AS type FROM blocks WHERE id='${blockId}' LIMIT 1`,
      });
      if (resp && resp.code === 0 && Array.isArray(resp.data) && resp.data.length > 0) {
        return resp.data[0] || null;
      }
    } catch (err) {
      console.error(err);
    }
    return null;
  }

  async resolveDocInfoFromAnyId(anyId) {
    if (!isValidDocId(anyId)) return {docId: "", title: ""};
    const row = await this.fetchBlockRow(anyId);
    if (!row) return {docId: "", title: ""};

    const type = row.type;
    if (type === "d") {
      return {docId: anyId, title: typeof row.content === "string" ? row.content : ""};
    }

    const rootId = row.rootId;
    if (!isValidDocId(rootId)) return {docId: "", title: ""};
    const rootRow = await this.fetchBlockRow(rootId);
    const title = rootRow && typeof rootRow.content === "string" ? rootRow.content : "";
    return {docId: rootId, title};
  }

  extractAnyBlockIdFromDOM() {
    const candidates = [];
    const pushFromEl = (el) => {
      if (!el || typeof el.getAttribute !== "function") return;
      const attrs = [
        "data-node-id",
        "data-id",
        "data-block-id",
        "data-root-id",
        "data-doc-id",
      ];
      for (const attr of attrs) {
        const v = el.getAttribute(attr);
        if (isValidDocId(v)) {
          candidates.push(v.trim());
          return;
        }
      }
      if (el.dataset) {
        for (const v of Object.values(el.dataset)) {
          if (isValidDocId(v)) {
            candidates.push(v.trim());
            return;
          }
        }
      }
      if (isValidDocId(el.id)) candidates.push(el.id.trim());
    };

    // 1) From active element upwards.
    let el = document.activeElement;
    if (el && typeof el.closest === "function" && el.closest(".protyle")) {
      for (let i = 0; el && i < 20; i++) {
        pushFromEl(el);
        el = el.parentElement;
      }
    }

    // 2) From focused protyle block.
    const protyleEls = Array.from(document.querySelectorAll(".protyle")).filter((p) => isElementVisiblySized(p));
    const bestProtyle = protyleEls.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    })[0];

    pushFromEl(bestProtyle);
    const blockInProtyle = bestProtyle?.querySelector?.("[data-node-id]");
    pushFromEl(blockInProtyle);

    return candidates.find(Boolean) || "";
  }

  async refreshCurrentDocContext(protyle) {
    const p = protyle || pickActiveProtyle() || globalThis?.siyuan?.mobile?.editor || globalThis?.siyuan?.mobile?.popEditor;
    let docId = this.getDocIdFromProtyle(p);
    let title = "";

    if (!docId) {
      // Fallback 1: use block id from protyle.block.id and resolve to root doc id.
      const isFromVisibleProtyle = !p?.element || isElementVisiblySized(p?.element);
      const anyId = isFromVisibleProtyle ? p?.block?.id : "";
      if (isValidDocId(anyId)) {
        const info = await this.resolveDocInfoFromAnyId(anyId);
        docId = info.docId;
        title = info.title;
      }
    }

    if (!docId) {
      // Fallback 2: try DOM (active block id) and resolve to root doc id.
      const anyId = this.extractAnyBlockIdFromDOM();
      if (isValidDocId(anyId)) {
        const info = await this.resolveDocInfoFromAnyId(anyId);
        docId = info.docId;
        title = info.title;
      }
    }

    if (!docId) {
      // Fallback 3: backStack (desktop).
      const hasVisibleProtyle = Array.from(document.querySelectorAll(".protyle")).some((el) => isElementVisiblySized(el));
      if (!hasVisibleProtyle) {
        // When no document is opened, backStack may still contain the last doc.
        // Avoid treating it as current.
      } else {
      try {
        const stack = globalThis?.siyuan?.backStack;
        if (Array.isArray(stack) && stack.length > 0) {
          for (let i = stack.length - 1; i >= 0; i--) {
            const item = stack[i];
            const id = item?.protyle?.block?.rootID || item?.id;
            if (isValidDocId(id)) {
              const info = await this.resolveDocInfoFromAnyId(id);
              docId = info.docId;
              title = info.title;
              break;
            }
          }
        }
      } catch {
        // ignore
      }
      }
    }

    if (!docId) {
      this.currentDoc = {id: "", title: ""};
      this.updateTopBarState();
      this.renderSettingCurrent?.();
      return;
    }

    if (this.currentDoc.id !== docId) {
      if (!title) {
        const info = await this.resolveDocInfoFromAnyId(docId);
        title = info.title;
      }
      this.currentDoc = {id: docId, title: title || ""};
    }

    this.updateTopBarState();
    this.renderSettingCurrent?.();
  }

  updateTopBarState() {
    this.refreshDocTreeMarks();
  }

  getShareById(shareId) {
    if (!shareId) return null;
    return this.shares.find((s) => String(s.id) === String(shareId)) || null;
  }

  getShareByDocId(docId) {
    if (!isValidDocId(docId)) return null;
    return this.shares.find((s) => s.type === SHARE_TYPES.DOC && s.docId === docId) || null;
  }

  getShareByNotebookId(notebookId) {
    if (!isValidNotebookId(notebookId)) return null;
    return (
      this.shares.find((s) => s.type === SHARE_TYPES.NOTEBOOK && s.notebookId === notebookId) || null
    );
  }

  getShareUrl(share) {
    if (!share) return "";
    const base = normalizeUrlBase(this.settings.siteUrl);
    if (share.url) return share.url;
    const path = share.path || (share.slug ? `/s/${encodeURIComponent(share.slug)}` : "");
    if (!base || !path) return "";
    return `${base}${path}`;
  }

  async openShareDialogFor({type = SHARE_TYPES.DOC, id = "", title = ""} = {}) {
    const t = this.t.bind(this);
    const itemType = type === SHARE_TYPES.NOTEBOOK ? SHARE_TYPES.NOTEBOOK : SHARE_TYPES.DOC;
    let itemId = String(id || "").trim();
    if (!itemId && itemType === SHARE_TYPES.DOC) {
      for (let i = 0; i < 5; i++) {
        await this.refreshCurrentDocContext();
        if (isValidDocId(this.currentDoc.id)) break;
        await new Promise((r) => setTimeout(r, 120));
      }
      itemId = this.currentDoc.id;
    }
    if (!itemId) {
      this.notify(t("siyuanShare.message.noCurrentDoc"));
      return;
    }

    let itemTitle = title || itemId;
    if (itemType === SHARE_TYPES.DOC) {
      if (!itemTitle || itemTitle === itemId) {
        const info = await this.resolveDocInfoFromAnyId(itemId);
        itemTitle = info?.title || itemTitle || t("siyuanShare.label.unknown");
      }
    } else {
      if (!this.notebooks.length) {
        await this.refreshNotebookOptions({silent: true});
      }
      const notebook = this.notebooks.find((n) => n.id === itemId);
      itemTitle = notebook?.name || itemTitle || t("siyuanShare.label.unknown");
    }

    const typeLabel =
      itemType === SHARE_TYPES.NOTEBOOK ? t("siyuanShare.label.notebook") : t("siyuanShare.label.document");
    const passwordKeepToken = "__KEEP__";
    const getShare = () =>
      itemType === SHARE_TYPES.NOTEBOOK ? this.getShareByNotebookId(itemId) : this.getShareByDocId(itemId);
    const buildViewState = () => {
      const share = getShare();
      const url = share ? this.getShareUrl(share) : "";
      const hasPassword = !!share?.hasPassword;
      const expiresAt = normalizeTimestampMs(share?.expiresAt || 0);
      const expiresInputValue = expiresAt ? toDateTimeLocalInput(expiresAt) : "";
      const visitorLimitValue = Number.isFinite(Number(share?.visitorLimit))
        ? Math.max(0, Math.floor(Number(share.visitorLimit)))
        : 0;
      const visitorInputValue = visitorLimitValue > 0 ? String(visitorLimitValue) : "";
      const currentPasswordLabel = hasPassword
        ? t("siyuanShare.label.passwordSet")
        : t("siyuanShare.label.passwordNotSet");
      const currentExpiresLabel = expiresAt ? this.formatTime(expiresAt) : t("siyuanShare.label.expiresNotSet");
      const currentVisitorLabel =
        visitorLimitValue > 0
          ? t("siyuanShare.label.visitorLimitCount", {count: visitorLimitValue})
          : t("siyuanShare.label.visitorLimitNotSet");
      const passwordInputValue = share && hasPassword ? passwordKeepToken : "";
      const passwordPlaceholder = share
        ? (hasPassword ? t("siyuanShare.hint.passwordKeep") : t("siyuanShare.label.passwordNotSet"))
        : t("siyuanShare.hint.passwordOptional");
      return {
        share,
        url,
        expiresInputValue,
        visitorLimitValue,
        visitorInputValue,
        currentPasswordLabel,
        currentExpiresLabel,
        currentVisitorLabel,
        passwordInputValue,
        passwordPlaceholder,
      };
    };

    const renderContent = () => {
      const state = buildViewState();
      const share = state.share;
      const url = state.url;
      const expiresInputValue = state.expiresInputValue;
      const visitorInputValue = state.visitorInputValue;
      const currentPasswordLabel = state.currentPasswordLabel;
      const currentExpiresLabel = state.currentExpiresLabel;
      const currentVisitorLabel = state.currentVisitorLabel;
      const passwordInputValue = state.passwordInputValue;
      const passwordPlaceholder = state.passwordPlaceholder;
      return `<div class="siyuan-plugin-share sps-dialog-body">
  <div class="siyuan-plugin-share__section">
    <div class="siyuan-plugin-share__title">${escapeHtml(typeLabel)}</div>
    <div>${escapeHtml(itemTitle)}</div>
    <div class="siyuan-plugin-share__muted siyuan-plugin-share__mono">${escapeHtml(
      t("siyuanShare.label.id"),
    )}: ${escapeHtml(itemId)}</div>
  </div>
  <div class="siyuan-plugin-share__section">
    <div class="siyuan-plugin-share__title">${escapeHtml(t("siyuanShare.section.accessSettings"))}</div>
    <div class="siyuan-plugin-share__grid">
      <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.accessPassword"))}</div>
      <input id="sps-share-password" type="password" class="b3-text-field" value="${escapeAttr(
        passwordInputValue,
      )}" placeholder="${escapeAttr(passwordPlaceholder)}" />
      <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.expiresAt"))}</div>
      <input id="sps-share-expires" type="datetime-local" step="60" class="b3-text-field" value="${escapeAttr(
        expiresInputValue,
      )}" />
      <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.visitorLimit"))}</div>
      <input id="sps-share-visitor-limit" type="number" min="0" step="1" class="b3-text-field" value="${escapeAttr(
        visitorInputValue,
      )}" placeholder="${escapeAttr(t("siyuanShare.hint.visitorLimit"))}" />
    </div>
    <div class="siyuan-plugin-share__muted">${escapeHtml(
      currentPasswordLabel,
    )} | ${escapeHtml(currentExpiresLabel)} | ${escapeHtml(currentVisitorLabel)}</div>
  </div>
  <div class="siyuan-plugin-share__section">
    <div class="siyuan-plugin-share__title">${escapeHtml(t("siyuanShare.section.shareLink"))}</div>
    ${
      share
        ? `<div class="siyuan-plugin-share__muted">${escapeHtml(
            t("siyuanShare.label.shareId"),
          )}: <span class="siyuan-plugin-share__mono">${escapeHtml(share.slug || "")}</span></div>
      <div class="siyuan-plugin-share__actions" style="align-items: center;">
        <input class="b3-text-field fn__flex-1 siyuan-plugin-share__mono" readonly value="${escapeAttr(url)}" />
        <button class="b3-button b3-button--outline" data-action="copy" data-share-id="${escapeAttr(
          share.id,
        )}">${escapeHtml(t("siyuanShare.action.copyLink"))}</button>
      </div>
      <div class="siyuan-plugin-share__actions">
        <button class="b3-button b3-button--outline" data-action="update" data-share-id="${escapeAttr(
          share.id,
        )}">${escapeHtml(t("siyuanShare.action.updateShare"))}</button>
        <button class="b3-button b3-button--outline" data-action="update-access" data-share-id="${escapeAttr(
          share.id,
        )}">${escapeHtml(t("siyuanShare.action.updateAccess"))}</button>
        <button class="b3-button b3-button--outline" data-action="delete" data-share-id="${escapeAttr(
          share.id,
        )}">${escapeHtml(t("siyuanShare.action.deleteShare"))}</button>
      </div>`
        : `<div class="siyuan-plugin-share__muted">${escapeHtml(
            t("siyuanShare.message.noShareYet"),
          )}</div>
      <div class="siyuan-plugin-share__actions">
        <button class="b3-button b3-button--outline" data-action="share" data-item-id="${escapeAttr(
          itemId,
        )}">${escapeHtml(t("siyuanShare.action.createShare"))}</button>
      </div>`
    }
  </div>
</div>
<div class="b3-dialog__action">
  <button class="b3-button b3-button--cancel" data-action="close">${escapeHtml(
    t("siyuanShare.action.close"),
  )}</button>
  <div class="fn__space"></div>
  <button class="b3-button b3-button--text" data-action="open-settings">${escapeHtml(
    t("siyuanShare.action.openSettings"),
  )}</button>
</div>`;
    };
    const content = `<div class="sps-share-dialog-content">${renderContent()}</div>`;

    const readShareOptions = (root, currentShare) => {
      const passwordInput = root?.querySelector?.("#sps-share-password");
      const expiresInput = root?.querySelector?.("#sps-share-expires");
      const visitorInput = root?.querySelector?.("#sps-share-visitor-limit");
      const passwordRaw = (passwordInput?.value || "").trim();
      const expiresAt = parseDateTimeLocalInput(expiresInput?.value || "");
      const visitorRaw = (visitorInput?.value || "").trim();
      const visitorParsed = Number(visitorRaw);
      const visitorLimit = Number.isFinite(visitorParsed)
        ? Math.max(0, Math.floor(visitorParsed))
        : null;
      const hasExistingPassword = !!currentShare?.hasPassword;
      const hasExistingExpires = normalizeTimestampMs(currentShare?.expiresAt || 0) > 0;
      const hasExistingVisitorLimit = Number(currentShare?.visitorLimit || 0) > 0;
      const password = passwordRaw === passwordKeepToken ? "" : passwordRaw;
      return {
        password,
        clearPassword: !!currentShare && hasExistingPassword && passwordRaw === "",
        expiresAt,
        clearExpires: !!currentShare && hasExistingExpires && !expiresAt,
        visitorLimit,
        clearVisitorLimit: !!currentShare && hasExistingVisitorLimit && visitorRaw === "",
      };
    };

    const onClick = (event) => {
      const btn = event.target.closest("[data-action]");
      if (!btn) return;
      const action = btn.getAttribute("data-action");
      if (!action) return;

      void (async () => {
        try {
          if (action === "close") {
            dialog.destroy();
            return;
          }
          if (action === "open-settings") {
            this.openSetting();
            setTimeout(() => this.applySettingWideLayout(), 80);
            return;
          }
          if (action === "copy") {
            const shareId = btn.getAttribute("data-share-id");
            await this.copyShareLink(shareId);
            return;
          }
          if (action === "update") {
            const shareId = btn.getAttribute("data-share-id");
            const options = readShareOptions(dialog.element, getShare());
            await this.updateShare(shareId, options);
            refreshDialog();
            return;
          }
          if (action === "update-access") {
            const shareId = btn.getAttribute("data-share-id");
            const options = readShareOptions(dialog.element, getShare());
            await this.updateShareAccess(shareId, options);
            refreshDialog();
            return;
          }
          if (action === "delete") {
            const shareId = btn.getAttribute("data-share-id");
            await this.deleteShare(shareId);
            refreshDialog();
            return;
          }
          if (action === "share") {
            const options = readShareOptions(dialog.element, getShare());
            if (itemType === SHARE_TYPES.NOTEBOOK) {
              await this.shareNotebook(itemId, options);
            } else {
              await this.shareDoc(itemId, options);
            }
            refreshDialog();
          }
        } catch (err) {
          this.showErr(err);
        }
      })();
    };

    let dialog = null;
    const attachCopyFocus = () => {
      const input = dialog?.element?.querySelector?.("input.b3-text-field[readonly]");
      if (input) {
        input.addEventListener("focus", () => input.select());
      }
    };
    const refreshDialog = () => {
      const contentEl = dialog?.element?.querySelector?.(".sps-share-dialog-content");
      if (!contentEl) return;
      contentEl.innerHTML = renderContent();
      attachCopyFocus();
    };

    dialog = new Dialog({
      title: t("siyuanShare.title.shareManagement"),
      content,
      width: "min(720px, 92vw)",
      destroyCallback: () => {
        dialog.element.removeEventListener("click", onClick);
      },
    });

    dialog.element.addEventListener("click", onClick);
    attachCopyFocus();
  }

  startSettingLayoutObserver() {
    if (this.settingLayoutObserver || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      this.applySettingWideLayout();
      this.handleSettingVisibilityChange();
    });
    observer.observe(document.body, {childList: true, subtree: true});
    this.settingLayoutObserver = observer;
    this.applySettingWideLayout();
    this.handleSettingVisibilityChange();
  }

  handleSettingVisibilityChange() {
    const {siteInput, apiKeyInput} = this.settingEls || {};
    const isVisible = !!(siteInput?.isConnected || apiKeyInput?.isConnected);
    if (isVisible) {
      this.settingVisible = true;
      return;
    }
    if (this.settingVisible) {
      this.settingVisible = false;
      void this.saveSettingsFromSetting({notify: false});
    }
  }

  makeSettingRowFullWidth(actionEl) {
    if (!actionEl) return false;
    const row = actionEl.closest?.("label.b3-label, .b3-label");
    if (!row) return false;
    if (row.classList.contains("sps-setting-full-row")) return true;
    row.classList.add("sps-setting-full-row");
    try {
      row.style.flexDirection = "column";
      row.style.alignItems = "stretch";
      row.style.justifyContent = "flex-start";
      row.style.gap = "8px";
    } catch {
      // ignore
    }
    try {
      actionEl.style.width = "100%";
      actionEl.style.alignSelf = "stretch";
      actionEl.style.flex = "1";
      actionEl.style.minWidth = "0";
    } catch {
      // ignore
    }
    return true;
  }

  applySettingWideLayout() {
    const {currentWrap, sharesWrap} = this.settingEls || {};
    this.makeSettingRowFullWidth(currentWrap);
    this.makeSettingRowFullWidth(sharesWrap);
    this.alignSettingSiteSelectWidth();
  }

  alignSettingSiteSelectWidth() {
    const {siteSelect, siteNameInput, siteInput, apiKeyInput} = this.settingEls || {};
    if (!siteSelect) return;
    const ref =
      (siteNameInput && siteNameInput.isConnected && siteNameInput) ||
      (siteInput && siteInput.isConnected && siteInput) ||
      (apiKeyInput && apiKeyInput.isConnected && apiKeyInput) ||
      null;
    if (!ref) return;
    const rect = ref.getBoundingClientRect();
    const width = Math.round(rect?.width || 0);
    if (!Number.isFinite(width) || width <= 0) return;
    siteSelect.style.width = `${width}px`;
    siteSelect.style.maxWidth = `${width}px`;
  }

  onDockClick = (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.getAttribute("data-action");
    if (!action) return;

    void (async () => {
      try {
        if (action === "sync-remote") {
          await this.saveSettingsFromUI();
          await this.trySyncRemoteShares({silent: false});
          return;
        }
        if (action === "disconnect") {
          await this.disconnectRemote();
          return;
        }
        if (action === "copy-link") {
          const shareId = target.getAttribute("data-share-id");
          await this.copyShareLink(shareId);
          return;
        }
        if (action === "update") {
          const shareId = target.getAttribute("data-share-id");
          await this.updateShare(shareId);
          return;
        }
        if (action === "update-access") {
          const shareId = target.getAttribute("data-share-id");
          const share = this.getShareById(shareId);
          if (!share) throw new Error(this.t("siyuanShare.error.shareNotFound"));
          const itemId = share.type === SHARE_TYPES.NOTEBOOK ? share.notebookId : share.docId;
          await this.openShareDialogFor({type: share.type, id: itemId, title: share.title || ""});
          return;
        }
        if (action === "delete") {
          const shareId = target.getAttribute("data-share-id");
          await this.deleteShare(shareId);
          return;
        }
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  onEditorTitleMenu = ({detail}) => {
    try {
      const t = this.t.bind(this);
      const {menu, data} = detail || {};
      const docId = data?.rootID || data?.id;
      if (!isValidDocId(docId)) return;
      const share = this.getShareByDocId(docId);
      menu.addItem({
        icon: "iconSiyuanShare",
        label: t("siyuanShare.title.shareManagement"),
        click: () => void this.openShareDialogFor({type: SHARE_TYPES.DOC, id: docId}),
      });
      if (share) {
        menu.addItem({
          icon: "iconRefresh",
          label: t("siyuanShare.action.updateShare"),
          click: () => void this.updateShare(share?.id).catch(this.showErr),
        });
        menu.addItem({
          icon: "iconCopy",
          label: t("siyuanShare.action.copyShareLink"),
          click: () => void this.copyShareLink(share?.id).catch(this.showErr),
        });
        menu.addItem({
          icon: "iconTrashcan",
          label: t("siyuanShare.action.deleteShare"),
          click: () => void this.deleteShare(share?.id).catch(this.showErr),
        });
      }
    } catch (err) {
      console.error(err);
    }
  };

  onDocTreeMenu = ({detail}) => {
    try {
      const t = this.t.bind(this);
      const {menu, elements, type} = detail || {};
      const rawElements = elements ?? detail?.element;
      let elementList = [];
      if (rawElements) {
        if (Array.isArray(rawElements)) {
          elementList = rawElements;
        } else if (typeof rawElements.length === "number") {
          elementList = Array.from(rawElements);
        } else {
          elementList = [rawElements];
        }
      }
      if (!menu || elementList.length === 0) return;

      const targetEl = elementList[0];
      const pickElementWithId = (el) => {
        if (!el) return null;
        if (findAttrId(el)) return el;
        const closestItem = el.closest?.(".b3-list-item");
        if (closestItem && findAttrId(closestItem)) return closestItem;
        const closestWithId = el.closest?.(
          "[data-node-id],[data-id],[data-doc-id],[data-root-id],[data-box],[data-url],[data-notebook-id],[data-notebook],[data-box-id],[data-boxid]",
        );
        if (closestWithId && findAttrId(closestWithId)) return closestWithId;
        const childWithId = el.querySelector?.(
          "[data-node-id],[data-id],[data-doc-id],[data-root-id],[data-box],[data-url],[data-notebook-id],[data-notebook],[data-box-id],[data-boxid]",
        );
        if (childWithId && findAttrId(childWithId)) return childWithId;
        return el;
      };

      let holder = null;
      let id = "";
      for (const el of elementList) {
        const candidate = pickElementWithId(el);
        const candidateId = findAttrId(candidate);
        if (candidateId) {
          holder = candidate;
          id = candidateId;
          break;
        }
      }
      if (!id) {
        const candidate = pickElementWithId(targetEl);
        id = findAttrId(candidate);
        holder = candidate || targetEl;
      }
      if (!id) id = resolveDetailId(detail);

      const dataType =
        holder?.getAttribute("data-type") ||
        holder?.dataset?.type ||
        targetEl?.getAttribute("data-type") ||
        targetEl?.dataset?.type;
      const detailType = detail?.data?.type || type;
      const docAttrCandidates = [
        holder?.getAttribute?.("data-node-id"),
        holder?.getAttribute?.("data-id"),
        holder?.getAttribute?.("data-doc-id"),
        holder?.getAttribute?.("data-root-id"),
      ];
      const docAttrValue = docAttrCandidates.find((val) => isValidDocId(val));
      let isNotebook =
        detailType === "notebook" ||
        detailType === "navigation-root" ||
        dataType === "notebook" ||
        dataType === "navigation-root";
      const notebookAttrCandidates = [
        holder?.getAttribute?.("data-url"),
        holder?.getAttribute?.("data-box"),
        holder?.getAttribute?.("data-box-id"),
        holder?.getAttribute?.("data-boxid"),
        holder?.getAttribute?.("data-notebook-id"),
        holder?.getAttribute?.("data-notebook"),
      ];
      if (!isNotebook) {
        const urlAttr = notebookAttrCandidates.find((val) => isValidDocId(val));
        if (docAttrValue) {
          isNotebook = false;
        } else if (isValidDocId(urlAttr)) {
          isNotebook = true;
        }
      }
      if (!id && isNotebook) {
        const notebookEl =
          holder?.closest?.("ul[data-url]") ||
          targetEl?.closest?.("ul[data-url]") ||
          targetEl?.querySelector?.("ul[data-url]");
        const notebookId = notebookEl?.getAttribute?.("data-url") || "";
        if (isValidDocId(notebookId)) id = notebookId.trim();
        if (!id) {
          const idFromAttr = notebookAttrCandidates.find((val) => isValidDocId(val));
          if (isValidDocId(idFromAttr)) id = idFromAttr.trim();
        }
      }

      const treeItem =
        holder?.closest?.(".b3-list-item") ||
        targetEl?.closest?.(".b3-list-item") ||
        holder ||
        targetEl;
      const treeInfo = resolveTreeItemInfo(treeItem);
      if (treeInfo?.id) {
        id = treeInfo.id;
        isNotebook = treeInfo.isNotebook;
      }
      if (!id) return;

      const itemType = isNotebook ? SHARE_TYPES.NOTEBOOK : SHARE_TYPES.DOC;
      const title = findTitleFromTree(treeItem || holder || targetEl) || id;
      const share =
        itemType === SHARE_TYPES.NOTEBOOK ? this.getShareByNotebookId(id) : this.getShareByDocId(id);

      menu.addItem({
        icon: "iconSiyuanShare",
        label: share ? t("siyuanShare.action.manageShare") : t("siyuanShare.action.createShare"),
        click: () => void this.openShareDialogFor({type: itemType, id, title}),
      });
      if (share) {
        menu.addItem({
          icon: "iconRefresh",
          label: t("siyuanShare.action.updateShare"),
          click: () => void this.updateShare(share?.id).catch(this.showErr),
        });
        menu.addItem({
          icon: "iconCopy",
          label: t("siyuanShare.action.copyShareLink"),
          click: () => void this.copyShareLink(share?.id).catch(this.showErr),
        });
        menu.addItem({
          icon: "iconTrashcan",
          label: t("siyuanShare.action.deleteShare"),
          click: () => void this.deleteShare(share?.id).catch(this.showErr),
        });
      }
    } catch (err) {
      console.error(err);
    }
  };

  showErr = (err) => {
    console.error(err);
    const t = this.t.bind(this);
    let message = err?.message || String(err);
    const lower = message.toLowerCase();
    if (
      lower.includes("api key") ||
      lower.includes("invalid api key") ||
      lower.includes("unauthorized") ||
      lower.includes("401")
    ) {
      message = t("siyuanShare.error.invalidApiKey");
    } else if (lower.includes("storage") || lower.includes("quota") || lower.includes("space")) {
      message = t("siyuanShare.error.storageLimit");
    } else if (
      lower.includes("failed to fetch") ||
      lower.includes("network") ||
      lower.includes("connect") ||
      lower.includes("fetch")
    ) {
      message = t("siyuanShare.error.networkFail");
    } else if (lower.includes("invalid metadata")) {
      message = t("siyuanShare.error.invalidMetadata");
    } else if (lower.includes("missing docid")) {
      message = t("siyuanShare.error.missingDocId");
    }
    this.notify(message);
  };

  openProgressDialog(message, controller) {
    const t = this.t.bind(this);
    try {
      if (this.progressDialog) {
        this.progressDialog.destroy();
      }
    } catch {
      // ignore
    }
    const rawMessage = message || t("siyuanShare.message.processing");
    const safeMessage = escapeHtml(rawMessage);
    const dialog = new Dialog({
      title: t("siyuanShare.title.processing"),
      content: `<div class="sps-progress">
  <div class="sps-progress__header">
    <div class="sps-progress__title">${safeMessage}</div>
    <div class="sps-progress__percent" style="display:none"></div>
  </div>
  <div class="sps-progress__detail" style="display:none"></div>
  <div class="sps-progress__bar"><div class="sps-progress__bar-inner"></div></div>
</div>
<div class="b3-dialog__action">
  <div class="fn__space"></div>
  <button class="b3-button b3-button--outline" data-action="cancel">${t(
    "siyuanShare.action.cancel",
  )}</button>
</div>`,
      width: "360px",
    });
    this.progressDialog = dialog;

    const label = dialog.element?.querySelector?.(".sps-progress__title");
    const percentEl = dialog.element?.querySelector?.(".sps-progress__percent");
    const detailEl = dialog.element?.querySelector?.(".sps-progress__detail");
    const bar = dialog.element?.querySelector?.(".sps-progress__bar-inner");
    let currentText = rawMessage;
    const setIndeterminate = () => {
      if (!bar) return;
      bar.style.animation = "";
      bar.style.width = "";
    };
    const setDeterminate = (value) => {
      if (!bar) return 0;
      const clamped = Math.max(0, Math.min(100, value));
      bar.style.animation = "none";
      bar.style.width = `${clamped}%`;
      return clamped;
    };
    const update = (next, percent = null, detail = "") => {
      let text = next;
      let pct = percent;
      let extra = detail;
      if (next && typeof next === "object") {
        text = next.text;
        pct = next.percent;
        extra = next.detail;
      }
      if (typeof text === "string") {
        currentText = text;
      } else if (text == null) {
        text = currentText;
      } else {
        currentText = String(text);
        text = currentText;
      }
      const extraText = extra ? String(extra) : "";
      const hasPercent = pct !== null && pct !== undefined && pct !== "";
      const numeric = hasPercent ? Number(pct) : NaN;
      if (label) label.textContent = String(text || "");
      if (detailEl) {
        if (extraText) {
          detailEl.textContent = extraText;
          detailEl.style.display = "";
        } else {
          detailEl.textContent = "";
          detailEl.style.display = "none";
        }
      }
      if (Number.isFinite(numeric)) {
        const clamped = setDeterminate(numeric);
        if (percentEl) {
          percentEl.textContent = `${Math.round(clamped)}%`;
          percentEl.style.display = "";
        }
      } else {
        setIndeterminate();
        if (percentEl) {
          percentEl.textContent = "";
          percentEl.style.display = "none";
        }
      }
    };
    const close = () => {
      try {
        dialog.destroy();
      } catch {
        // ignore
      }
      if (this.progressDialog === dialog) {
        this.progressDialog = null;
      }
    };

    dialog.element?.addEventListener("click", (event) => {
      const btn = event.target?.closest?.("[data-action='cancel']");
      if (!btn) return;
      if (controller) controller.abort();
      close();
    });

    return {close, update};
  }

  async loadState() {
    const settings = (await this.loadData(STORAGE_SETTINGS)) || {};
    const legacyShares = (await this.loadData(STORAGE_SHARES)) || [];
    const siteSharesRaw = (await this.loadData(STORAGE_SITE_SHARES)) || {};
    const siteShares =
      siteSharesRaw && typeof siteSharesRaw === "object" && !Array.isArray(siteSharesRaw) ? siteSharesRaw : {};
    let sites = this.normalizeSiteList(settings.sites);
    let activeSiteId = String(settings.activeSiteId || "");
    let persistSettings = false;
    if (!sites.length && (settings.siteUrl || settings.apiKey)) {
      const fallback = {
        id: randomSlug(10),
        name: this.resolveSiteName("", settings.siteUrl || "", 0),
        siteUrl: String(settings.siteUrl || "").trim(),
        apiKey: String(settings.apiKey || "").trim(),
      };
      sites.push(fallback);
      activeSiteId = fallback.id;
      persistSettings = true;
    }
    if (activeSiteId && !sites.find((site) => String(site.id) === activeSiteId)) {
      activeSiteId = "";
      persistSettings = true;
    }
    if (!activeSiteId && sites.length) {
      activeSiteId = String(sites[0].id || "");
      persistSettings = true;
    }
    const activeSite = sites.find((site) => String(site.id) === activeSiteId) || null;
    let persistShares = false;
    if (Array.isArray(legacyShares) && legacyShares.length && activeSiteId && !siteShares[activeSiteId]) {
      siteShares[activeSiteId] = legacyShares;
      persistShares = true;
    }
    this.siteShares = siteShares;
    this.settings = {
      siteUrl: activeSite?.siteUrl || "",
      apiKey: activeSite?.apiKey || "",
      uploadAssetConcurrency: normalizePositiveInt(
        settings.uploadAssetConcurrency,
        DEFAULT_UPLOAD_ASSET_CONCURRENCY,
      ),
      uploadChunkConcurrency: normalizePositiveInt(
        settings.uploadChunkConcurrency,
        DEFAULT_UPLOAD_CHUNK_CONCURRENCY,
      ),
      sites,
      activeSiteId,
    };
    const activeShares = activeSiteId ? this.siteShares[activeSiteId] : null;
    this.shares = Array.isArray(activeShares) ? activeShares.filter((s) => s && s.id && s.type) : [];
    this.hasNodeFs = !!(fs && path);
    this.workspaceDir = "";
    this.syncSettingInputs();
    this.renderSettingShares();
    this.renderDock();
    this.updateTopBarState();
    void this.refreshCurrentDocContext();
    if (persistSettings) {
      await this.saveData(STORAGE_SETTINGS, this.settings);
    }
    if (persistShares) {
      await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
    }
  }

  initSettingPanel() {
    const t = this.t.bind(this);
    const siteSelect = document.createElement("select");
    siteSelect.className = "b3-select sps-site-select sps-site-select--setting";
    siteSelect.addEventListener("change", this.onSiteSelectChange);

    const siteNameInput = document.createElement("input");
    siteNameInput.className = "b3-text-field fn__block";
    siteNameInput.placeholder = t("siyuanShare.label.siteName");

    const siteActions = document.createElement("div");
    siteActions.className = "siyuan-plugin-share__actions";
    siteActions.innerHTML = `
  <button class="b3-button b3-button--outline" data-action="site-add">${t(
    "siyuanShare.action.addSite",
  )}</button>
  <button class="b3-button b3-button--outline" data-action="site-remove">${t(
    "siyuanShare.action.removeSite",
  )}</button>
`;
    siteActions.addEventListener("click", this.onSettingSitesClick);

    const siteInput = document.createElement("input");
    siteInput.className = "b3-text-field fn__block";
    siteInput.placeholder = t("siyuanShare.placeholder.siteUrl");

    const apiKeyInput = document.createElement("input");
    apiKeyInput.className = "b3-text-field fn__block";
    apiKeyInput.type = "password";
    apiKeyInput.placeholder = t("siyuanShare.label.apiKey");

    const currentWrap = document.createElement("div");
    currentWrap.className = "siyuan-plugin-share";
    currentWrap.addEventListener("click", this.onSettingCurrentClick);

    const sharesWrap = document.createElement("div");
    sharesWrap.className = "siyuan-plugin-share";
    sharesWrap.addEventListener("click", this.onSettingSharesClick);

    const envHint = document.createElement("div");
    envHint.className = "siyuan-plugin-share__muted sps-setting-hint";

    this.settingEls = {
      siteInput,
      apiKeyInput,
      siteSelect,
      siteNameInput,
      currentWrap,
      sharesWrap,
      envHint,
    };

    this.setting = new Setting({
      width: "92vw",
      height: "80vh",
    });

    this.setting.addItem({
      title: t("siyuanShare.label.site"),
      description: t("siyuanShare.hint.siteList"),
      createActionElement: () => siteSelect,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.siteName"),
      description: "",
      createActionElement: () => siteNameInput,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.siteActions"),
      description: "",
      createActionElement: () => siteActions,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.siteUrl"),
      description: t("siyuanShare.hint.siteUrl"),
      createActionElement: () => siteInput,
    });
    this.setting.addItem({
      title: t("siyuanShare.label.apiKey"),
      description: t("siyuanShare.hint.apiKey"),
      createActionElement: () => apiKeyInput,
    });

    const connectActions = document.createElement("div");
    connectActions.className = "siyuan-plugin-share__actions";
    connectActions.innerHTML = `
  <button class="b3-button b3-button--outline" data-action="settings-sync">${t(
    "siyuanShare.action.verifySync",
  )}</button>
  <button class="b3-button b3-button--outline" data-action="settings-disconnect">${t(
    "siyuanShare.action.disconnect",
  )}</button>
`;
    connectActions.addEventListener("click", this.onSettingActionsClick);
    this.setting.addItem({
      title: t("siyuanShare.label.connectionSync"),
      description: t("siyuanShare.hint.connectionSync"),
      direction: "column",
      createActionElement: () => connectActions,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.envInfo"),
      description: "",
      direction: "column",
      createActionElement: () => envHint,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.currentShareInfo"),
      description: t("siyuanShare.hint.currentShare"),
      direction: "column",
      createActionElement: () => currentWrap,
    });

    this.setting.addItem({
      title: t("siyuanShare.label.shareList"),
      description: t("siyuanShare.hint.shareList"),
      direction: "column",
      createActionElement: () => sharesWrap,
    });

    this.syncSettingInputs();
    this.renderSettingCurrent();
    this.renderSettingShares();
    this.startSettingLayoutObserver();
  }

  resolveSiteName(name, siteUrl, fallbackIndex = 0) {
    const trimmed = String(name || "").trim();
    if (trimmed) return trimmed;
    const host = getUrlHost(siteUrl);
    if (host) return host;
    const url = String(siteUrl || "").trim();
    if (url) return url;
    return `${this.t("siyuanShare.label.site")} ${fallbackIndex + 1}`;
  }

  normalizeSiteList(rawSites) {
    const sites = [];
    const seen = new Set();
    if (!Array.isArray(rawSites)) return sites;
    rawSites.forEach((raw) => {
      if (!raw || typeof raw !== "object") return;
      let id = String(raw.id || "").trim();
      if (!id || seen.has(id)) {
        id = randomSlug(10);
      }
      const siteUrl = String(raw.siteUrl || "").trim();
      const apiKey = String(raw.apiKey || "").trim();
      const name = this.resolveSiteName(raw.name, siteUrl, sites.length);
      sites.push({id, name, siteUrl, apiKey});
      seen.add(id);
    });
    return sites;
  }

  getActiveSite() {
    const sites = Array.isArray(this.settings.sites) ? this.settings.sites : [];
    const activeId = String(this.settings.activeSiteId || "");
    return sites.find((site) => site && String(site.id) === activeId) || sites[0] || null;
  }

  getSiteOptionLabel(site, index = 0) {
    if (!site) return `${this.t("siyuanShare.label.site")} ${index + 1}`;
    const name = this.resolveSiteName(site.name, site.siteUrl, index);
    const host = getUrlHost(site.siteUrl);
    if (host && host !== name) {
      return `${name} (${host})`;
    }
    return name || host || `${this.t("siyuanShare.label.site")} ${index + 1}`;
  }

  syncSettingInputs() {
    const {siteInput, apiKeyInput, envHint, siteSelect, siteNameInput} = this.settingEls || {};
    if (siteInput) siteInput.value = this.settings.siteUrl || "";
    if (apiKeyInput) apiKeyInput.value = this.settings.apiKey || "";
    if (siteSelect) {
      const sites = Array.isArray(this.settings.sites) ? this.settings.sites : [];
      const activeId = String(this.settings.activeSiteId || "");
      siteSelect.innerHTML = "";
      sites.forEach((site, index) => {
        const option = document.createElement("option");
        option.value = String(site.id || "");
        option.textContent = this.getSiteOptionLabel(site, index);
        siteSelect.appendChild(option);
      });
      if (activeId) {
        siteSelect.value = activeId;
      }
    }
    if (siteNameInput) {
      const active = this.getActiveSite();
      siteNameInput.value = active?.name || "";
    }
    if (envHint) {
      const t = this.t.bind(this);
      const base = normalizeUrlBase(this.settings.siteUrl);
      const hasKey = !!(this.settings.apiKey || "").trim();
      if (!base || !hasKey) {
        envHint.textContent = t("siyuanShare.hint.needSiteAndKey");
        return;
      }
      const userLabel = this.remoteUser?.username
        ? t("siyuanShare.hint.statusConnectedUser", {
            user: escapeHtml(this.remoteUser.username),
          })
        : t("siyuanShare.hint.statusConnectedNoUser");
      const timeLabel = this.remoteVerifiedAt
        ? t("siyuanShare.hint.lastVerifiedAt", {
            time: escapeHtml(this.formatTime(this.remoteVerifiedAt)),
          })
        : "";
      envHint.innerHTML = timeLabel ? `${userLabel} · ${timeLabel}` : userLabel;
    }
  }

  persistCurrentSiteInputs() {
    const {siteInput, apiKeyInput, siteNameInput} = this.settingEls || {};
    const siteUrl = (siteInput?.value || "").trim();
    const apiKey = (apiKeyInput?.value || "").trim();
    const siteName = (siteNameInput?.value || "").trim();
    let sites = this.normalizeSiteList(this.settings.sites);
    let activeSiteId = String(this.settings.activeSiteId || "");
    let activeSite = sites.find((site) => String(site.id) === activeSiteId);
    if (!activeSite && (siteUrl || apiKey || siteName)) {
      activeSiteId = activeSiteId || randomSlug(10);
      activeSite = {
        id: activeSiteId,
        name: this.resolveSiteName(siteName, siteUrl, sites.length),
        siteUrl,
        apiKey,
      };
      sites.push(activeSite);
    } else if (activeSite) {
      activeSite.siteUrl = siteUrl;
      activeSite.apiKey = apiKey;
      activeSite.name = this.resolveSiteName(siteName || activeSite.name, siteUrl, sites.indexOf(activeSite));
    }
    this.settings = {
      ...this.settings,
      siteUrl,
      apiKey,
      sites,
      activeSiteId,
    };
    return {siteUrl, apiKey, siteName, sites, activeSiteId};
  }

  async applyActiveSite(siteId, {persist = true} = {}) {
    const sites = this.normalizeSiteList(this.settings.sites);
    const next = sites.find((site) => String(site.id) === String(siteId)) || sites[0] || null;
    const activeSiteId = next ? String(next.id) : "";
    this.settings = {
      ...this.settings,
      sites,
      activeSiteId,
      siteUrl: next?.siteUrl || "",
      apiKey: next?.apiKey || "",
    };
    this.remoteUser = null;
    this.remoteVerifiedAt = 0;
    this.remoteUploadLimits = null;
    this.shares = Array.isArray(this.siteShares?.[activeSiteId]) ? this.siteShares[activeSiteId] : [];
    if (persist) {
      await this.saveData(STORAGE_SETTINGS, this.settings);
    }
    this.syncSettingInputs();
    this.renderDock();
    this.renderSettingCurrent();
    this.renderSettingShares();
    this.updateTopBarState();
  }

  saveSettingsFromSetting = async ({notify = true} = {}) => {
    const t = this.t.bind(this);
    this.persistCurrentSiteInputs();
    this.shares = Array.isArray(this.siteShares?.[this.settings.activeSiteId])
      ? this.siteShares[this.settings.activeSiteId]
      : [];
    await this.saveData(STORAGE_SETTINGS, this.settings);
    if (!this.settings.siteUrl || !this.settings.apiKey) {
      this.shares = [];
      if (this.settings.activeSiteId) {
        this.siteShares[this.settings.activeSiteId] = [];
        await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
      }
    }
    this.remoteUser = null;
    this.remoteVerifiedAt = 0;
    this.remoteUploadLimits = null;
    this.renderDock();
    this.renderSettingShares();
    this.syncSettingInputs();
    if (notify) this.notify(t("siyuanShare.message.disconnected"));
  };

  onSiteSelectChange = (event) => {
    const nextId = String(event?.target?.value || "");
    if (!nextId || String(this.settings.activeSiteId || "") === nextId) return;
    void (async () => {
      try {
        this.persistCurrentSiteInputs();
        await this.applyActiveSite(nextId, {persist: false});
        await this.saveData(STORAGE_SETTINGS, this.settings);
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  onDockChange = (event) => {
    const target = event.target;
    if (!target || target.id !== "sps-site-select") return;
    const nextId = String(target.value || "");
    if (!nextId || String(this.settings.activeSiteId || "") === nextId) return;
    void (async () => {
      try {
        const siteUrl = this.getInputValue("sps-site").trim();
        const apiKey = this.getInputValue("sps-apikey").trim();
        let sites = this.normalizeSiteList(this.settings.sites);
        let activeSiteId = String(this.settings.activeSiteId || "");
        let activeSite = sites.find((site) => String(site.id) === activeSiteId);
        if (!activeSite && (siteUrl || apiKey)) {
          activeSiteId = activeSiteId || randomSlug(10);
          activeSite = {
            id: activeSiteId,
            name: this.resolveSiteName("", siteUrl, sites.length),
            siteUrl,
            apiKey,
          };
          sites.push(activeSite);
        } else if (activeSite) {
          activeSite.siteUrl = siteUrl;
          activeSite.apiKey = apiKey;
          activeSite.name = this.resolveSiteName(activeSite.name, siteUrl, sites.indexOf(activeSite));
        }
        this.settings = {
          ...this.settings,
          sites,
          siteUrl,
          apiKey,
          activeSiteId,
        };
        await this.applyActiveSite(nextId, {persist: true});
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  onSettingSitesClick = (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (!action) return;
    void (async () => {
      try {
        if (action === "site-add") {
          this.persistCurrentSiteInputs();
          const sites = this.normalizeSiteList(this.settings.sites);
          const newSiteId = randomSlug(10);
          const newSite = {
            id: newSiteId,
            name: this.resolveSiteName("", "", sites.length),
            siteUrl: "",
            apiKey: "",
          };
          sites.push(newSite);
          this.settings = {
            ...this.settings,
            sites,
            activeSiteId: newSiteId,
            siteUrl: "",
            apiKey: "",
          };
          this.siteShares[newSiteId] = this.siteShares[newSiteId] || [];
          this.shares = this.siteShares[newSiteId];
          this.remoteUser = null;
          this.remoteVerifiedAt = 0;
          this.remoteUploadLimits = null;
          await this.saveData(STORAGE_SETTINGS, this.settings);
          await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
          this.syncSettingInputs();
          this.renderDock();
          this.renderSettingCurrent();
          this.renderSettingShares();
          this.updateTopBarState();
          return;
        }
        if (action === "site-remove") {
          const activeId = String(this.settings.activeSiteId || "");
          if (!activeId) return;
          const sites = this.normalizeSiteList(this.settings.sites).filter(
            (site) => String(site.id) !== activeId,
          );
          if (this.siteShares?.[activeId]) {
            delete this.siteShares[activeId];
          }
          const nextSite = sites[0] || null;
          this.settings = {
            ...this.settings,
            sites,
            activeSiteId: nextSite?.id || "",
            siteUrl: nextSite?.siteUrl || "",
            apiKey: nextSite?.apiKey || "",
          };
          this.shares = nextSite?.id && this.siteShares?.[nextSite.id] ? this.siteShares[nextSite.id] : [];
          this.remoteUser = null;
          this.remoteVerifiedAt = 0;
          this.remoteUploadLimits = null;
          await this.saveData(STORAGE_SETTINGS, this.settings);
          await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
          this.syncSettingInputs();
          this.renderDock();
          this.renderSettingCurrent();
          this.renderSettingShares();
          this.updateTopBarState();
          return;
        }
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  onSettingActionsClick = (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (!action) return;

    void (async () => {
      try {
        if (action === "settings-sync") {
          await this.saveSettingsFromSetting({notify: false});
          await this.trySyncRemoteShares({silent: false});
          return;
        }
        if (action === "settings-disconnect") {
          await this.disconnectRemote();
          return;
        }
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  onSettingCurrentClick = (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (!action) return;

    void (async () => {
      try {
        const t = this.t.bind(this);
        const docId = this.currentDoc.id;
        if (!isValidDocId(docId)) throw new Error(t("siyuanShare.message.noCurrentDoc"));

        const share = this.getShareByDocId(docId);
        if (!share) throw new Error(t("siyuanShare.message.currentDocNoShare"));
        if (action === "copy-link") return await this.copyShareLink(share.id);
        if (action === "update") return await this.updateShare(share.id);
        if (action === "update-access") {
          await this.openShareDialogFor({type: SHARE_TYPES.DOC, id: docId});
          return;
        }
        if (action === "delete") return await this.deleteShare(share.id);
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  onSettingSharesClick = (event) => {
    const btn = event.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    const shareId = btn.getAttribute("data-share-id");
    if (!action || !shareId) return;
    void (async () => {
      try {
        if (action === "copy-link") return await this.copyShareLink(shareId);
        if (action === "update") return await this.updateShare(shareId);
        if (action === "update-access") {
          const share = this.getShareById(shareId);
          if (!share) throw new Error(this.t("siyuanShare.error.shareNotFound"));
          const itemId = share.type === SHARE_TYPES.NOTEBOOK ? share.notebookId : share.docId;
          await this.openShareDialogFor({type: share.type, id: itemId, title: share.title || ""});
          return;
        }
        if (action === "delete") return await this.deleteShare(shareId);
      } catch (err) {
        this.showErr(err);
      }
    })();
  };

  renderSettingCurrent() {
    const wrap = this.settingEls?.currentWrap;
    if (!wrap) return;

    const t = this.t.bind(this);
    const docId = this.currentDoc.id;
    if (!isValidDocId(docId)) {
      wrap.innerHTML = `<div class="siyuan-plugin-share__section">
  <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.message.noCurrentDoc"))}</div>
</div>`;
      return;
    }

    const title = this.currentDoc.title || t("siyuanShare.label.untitledDoc");
    const share = this.getShareByDocId(docId);
    const url = share ? this.getShareUrl(share) : "";
    const passwordLabel = share?.hasPassword
      ? t("siyuanShare.label.passwordSet")
      : t("siyuanShare.label.passwordNotSet");
    const expiresLabel = share?.expiresAt ? this.formatTime(share.expiresAt) : t("siyuanShare.label.expiresNotSet");
    const visitorLimitValue = Number(share?.visitorLimit) || 0;
    const visitorLabel =
      visitorLimitValue > 0
        ? t("siyuanShare.label.visitorLimitCount", {count: visitorLimitValue})
        : t("siyuanShare.label.visitorLimitNotSet");
    wrap.innerHTML = `<div class="siyuan-plugin-share__section">
  <div class="siyuan-plugin-share__title">${escapeHtml(
    share ? t("siyuanShare.label.sharedDoc") : t("siyuanShare.label.unsharedDoc"),
  )}</div>
  <div>${escapeHtml(title)}</div>
  <div class="siyuan-plugin-share__muted siyuan-plugin-share__mono">${escapeHtml(
    t("siyuanShare.label.id"),
  )}: ${escapeHtml(docId)}</div>
  ${
    share
      ? `<div class="siyuan-plugin-share__muted">${escapeHtml(
          t("siyuanShare.label.shareId"),
        )}: <span class="siyuan-plugin-share__mono">${escapeHtml(
          share.slug || "",
        )}</span> | ${escapeHtml(t("siyuanShare.label.updatedAt"))}: ${escapeHtml(
          this.formatTime(share.updatedAt),
        )}</div>
  <div class="siyuan-plugin-share__muted">${escapeHtml(
          passwordLabel,
        )} | ${escapeHtml(expiresLabel)} | ${escapeHtml(visitorLabel)}</div>
  <div class="siyuan-plugin-share__actions" style="align-items: center;">
    <input class="b3-text-field fn__flex-1 siyuan-plugin-share__mono" readonly value="${escapeAttr(url)}" />
    <button class="b3-button b3-button--outline" data-action="copy-link">${escapeHtml(
      t("siyuanShare.action.copyLink"),
    )}</button>
  </div>
  <div class="siyuan-plugin-share__actions">
    <button class="b3-button b3-button--outline" data-action="update">${escapeHtml(
      t("siyuanShare.action.updateShare"),
    )}</button>
    <button class="b3-button b3-button--outline" data-action="update-access">${escapeHtml(
      t("siyuanShare.action.updateAccess"),
    )}</button>
    <button class="b3-button b3-button--outline" data-action="delete">${escapeHtml(
      t("siyuanShare.action.deleteShare"),
    )}</button>
  </div>`
      : `<div class="siyuan-plugin-share__muted">${escapeHtml(
          t("siyuanShare.message.currentDocNoShare"),
        )}</div>`
  }
</div>`;
  }

  renderSettingShares() {
    const wrap = this.settingEls?.sharesWrap;
    if (!wrap) return;
    const t = this.t.bind(this);
    const items = this.shares
      .map((s) => {
        const url = this.getShareUrl(s);
        const isCurrent = s.type === SHARE_TYPES.DOC && s.docId === this.currentDoc.id;
        const typeLabel =
          s.type === SHARE_TYPES.NOTEBOOK ? t("siyuanShare.label.notebook") : t("siyuanShare.label.document");
        const idLabel = s.type === SHARE_TYPES.NOTEBOOK ? s.notebookId : s.docId;
        const passwordLabel = s.hasPassword ? t("siyuanShare.label.passwordYes") : t("siyuanShare.label.passwordNo");
        const expiresLabel = s.expiresAt ? this.formatTime(s.expiresAt) : t("siyuanShare.label.expiresNotSet");
        const visitorLimitValue = Number(s.visitorLimit) || 0;
        const visitorLabel =
          visitorLimitValue > 0
            ? t("siyuanShare.label.visitorLimitCount", {count: visitorLimitValue})
            : t("siyuanShare.label.visitorLimitNotSet");
        return `<div class="sps-share-item ${isCurrent ? "sps-share-item--current" : ""}">
  <div class="sps-share-item__main">
    <div class="sps-share-item__title" title="${escapeAttr(s.title || "")}">${escapeHtml(
          s.title || t("siyuanShare.label.untitled"),
        )}</div>
    <div class="sps-share-item__meta">
      <span class="siyuan-plugin-share__mono" title="${escapeAttr(
          t("siyuanShare.label.shareId"),
        )}">${escapeHtml(s.slug || "")}</span>
      <span class="siyuan-plugin-share__muted" title="${escapeAttr(
          t("siyuanShare.label.type"),
        )}">${escapeHtml(typeLabel)}</span>
      <span class="siyuan-plugin-share__muted" title="${escapeAttr(
          t("siyuanShare.label.updatedAt"),
        )}">${escapeHtml(
          this.formatTime(s.updatedAt),
        )}</span>
      <span class="siyuan-plugin-share__muted" title="${escapeAttr(
          t("siyuanShare.label.accessSettings"),
        )}">${escapeHtml(
          passwordLabel,
        )} | ${escapeHtml(expiresLabel)} | ${escapeHtml(visitorLabel)}</span>
      <span class="siyuan-plugin-share__muted siyuan-plugin-share__mono" title="${escapeAttr(
          t("siyuanShare.label.id"),
        )}">${escapeHtml(
          idLabel || "",
        )}</span>
    </div>
    <div class="sps-share-item__link">
      <input class="b3-text-field fn__flex-1 siyuan-plugin-share__mono" readonly value="${escapeAttr(url)}" />
      <button class="b3-button b3-button--outline" data-action="copy-link" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.copyLink"))}</button>
    </div>
  </div>
  <div class="sps-share-item__actions">
    <button class="b3-button b3-button--outline" data-action="update" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.updateShare"))}</button>
    <button class="b3-button b3-button--outline" data-action="update-access" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.updateAccess"))}</button>
    <button class="b3-button b3-button--outline" data-action="delete" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.deleteShare"))}</button>
  </div>
</div>`;
      })
      .join("");

    wrap.innerHTML = `<div class="siyuan-plugin-share__section">
  <div class="siyuan-plugin-share__title">${escapeHtml(
    t("siyuanShare.title.shareListCount", {count: this.shares.length}),
  )}</div>
  <div class="sps-share-list">
    ${items || `<div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.message.noShareRecords"))}</div>`}
  </div>
</div>`;
  }


  async saveSettingsFromUI() {
    const siteUrl = this.getInputValue("sps-site").trim();
    const apiKey = this.getInputValue("sps-apikey").trim();
    const siteSelectId = this.getInputValue("sps-site-select").trim();
    let sites = this.normalizeSiteList(this.settings.sites);
    let activeSiteId = siteSelectId || String(this.settings.activeSiteId || "");
    let activeSite = sites.find((site) => String(site.id) === activeSiteId);
    if (!activeSite && (siteUrl || apiKey)) {
      activeSiteId = activeSiteId || randomSlug(10);
      activeSite = {
        id: activeSiteId,
        name: this.resolveSiteName("", siteUrl, sites.length),
        siteUrl,
        apiKey,
      };
      sites.push(activeSite);
    } else if (activeSite) {
      activeSite.siteUrl = siteUrl;
      activeSite.apiKey = apiKey;
      activeSite.name = this.resolveSiteName(activeSite.name, siteUrl, sites.indexOf(activeSite));
    }
    this.settings = {
      ...this.settings,
      siteUrl,
      apiKey,
      sites,
      activeSiteId,
    };
    this.shares = Array.isArray(this.siteShares?.[activeSiteId]) ? this.siteShares[activeSiteId] : [];
    await this.saveData(STORAGE_SETTINGS, this.settings);
    if (!this.settings.siteUrl || !this.settings.apiKey) {
      this.shares = [];
      if (activeSiteId) {
        this.siteShares[activeSiteId] = [];
        await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
      }
    }
    this.remoteUser = null;
    this.remoteVerifiedAt = 0;
    this.remoteUploadLimits = null;
    this.syncSettingInputs();
    this.renderDock();
    this.renderSettingShares();
    this.updateTopBarState();
  }

  getInputValue(id) {
    if (!this.dockElement) return "";
    const el = this.dockElement.querySelector(`#${CSS.escape(id)}`);
    if (!el) return "";
    return el.value || "";
  }

  openShareDock() {
    try {
      this.openSetting();
      setTimeout(() => this.applySettingWideLayout(), 80);
    } catch (err) {
      console.error(err);
      this.notify(this.t("siyuanShare.message.openSharePanelFailed"));
    }
  }

  getUploadConcurrency() {
    return {
      asset: normalizePositiveInt(
        this.settings.uploadAssetConcurrency,
        DEFAULT_UPLOAD_ASSET_CONCURRENCY,
      ),
      chunk: normalizePositiveInt(
        this.settings.uploadChunkConcurrency,
        DEFAULT_UPLOAD_CHUNK_CONCURRENCY,
      ),
    };
  }

  normalizeUploadLimits(raw) {
    if (!raw || typeof raw !== "object") return null;
    const min = normalizePositiveInt(raw.minChunkSize, UPLOAD_CHUNK_MIN_SIZE);
    const max = normalizePositiveInt(raw.maxChunkSize, UPLOAD_CHUNK_MAX_SIZE);
    const safeMin = Math.max(1, Math.min(min, max));
    const cappedMax = Math.min(max, UPLOAD_CHUNK_HARD_MAX_SIZE);
    const safeMax = Math.max(safeMin, cappedMax);
    return {minChunkSize: safeMin, maxChunkSize: safeMax};
  }

  getUploadChunkLimits() {
    const remote = this.remoteUploadLimits || {};
    const min = normalizePositiveInt(remote.minChunkSize, UPLOAD_CHUNK_MIN_SIZE);
    const max = normalizePositiveInt(remote.maxChunkSize, UPLOAD_CHUNK_MAX_SIZE);
    const safeMin = Math.max(1, Math.min(min, max));
    const cappedMax = Math.min(max, UPLOAD_CHUNK_HARD_MAX_SIZE);
    const safeMax = Math.max(safeMin, cappedMax);
    return {min: safeMin, max: safeMax};
  }

  getUploadSpeedBps() {
    const speed = this.uploadTuner?.avgSpeed;
    if (Number.isFinite(speed) && speed > 0) return speed;
    return UPLOAD_DEFAULT_SPEED_BPS;
  }

  updateUploadSpeed(bytes, ms) {
    const size = Number(bytes);
    const elapsed = Number(ms);
    if (!Number.isFinite(size) || !Number.isFinite(elapsed) || size <= 0 || elapsed <= 0) return;
    const speed = (size / elapsed) * 1000;
    const tuner = this.uploadTuner || {avgSpeed: 0, samples: 0};
    const alpha = 0.2;
    tuner.avgSpeed = tuner.avgSpeed ? tuner.avgSpeed * (1 - alpha) + speed * alpha : speed;
    tuner.samples = (tuner.samples || 0) + 1;
    this.uploadTuner = tuner;
  }

  getAdaptiveAssetConcurrency(totalBytes, totalAssets, maxConcurrency, sizes = []) {
    const limit = normalizePositiveInt(maxConcurrency, DEFAULT_UPLOAD_ASSET_CONCURRENCY);
    const total = Math.max(1, Number(totalAssets) || 1);
    if (total <= 1) return 1;
    const size = Number(totalBytes);
    const avgSize = Number.isFinite(size) && total > 0 ? size / total : 0;
    const speed = this.getUploadSpeedBps();
    let concurrency = 1;
    if (total >= 100) {
      concurrency = 8;
    } else if (total >= 50) {
      concurrency = 6;
    } else if (total >= 20) {
      concurrency = 4;
    } else if (total >= 10) {
      concurrency = 3;
    } else if (total >= 4) {
      concurrency = 2;
    }
    const filteredSizes = Array.isArray(sizes) ? sizes.filter((s) => Number.isFinite(s) && s > 0) : [];
    if (filteredSizes.length > 0) {
      const sorted = filteredSizes.slice().sort((a, b) => a - b);
      const mid = sorted[Math.floor(sorted.length * 0.5)] || 0;
      const p90 = sorted[Math.floor(sorted.length * 0.9)] || mid;
      const max = sorted[sorted.length - 1] || mid;
      if (mid > 0) {
        if (mid <= 128 * 1024) {
          concurrency = Math.max(concurrency, 8);
        } else if (mid <= 256 * 1024) {
          concurrency = Math.max(concurrency, 6);
        } else if (mid <= 512 * 1024) {
          concurrency = Math.max(concurrency, 4);
        } else if (mid <= 2 * MB) {
          concurrency = Math.max(concurrency, 3);
        } else if (mid <= 8 * MB) {
          concurrency = Math.max(concurrency, 2);
        }
      }
      if (p90 >= 32 * MB) {
        concurrency = Math.min(concurrency, 3);
      }
      if (max >= 64 * MB) {
        concurrency = Math.min(concurrency, 2);
      }
      if (max >= 128 * MB) {
        concurrency = 1;
      }
    } else if (avgSize > 0) {
      if (avgSize <= 512 * 1024) {
        concurrency = Math.max(concurrency, 4);
      } else if (avgSize <= 2 * MB) {
        concurrency = Math.max(concurrency, 3);
      } else if (avgSize <= 8 * MB) {
        concurrency = Math.max(concurrency, 2);
      }
      if (avgSize >= 128 * MB) {
        concurrency = Math.min(concurrency, 1);
      } else if (avgSize >= 64 * MB) {
        concurrency = Math.min(concurrency, 2);
      }
    }
    if (speed >= 12 * MB) {
      concurrency = Math.max(concurrency, 6);
    } else if (speed >= 8 * MB) {
      concurrency = Math.max(concurrency, 5);
    } else if (speed >= 4 * MB) {
      concurrency = Math.max(concurrency, 4);
    } else if (speed >= 2 * MB) {
      concurrency = Math.max(concurrency, 3);
    }
    return Math.min(limit, concurrency, total);
  }

  getAdaptiveChunkSize(sizeBytes) {
    const size = Number(sizeBytes) || 0;
    const {min, max} = this.getUploadChunkLimits();
    if (size > 0 && size <= min) return size;
    const speed = this.getUploadSpeedBps();
    let chunkSize = Math.round((speed * UPLOAD_TARGET_CHUNK_MS) / 1000);
    let sizeHint = 0;
    if (size >= 1024 * MB) {
      sizeHint = max;
    } else if (size >= 512 * MB) {
      sizeHint = Math.min(max, 6 * MB);
    } else if (size >= 256 * MB) {
      sizeHint = Math.min(max, 4 * MB);
    } else if (size >= 128 * MB) {
      sizeHint = Math.min(max, 3 * MB);
    } else if (size >= 64 * MB) {
      sizeHint = Math.min(max, 2 * MB);
    } else if (size >= 16 * MB) {
      sizeHint = Math.min(max, 1 * MB);
    } else if (size >= 4 * MB) {
      sizeHint = Math.min(max, Math.max(min, 512 * 1024));
    }
    chunkSize = Math.max(chunkSize, sizeHint);
    chunkSize = Math.max(min, Math.min(max, chunkSize));
    if (size > 0 && chunkSize > size) {
      chunkSize = size;
    }
    return chunkSize;
  }

  getAdaptiveChunkConcurrency(sizeBytes, chunkSize, maxConcurrency) {
    const size = Number(sizeBytes) || 0;
    const chunk = Math.max(1, Number(chunkSize) || 1);
    const totalChunks = Math.max(1, Math.ceil(size / chunk));
    const limit = normalizePositiveInt(maxConcurrency, DEFAULT_UPLOAD_CHUNK_CONCURRENCY);
    const speed = this.getUploadSpeedBps();
    let concurrency = 1;
    if (speed >= 10 * MB) {
      concurrency = 4;
    } else if (speed >= 6 * MB) {
      concurrency = 3;
    } else if (speed >= 2.5 * MB) {
      concurrency = 2;
    }
    if (size >= 512 * MB) {
      concurrency = Math.max(concurrency, 4);
    } else if (size >= 256 * MB) {
      concurrency = Math.max(concurrency, 3);
    } else if (size >= 128 * MB) {
      concurrency = Math.max(concurrency, 2);
    }
    if (totalChunks <= 2) {
      concurrency = 1;
    } else if (totalChunks <= 4) {
      concurrency = Math.min(concurrency, 2);
    }
    return Math.min(limit, concurrency, totalChunks);
  }

  formatUploadDetail(uploaded, total, assetDone = null, assetTotal = null) {
    const hasAssets = Number.isFinite(assetDone) && Number.isFinite(assetTotal) && assetTotal > 0;
    if (hasAssets) {
      return this.t("siyuanShare.progress.uploadedAssetsBytes", {
        current: Math.min(assetTotal, Math.max(0, Math.floor(assetDone))),
        total: Math.max(1, Math.floor(assetTotal)),
        bytesCurrent: formatBytes(uploaded),
        bytesTotal: formatBytes(total),
      });
    }
    return this.t("siyuanShare.progress.uploadedBytes", {
      current: formatBytes(uploaded),
      total: formatBytes(total),
    });
  }

  getUploadPercent(tracker) {
    if (!tracker) return null;
    const hasAssets = Number.isFinite(tracker.totalAssets) && tracker.totalAssets > 0;
    const hasBytes = Number.isFinite(tracker.totalBytes) && tracker.totalBytes > 0;
    const assetPercent = hasAssets ? (tracker.completedAssets / tracker.totalAssets) * 100 : 0;
    const bytePercent = hasBytes ? (tracker.uploadedBytes / tracker.totalBytes) * 100 : 0;
    if (hasBytes) {
      let percent = bytePercent;
      if (hasAssets && tracker.completedAssets < tracker.totalAssets && percent >= 100) {
        percent = 99;
      }
      return percent;
    }
    if (hasAssets) return assetPercent;
    return null;
  }

  async uploadAssetsChunked(uploadId, entries, controller, progress, totalBytes = 0) {
    const t = this.t.bind(this);
        if (!uploadId) {
          throw new Error(t("siyuanShare.error.missingUploadId"));
        }
    if (!Array.isArray(entries) || entries.length === 0) return;
    const total = entries.length;
    const baseLabel = t("siyuanShare.progress.uploadingContent");
    const {asset: assetMax, chunk: chunkMax} = this.getUploadConcurrency();
    const sortedEntries = entries
      .slice()
      .sort((a, b) => (Number(b?.asset?.blob?.size) || 0) - (Number(a?.asset?.blob?.size) || 0));
    const sizes = sortedEntries.map((entry) => Number(entry?.asset?.blob?.size) || 0);
    const assetConcurrency = this.getAdaptiveAssetConcurrency(totalBytes, entries.length, assetMax, sizes);
    let fatalError = null;
    const tracker = {
      totalBytes: Number.isFinite(totalBytes) ? totalBytes : 0,
      uploadedBytes: 0,
      totalAssets: total,
      completedAssets: 0,
      label: baseLabel,
      started: false,
    };
    const reportProgress = () => {
      if (!progress?.update) return;
      if (tracker.totalBytes > 0) {
        const percent = this.getUploadPercent(tracker);
        progress.update({
          text: baseLabel,
          percent,
          detail: this.formatUploadDetail(
            tracker.uploadedBytes,
            tracker.totalBytes,
            tracker.completedAssets,
            tracker.totalAssets,
          ),
        });
      } else {
        const percent = this.getUploadPercent(tracker);
        progress.update({text: baseLabel, percent});
      }
    };
    const tasks = sortedEntries.map((entry) => async () => {
      const assetEntry = entry || {};
      const asset = assetEntry.asset || assetEntry;
      const docId = assetEntry.docId || "";
      try {
        if (!tracker.started) {
          tracker.started = true;
          reportProgress();
        }
        await this.uploadAssetInChunks(uploadId, asset, docId, controller, progress, tracker, baseLabel, chunkMax);
        tracker.completedAssets += 1;
        reportProgress();
      } catch (err) {
        if (!fatalError && !isAbortError(err)) {
          fatalError = err;
        }
        if (controller && !controller.signal?.aborted) {
          try {
            controller.abort();
          } catch {
            // ignore
          }
        }
        throw err;
      }
    });
    try {
      await runTasksWithConcurrency(tasks, assetConcurrency);
    } catch (err) {
      if (fatalError && isAbortError(err)) {
        throw fatalError;
      }
      throw err;
    }
    reportProgress();
  }

  async uploadAssetInChunks(
    uploadId,
    asset,
    docId,
    controller,
    progress,
    tracker,
    label,
    chunkMaxConcurrency,
  ) {
    const t = this.t.bind(this);
    const blob = asset?.blob;
    const assetPath = asset?.path;
    if (!blob || !assetPath) return;
    const size = Number(blob.size) || 0;
    const chunkSize = this.getAdaptiveChunkSize(size);
    const totalChunks = Math.max(1, Math.ceil(size / chunkSize));
    const concurrency = this.getAdaptiveChunkConcurrency(size, chunkSize, chunkMaxConcurrency);
    const uploadChunk = async (index) => {
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const start = index * chunkSize;
      const end = Math.min(size, start + chunkSize);
      const chunk = blob.slice(start, end);
      const form = new FormData();
      form.append("uploadId", String(uploadId));
      form.append("assetPath", assetPath);
      if (docId) form.append("assetDocId", String(docId));
      form.append("chunkIndex", String(index));
      form.append("totalChunks", String(totalChunks));
      form.append("totalSize", String(size));
      form.append("chunk", chunk, assetPath);
      const startedAt = nowTs();
      try {
        await withRetry(
          () =>
            this.remoteRequest(REMOTE_API.shareAssetChunk, {
              method: "POST",
              body: form,
              isForm: true,
              controller,
              progress,
            }),
          {
            retries: UPLOAD_RETRY_LIMIT,
            baseDelay: UPLOAD_RETRY_BASE_DELAY,
            maxDelay: UPLOAD_RETRY_MAX_DELAY,
            controller,
          },
        );
      } catch (err) {
        throw err;
      }
      const elapsed = nowTs() - startedAt;
      this.updateUploadSpeed(end - start, elapsed);
      if (tracker && tracker.totalBytes > 0) {
        tracker.uploadedBytes += end - start;
        const percent = this.getUploadPercent(tracker);
        progress?.update?.({
          text: label || tracker.label,
          percent,
          detail: this.formatUploadDetail(
            tracker.uploadedBytes,
            tracker.totalBytes,
            tracker.completedAssets,
            tracker.totalAssets,
          ),
        });
      }
    };
    if (totalChunks === 1) {
      await uploadChunk(0);
      return;
    }
    const lastChunkIndex = totalChunks - 1;
    const tasks = [];
    for (let index = 0; index < lastChunkIndex; index += 1) {
      tasks.push(() => uploadChunk(index));
    }
    await runTasksWithConcurrency(tasks, concurrency);
    await uploadChunk(lastChunkIndex);
  }


  async shareDoc(
    docId,
    {
      slugOverride = "",
      password = "",
      clearPassword = false,
      expiresAt = null,
      clearExpires = false,
      visitorLimit = null,
      clearVisitorLimit = false,
      allowRequestError = true,
    } = {},
  ) {
    const t = this.t.bind(this);
    if (!isValidDocId(docId)) throw new Error(t("siyuanShare.error.invalidDocId"));
    const controller = new AbortController();
    const progress = this.openProgressDialog(t("siyuanShare.progress.creatingShare"), controller);
    try {
      progress.update(t("siyuanShare.progress.verifyingSite"));
      await this.verifyRemote({controller, progress});
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      progress.update(t("siyuanShare.progress.fetchingDocInfo"));
      const info = await this.resolveDocInfoFromAnyId(docId);
      const title = info?.title || t("siyuanShare.label.untitled");
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      progress.update(t("siyuanShare.progress.exportingMarkdown"));
      const exportRes = await this.exportDocMarkdown(docId);
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      progress.update(t("siyuanShare.progress.preparingAssets"));
      const {markdown, assets, failures} = await this.prepareMarkdownAssets(
        exportRes.content || "",
        controller,
      );
      if (failures.length > 0) {
        this.notify(t("siyuanShare.message.resourcesSkipped", {count: failures.length}));
      }
      const payload = {
        docId,
        title,
        hPath: exportRes.hPath || "",
        markdown,
        sortOrder: 0,
      };
      const slug = sanitizeSlug(slugOverride);
      if (slug) payload.slug = slug;
      if (clearPassword) {
        payload.clearPassword = true;
      } else if (password) {
        payload.password = password;
      }
      if (clearExpires) {
        payload.clearExpires = true;
      } else if (Number.isFinite(expiresAt) && expiresAt > 0) {
        payload.expiresAt = expiresAt;
      }
      if (clearVisitorLimit) {
        payload.clearVisitorLimit = true;
      } else if (Number.isFinite(visitorLimit)) {
        payload.visitorLimit = Math.max(0, Math.floor(visitorLimit));
      }
      const seenAssets = new Set();
      const assetEntries = [];
      const assetManifest = [];
      for (const asset of assets) {
        const assetPath = asset?.path || "";
        if (!assetPath || seenAssets.has(assetPath)) continue;
        seenAssets.add(assetPath);
        assetEntries.push({asset, docId});
        assetManifest.push({
          path: assetPath,
          size: Number(asset?.blob?.size) || 0,
          docId,
        });
      }
      progress.update(t("siyuanShare.progress.uploadingContent"));
      let requestError = null;
      let uploadId = "";
      let uploadComplete = false;
      try {
        const init = await this.remoteRequest(REMOTE_API.shareDocInit, {
          method: "POST",
          body: {metadata: payload, assets: assetManifest},
          progressText: t("siyuanShare.progress.uploadingContent"),
          controller,
          progress,
        });
        uploadId = init?.uploadId;
        if (!uploadId) {
          throw new Error(t("siyuanShare.error.missingUploadId"));
        }
        const totalBytes = assetEntries.reduce(
          (sum, entry) => sum + (Number(entry.asset?.blob?.size) || 0),
          0,
        );
        await this.uploadAssetsChunked(uploadId, assetEntries, controller, progress, totalBytes);
        await this.remoteRequest(REMOTE_API.shareUploadComplete, {
          method: "POST",
          body: {uploadId},
          progressText: t("siyuanShare.progress.uploadingContent"),
          progress,
        });
        uploadComplete = true;
      } catch (err) {
        requestError = err;
        if (uploadId && !uploadComplete) {
          try {
            await this.remoteRequest(REMOTE_API.shareUploadCancel, {
              method: "POST",
              body: {uploadId},
              progress,
            });
          } catch (cancelErr) {
            console.warn("shareDoc cancel upload failed", cancelErr);
          }
        }
      }
      progress.update(t("siyuanShare.progress.syncingShareList"));
      let syncError = null;
      try {
        await this.syncRemoteShares({silent: true, controller, progress});
      } catch (err) {
        syncError = err;
      }
      if (requestError && !allowRequestError) throw requestError;
      const share = this.getShareByDocId(docId);
      if (!share) {
        if (requestError) throw requestError;
        if (syncError) throw syncError;
        throw new Error(t("siyuanShare.error.shareCreateFailed"));
      }
      if (requestError) {
        console.warn("shareDoc response error, but share exists after sync", requestError);
      }
      const url = this.getShareUrl(share);
      this.renderSettingCurrent();
      this.refreshDocTreeMarksLater();
      this.notify(t("siyuanShare.message.shareCreated", {value: url || title}));
      if (url) await this.tryCopyToClipboard(url);
    } finally {
      progress?.close();
    }
  }

  async shareNotebook(
    notebookId,
    {
      slugOverride = "",
      password = "",
      clearPassword = false,
      expiresAt = null,
      clearExpires = false,
      visitorLimit = null,
      clearVisitorLimit = false,
      allowRequestError = true,
    } = {},
  ) {
    const t = this.t.bind(this);
    if (!isValidNotebookId(notebookId)) throw new Error(t("siyuanShare.error.invalidNotebookId"));
    const controller = new AbortController();
    const progress = this.openProgressDialog(t("siyuanShare.progress.creatingNotebookShare"), controller);
    try {
      progress.update(t("siyuanShare.progress.verifyingSite"));
      await this.verifyRemote({controller, progress});
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      if (!this.notebooks.length) {
        progress.update(t("siyuanShare.progress.fetchingNotebookList"));
        await this.refreshNotebookOptions({silent: true});
      }
      const notebook = this.notebooks.find((n) => n.id === notebookId);
      const tree = await this.listDocsInNotebook(notebookId);
      const docs = Array.isArray(tree?.docs) ? tree.docs : Array.isArray(tree) ? tree : [];
      const title = notebook?.name || tree?.title || notebookId;
      progress.update(t("siyuanShare.progress.preparingNotebook"));
      if (!docs.length) throw new Error(t("siyuanShare.error.noDocsToShare"));
      const docPayloads = [];
      const assetMap = new Map();
      let failureCount = 0;
      for (const [index, doc] of docs.entries()) {
        throwIfAborted(controller, t("siyuanShare.message.cancelled"));
        progress.update(
          t("siyuanShare.progress.exportingDoc", {index: index + 1, total: docs.length}),
        );
        const exportRes = await this.exportDocMarkdown(doc.docId);
        throwIfAborted(controller, t("siyuanShare.message.cancelled"));
        progress.update(
          t("siyuanShare.progress.preparingAssetsIndex", {index: index + 1, total: docs.length}),
        );
        const {markdown, assets, failures} = await this.prepareMarkdownAssets(
          exportRes.content || "",
          controller,
        );
        failureCount += failures.length;
        docPayloads.push({
          docId: doc.docId,
          title: doc.title || t("siyuanShare.label.untitled"),
          hPath: exportRes.hPath || "",
          markdown,
          parentId: doc.parentId || "",
          sortIndex: Number.isFinite(doc.sortIndex) ? doc.sortIndex : index,
          sortOrder: Number.isFinite(doc.sortOrder) ? doc.sortOrder : index,
        });
        for (const asset of assets) {
          if (!assetMap.has(asset.path)) {
            assetMap.set(asset.path, {asset, docId: doc.docId});
          }
        }
      }
      if (failureCount > 0) {
        this.notify(t("siyuanShare.message.docsExportSkipped", {count: failureCount}));
      }
      const payload = {
        notebookId,
        title,
        docs: docPayloads,
      };
      const slug = sanitizeSlug(slugOverride);
      if (slug) payload.slug = slug;
      if (clearPassword) {
        payload.clearPassword = true;
      } else if (password) {
        payload.password = password;
      }
      if (clearExpires) {
        payload.clearExpires = true;
      } else if (Number.isFinite(expiresAt) && expiresAt > 0) {
        payload.expiresAt = expiresAt;
      }
      if (clearVisitorLimit) {
        payload.clearVisitorLimit = true;
      } else if (Number.isFinite(visitorLimit)) {
        payload.visitorLimit = Math.max(0, Math.floor(visitorLimit));
      }
      const assetEntries = Array.from(assetMap.values());
      const assetManifest = assetEntries.map(({asset, docId}) => ({
        path: asset.path,
        size: Number(asset?.blob?.size) || 0,
        docId,
      }));
      progress.update(t("siyuanShare.progress.uploadingContent"));
      let requestError = null;
      let uploadId = "";
      let uploadComplete = false;
      try {
        const init = await this.remoteRequest(REMOTE_API.shareNotebookInit, {
          method: "POST",
          body: {metadata: payload, assets: assetManifest},
          progressText: t("siyuanShare.progress.uploadingContent"),
          controller,
          progress,
        });
        uploadId = init?.uploadId;
        if (!uploadId) {
          throw new Error(t("siyuanShare.error.missingUploadId"));
        }
        const totalBytes = assetEntries.reduce(
          (sum, entry) => sum + (Number(entry.asset?.blob?.size) || 0),
          0,
        );
        await this.uploadAssetsChunked(uploadId, assetEntries, controller, progress, totalBytes);
        await this.remoteRequest(REMOTE_API.shareUploadComplete, {
          method: "POST",
          body: {uploadId},
          progressText: t("siyuanShare.progress.uploadingContent"),
          progress,
        });
        uploadComplete = true;
      } catch (err) {
        requestError = err;
        if (uploadId && !uploadComplete) {
          try {
            await this.remoteRequest(REMOTE_API.shareUploadCancel, {
              method: "POST",
              body: {uploadId},
              progress,
            });
          } catch (cancelErr) {
            console.warn("shareNotebook cancel upload failed", cancelErr);
          }
        }
      }
      progress.update(t("siyuanShare.progress.syncingShareList"));
      let syncError = null;
      try {
        await this.syncRemoteShares({silent: true, controller, progress});
      } catch (err) {
        syncError = err;
      }
      if (requestError && !allowRequestError) throw requestError;
      const share = this.getShareByNotebookId(notebookId);
      if (!share) {
        if (requestError) throw requestError;
        if (syncError) throw syncError;
        throw new Error(t("siyuanShare.error.shareCreateFailed"));
      }
      if (requestError) {
        console.warn("shareNotebook response error, but share exists after sync", requestError);
      }
      const url = this.getShareUrl(share);
      this.refreshDocTreeMarksLater();
      this.notify(t("siyuanShare.message.shareCreated", {value: url || title}));
      if (url) await this.tryCopyToClipboard(url);
    } finally {
      progress?.close();
    }
  }

  async listDocsInNotebook(notebookId) {
    if (!isValidNotebookId(notebookId)) return {docs: [], title: ""};
    const t = this.t.bind(this);
    try {
      const treeResp = await fetchSyncPost("/api/filetree/getDocTree", {id: notebookId});
      if (treeResp && treeResp.code === 0) {
        const treeTitle =
          treeResp?.data?.name ||
          treeResp?.data?.root?.name ||
          treeResp?.data?.box?.name ||
          "";
        const nodes = extractDocTreeNodes(treeResp.data);
        const flat = flattenDocTree(nodes);
        if (flat.length) {
          return {
            title: String(treeTitle || "").trim(),
            docs: flat.map((doc, index) => ({
              docId: String(doc.docId || "").trim(),
              title: doc.title || t("siyuanShare.label.untitled"),
              parentId: String(doc.parentId || "").trim(),
              sortIndex: Number.isFinite(doc.sortIndex) ? doc.sortIndex : index,
              sortOrder: index,
            })),
          };
        }
      }
    } catch (err) {
      console.warn("Doc tree API failed", err);
    }

    try {
      const resp = await fetchSyncPost("/api/query/sql", {
        stmt: `SELECT id, parent_id, content, sort FROM blocks WHERE type='d' AND box='${notebookId}' ORDER BY sort`,
      });
      if (resp && resp.code === 0) {
        const rows = Array.isArray(resp?.data) ? resp.data : [];
        const nodes = new Map();
        rows.forEach((row, index) => {
          const docId = String(row.id || "").trim();
          if (!isValidDocId(docId)) return;
          const parentId = String(row.parent_id || row.parentId || "").trim();
          const sortRaw = Number(row.sort);
          const sortIndex = Number.isFinite(sortRaw) ? sortRaw : index;
          nodes.set(docId, {
            docId,
            title: typeof row.content === "string" ? row.content : "",
            parentId,
            sortIndex,
          });
        });
        if (nodes.size) {
          const children = new Map();
          const pushChild = (parentId, node) => {
            const key = parentId || "";
            if (!children.has(key)) children.set(key, []);
            children.get(key).push(node);
          };
          nodes.forEach((node) => {
            const parentKey = node.parentId || "";
            pushChild(parentKey, node);
          });
          const orderChildren = (list) => {
            list.sort((a, b) => {
              if (a.sortIndex === b.sortIndex) return a.docId.localeCompare(b.docId);
              return a.sortIndex - b.sortIndex;
            });
          };
          const roots = [];
          nodes.forEach((node) => {
            if (!node.parentId || !nodes.has(node.parentId) || node.parentId === notebookId) {
              roots.push(node);
            }
          });
          orderChildren(roots);
          const flat = [];
          const walk = (node) => {
            flat.push(node);
            const kids = children.get(node.docId) || [];
            orderChildren(kids);
            kids.forEach(walk);
          };
          roots.forEach(walk);
          return {
            title: "",
            docs: flat.map((node, index) => ({
              docId: node.docId,
              title: node.title,
              parentId: node.parentId,
              sortIndex: node.sortIndex,
              sortOrder: index,
            })),
          };
        }
      }
    } catch (err) {
      console.warn("SQL query failed", err);
    }

    return {docs: [], title: ""};
  }

  async updateShare(
    shareId,
    {
      password = "",
      clearPassword = false,
      expiresAt = null,
      clearExpires = false,
      visitorLimit = null,
      clearVisitorLimit = false,
    } = {},
  ) {
    const t = this.t.bind(this);
    if (!shareId) throw new Error(t("siyuanShare.error.missingShareId"));
    const existing = this.getShareById(shareId);
    if (!existing) throw new Error(t("siyuanShare.error.shareNotFound"));
    if (existing.type === SHARE_TYPES.NOTEBOOK) {
      await this.shareNotebook(existing.notebookId, {
        slugOverride: existing.slug,
        password,
        clearPassword,
        expiresAt,
        clearExpires,
        visitorLimit,
        clearVisitorLimit,
        allowRequestError: false,
      });
      return;
    }
    await this.shareDoc(existing.docId, {
      slugOverride: existing.slug,
      password,
      clearPassword,
      expiresAt,
      clearExpires,
      visitorLimit,
      clearVisitorLimit,
      allowRequestError: false,
    });
  }

  async updateShareAccess(
    shareId,
    {
      password = "",
      clearPassword = false,
      expiresAt = null,
      clearExpires = false,
      visitorLimit = null,
      clearVisitorLimit = false,
    } = {},
  ) {
    const t = this.t.bind(this);
    if (!shareId) throw new Error(t("siyuanShare.error.missingShareId"));
    const existing = this.getShareById(shareId);
    if (!existing) throw new Error(t("siyuanShare.error.shareNotFound"));
    const controller = new AbortController();
    const progress = this.openProgressDialog(t("siyuanShare.progress.requesting"), controller);
    try {
      progress.update(t("siyuanShare.progress.verifyingSite"));
      await this.verifyRemote({controller, progress});
      throwIfAborted(controller, t("siyuanShare.message.cancelled"));
      const payload = {shareId: existing.id};
      if (clearPassword) {
        payload.clearPassword = true;
      } else if (password) {
        payload.password = password;
      }
      if (clearExpires) {
        payload.clearExpires = true;
      } else if (Number.isFinite(expiresAt) && expiresAt > 0) {
        payload.expiresAt = expiresAt;
      }
      if (clearVisitorLimit) {
        payload.clearVisitorLimit = true;
      } else if (Number.isFinite(visitorLimit)) {
        payload.visitorLimit = Math.max(0, Math.floor(visitorLimit));
      }
      progress.update(t("siyuanShare.progress.requesting"));
      await this.remoteRequest(REMOTE_API.shareAccessUpdate, {
        method: "POST",
        body: payload,
        progressText: t("siyuanShare.progress.requesting"),
        controller,
        progress,
      });
      progress.update(t("siyuanShare.progress.syncingShareList"));
      await this.syncRemoteShares({silent: true, controller, progress});
      this.renderSettingCurrent();
      this.notify(t("siyuanShare.message.accessUpdated"));
    } finally {
      progress?.close();
    }
  }

  async deleteShare(shareId) {
    const t = this.t.bind(this);
    if (!shareId) throw new Error(t("siyuanShare.error.missingShareId"));
    const existing = this.getShareById(shareId);
    if (!existing) throw new Error(t("siyuanShare.error.shareNotFound"));

    await new Promise((resolve) => {
      confirm(
        t("siyuanShare.confirm.deleteShareTitle"),
        t("siyuanShare.confirm.deleteShareMessage", {
          name: existing.title || existing.slug || existing.id,
        }),
        () => resolve(true),
        () => resolve(false),
      );
    }).then(async (ok) => {
      if (!ok) return;
      await this.verifyRemote();
      await this.remoteRequest(REMOTE_API.deleteShare, {
        method: "POST",
        body: {shareId: existing.id, hardDelete: true},
        progressText: t("siyuanShare.progress.deletingShare"),
      });
      await this.syncRemoteShares({silent: true});
      this.renderSettingCurrent();
      this.notify(t("siyuanShare.message.deleteSuccess"));
    });
  }

  async copyShareLink(shareId) {
    const t = this.t.bind(this);
    const existing = this.getShareById(shareId);
    if (!existing) throw new Error(t("siyuanShare.error.shareNotFound"));
    await this.verifyRemote();
    const url = this.getShareUrl(existing);
    if (!url) throw new Error(t("siyuanShare.error.shareLinkEmpty"));
    await this.tryCopyToClipboard(url);
    this.notify(t("siyuanShare.message.copyLinkSuccess"));
  }

  async tryCopyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  }

  formatTime(ts) {
    if (!ts) return "";
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return String(ts);
    }
  }

  getRemoteHeaders() {
    const key = String(this.settings.apiKey || "").trim();
    if (!key) return {};
    return {"X-Api-Key": key};
  }

  async remoteRequest(
    path,
    {method = "POST", body, isForm = false, progressText = "", controller = null, progress = null} = {},
  ) {
    const t = this.t.bind(this);
    const base = normalizeUrlBase(this.settings.siteUrl);
    if (!base) throw new Error(t("siyuanShare.error.siteUrlRequired"));
    const headers = {...this.getRemoteHeaders()};
    if (!headers["X-Api-Key"]) throw new Error(t("siyuanShare.error.apiKeyRequired"));
    if (!isForm && method !== "GET") {
      headers["Content-Type"] = "application/json";
    }
    const options = {
      method,
      headers,
    };
    if (body != null && method !== "GET") {
      options.body = isForm ? body : JSON.stringify(body);
    }
    const requestController = controller || new AbortController();
    options.signal = requestController.signal;
    const ownsProgress = !progress;
    const handle =
      progress || this.openProgressDialog(progressText || t("siyuanShare.progress.requesting"), requestController);
    if (progressText && handle?.update) {
      handle.update(progressText);
    }
    try {
      const resp = await fetch(`${base}${path}`, options);
      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json || json.code !== 0) {
        throw new Error(json?.msg || t("siyuanShare.error.remoteRequestFailed", {status: resp.status}));
      }
      return json.data;
    } catch (err) {
      if (err?.name === "AbortError") {
        throw new Error(t("siyuanShare.message.cancelled"));
      }
      throw err;
    } finally {
      if (ownsProgress) {
        handle?.close();
      }
    }
  }

  async verifyRemote({silent = false, controller = null, progress = null} = {}) {
    const t = this.t.bind(this);
    if (!this.settings.siteUrl || !this.settings.apiKey) {
      if (!silent) throw new Error(t("siyuanShare.error.siteAndKeyRequired"));
      return null;
    }
    if (this.remoteUser && this.remoteVerifiedAt && nowTs() - this.remoteVerifiedAt < 60000) {
      return {user: this.remoteUser};
    }
    const data = await this.remoteRequest(REMOTE_API.verify, {
      method: "POST",
      body: {},
      progressText: t("siyuanShare.progress.verifyingSite"),
      controller,
      progress,
    });
    this.remoteUser = data?.user || null;
    this.remoteUploadLimits = this.normalizeUploadLimits(data?.limits);
    this.remoteVerifiedAt = nowTs();
    this.syncSettingInputs();
    return data;
  }

  async syncRemoteShares({silent = false, controller = null, progress = null} = {}) {
    const t = this.t.bind(this);
    const data = await this.remoteRequest(REMOTE_API.shares, {
      method: "GET",
      progressText: t("siyuanShare.progress.syncingShareList"),
      controller,
      progress,
    });
    const shares = Array.isArray(data?.shares) ? data.shares : [];
    this.shares = shares;
    if (this.settings.activeSiteId) {
      this.siteShares[this.settings.activeSiteId] = shares;
      await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
    }
    this.renderDock();
    this.renderSettingCurrent();
    this.renderSettingShares();
    this.refreshDocTreeMarks();
    this.updateTopBarState();
    if (!silent) this.notify(t("siyuanShare.message.verifySuccess"));
    return shares;
  }

  async trySyncRemoteShares({silent = false} = {}) {
    if (!this.settings.siteUrl || !this.settings.apiKey) return;
    try {
      await this.verifyRemote({silent: true});
      await this.syncRemoteShares({silent});
    } catch (err) {
      if (!silent) this.showErr(err);
    }
  }

  async disconnectRemote() {
    const t = this.t.bind(this);
    const activeSiteId = String(this.settings.activeSiteId || "");
    this.remoteUser = null;
    this.remoteVerifiedAt = 0;
    this.remoteUploadLimits = null;
    this.shares = [];
    if (activeSiteId) {
      this.siteShares[activeSiteId] = [];
      await this.saveData(STORAGE_SITE_SHARES, this.siteShares);
    }
    this.syncSettingInputs();
    this.renderDock();
    this.renderSettingCurrent();
    this.renderSettingShares();
    this.updateTopBarState();
    this.notify(t("siyuanShare.message.disconnected"));
  }

  async fetchNotebooks() {
    const resp = await fetchSyncPost("/api/notebook/lsNotebooks", {});
    if (!resp || resp.code !== 0) throw new Error(resp?.msg || this.t("siyuanShare.error.notebookListFailed"));
    return resp?.data?.notebooks || [];
  }

  async refreshNotebookOptions({silent = false} = {}) {
    const t = this.t.bind(this);
    try {
      this.notebooks = await this.fetchNotebooks();
      if (!silent) this.notify(t("siyuanShare.message.notebookListRefreshed"));
    } catch (err) {
      if (!silent) this.showErr(err);
    }
  }

  async exportDocMarkdown(docId) {
    const resp = await fetchSyncPost("/api/export/exportMdContent", {id: docId});
    if (!resp || resp.code !== 0) throw new Error(resp?.msg || this.t("siyuanShare.error.exportMarkdownFailed"));
    return {
      hPath: resp?.data?.hPath || "",
      content: resp?.data?.content || "",
    };
  }

  async fetchAssetBlob(assetPath, controller) {
    const t = this.t.bind(this);
    const normalized = normalizeAssetPath(assetPath);
    if (!normalized) throw new Error(t("siyuanShare.error.resourcePathInvalid"));
    const candidates = [normalized];
    const decoded = tryDecodeAssetPath(normalized);
    if (decoded) {
      const decodedNormalized = normalizeAssetPath(decoded);
      if (decodedNormalized && decodedNormalized !== normalized) {
        candidates.push(decodedNormalized);
      }
    }
    let lastErr = null;
    for (const candidate of candidates) {
      let workspacePath = candidate;
      if (!workspacePath.startsWith("data/")) {
        if (workspacePath.startsWith("assets/")) {
          workspacePath = `data/${workspacePath}`;
        } else {
          workspacePath = `data/${workspacePath}`;
        }
      }
      let resp;
      try {
        resp = await fetch("/api/file/getFile", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...getAuthHeaders(),
          },
          body: JSON.stringify({path: `/${workspacePath}`}),
          signal: controller?.signal,
        });
      } catch (err) {
        if (err?.name === "AbortError") {
          throw new Error(t("siyuanShare.error.resourceDownloadCanceled"));
        }
        lastErr = err;
        continue;
      }
      if (!resp.ok) {
        const err = await resp.json().catch(() => null);
        lastErr = new Error(err?.msg || t("siyuanShare.error.resourceDownloadFailed", {status: resp.status}));
        continue;
      }
      const contentType = resp.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const data = await resp.clone().json().catch(() => null);
        if (data && typeof data.code !== "undefined" && data.code !== 0) {
          lastErr = new Error(data?.msg || t("siyuanShare.error.resourceDownloadFailed", {status: resp.status}));
          continue;
        }
      }
      const blob = await resp.blob();
      return {path: normalized, blob};
    }
    throw lastErr || new Error(t("siyuanShare.error.resourceDownloadFailed", {status: 500}));
  }

  async prepareMarkdownAssets(markdown, controller) {
    const t = this.t.bind(this);
    const cancelledMsg = t("siyuanShare.error.resourceDownloadCanceled");
    let fixed = rewriteAssetLinks(markdown || "");
    const assetPaths = extractAssetPaths(fixed);
    const assets = [];
    const failures = [];
    const renameMap = new Map();
    const usedUploadPaths = new Set();
    for (const path of assetPaths) {
      try {
        throwIfAborted(controller, t("siyuanShare.message.cancelled"));
        const uploadPath = sanitizeAssetUploadPath(path, usedUploadPaths) || normalizeAssetPath(path);
        if (uploadPath && uploadPath !== path) {
          renameMap.set(path, uploadPath);
        }
        const asset = await this.fetchAssetBlob(path, controller);
        assets.push({path: uploadPath || asset.path, blob: asset.blob});
      } catch (err) {
        if (err?.message === cancelledMsg) {
          throw err;
        }
        failures.push({path, err});
      }
    }
    if (renameMap.size > 0) {
      for (const [from, to] of renameMap) {
        fixed = replaceAllText(fixed, from, to);
      }
    }
    if (failures.length > 0) {
      console.warn("Some assets failed to download.", failures);
    }
    return {markdown: fixed, assets, failures};
  }

  renderDock() {
    if (!this.dockElement) return;
    const t = this.t.bind(this);
    const siteUrl = this.settings.siteUrl || "";
    const apiKey = this.settings.apiKey || "";
    const sites = Array.isArray(this.settings.sites) ? this.settings.sites : [];
    const activeSiteId = String(this.settings.activeSiteId || "");
    const siteOptions = sites
      .map((site, index) => {
        const id = String(site?.id || "");
        const label = this.getSiteOptionLabel(site, index);
        const selected = id && id === activeSiteId ? " selected" : "";
        return `<option value="${escapeAttr(id)}"${selected}>${escapeHtml(label)}</option>`;
      })
      .join("");
    const statusLabel = !siteUrl || !apiKey
      ? t("siyuanShare.hint.needSiteAndKey")
      : this.remoteUser?.username
        ? t("siyuanShare.hint.statusConnectedUser", {
            user: escapeHtml(this.remoteUser.username),
          })
        : t("siyuanShare.hint.statusConnectedNoUser");
    const rows = this.shares
      .map((s) => {
        const url = this.getShareUrl(s);
        const typeLabel =
          s.type === SHARE_TYPES.NOTEBOOK ? t("siyuanShare.label.notebook") : t("siyuanShare.label.document");
        const idLabel = s.type === SHARE_TYPES.NOTEBOOK ? s.notebookId : s.docId;
        const visitorLimitValue = Number(s.visitorLimit) || 0;
        const visitorLabel =
          visitorLimitValue > 0
            ? t("siyuanShare.label.visitorLimitCount", {count: visitorLimitValue})
            : t("siyuanShare.label.visitorLimitNotSet");
        return `<tr>
  <td>
    <div>${escapeHtml(s.title || "")}</div>
    <div class="siyuan-plugin-share__muted siyuan-plugin-share__mono">${escapeHtml(idLabel || "")}</div>
  </td>
  <td class="siyuan-plugin-share__mono">${escapeHtml(typeLabel)}</td>
  <td>
    <div class="siyuan-plugin-share__mono">${escapeHtml(url)}</div>
    <div class="siyuan-plugin-share__muted">${escapeHtml(visitorLabel)}</div>
    <div class="siyuan-plugin-share__muted">${escapeHtml(this.formatTime(s.updatedAt))}</div>
  </td>
  <td>
    <div class="siyuan-plugin-share__actions">
      <button class="b3-button b3-button--outline" data-action="copy-link" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.copyLink"))}</button>
      <button class="b3-button b3-button--outline" data-action="update" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.update"))}</button>
      <button class="b3-button b3-button--outline" data-action="update-access" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.updateAccess"))}</button>
      <button class="b3-button b3-button--outline" data-action="delete" data-share-id="${escapeAttr(
          s.id,
        )}">${escapeHtml(t("siyuanShare.action.delete"))}</button>
    </div>
  </td>
</tr>`;
      })
      .join("");

    this.dockElement.innerHTML = `
<div class="siyuan-plugin-share__section">
  <div class="siyuan-plugin-share__title">${escapeHtml(t("siyuanShare.section.connectionSettings"))}</div>
  <div class="siyuan-plugin-share__grid">
    <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.site"))}</div>
    <select id="sps-site-select" class="b3-select sps-site-select">
      ${siteOptions || `<option value="">${escapeHtml(t("siyuanShare.label.siteEmpty"))}</option>`}
    </select>
    <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.siteUrl"))}</div>
    <input id="sps-site" class="b3-text-field" placeholder="${escapeAttr(
      t("siyuanShare.placeholder.siteUrl"),
    )}" value="${escapeAttr(siteUrl)}" />
    <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.apiKey"))}</div>
    <input id="sps-apikey" type="password" class="b3-text-field" placeholder="${escapeAttr(
      t("siyuanShare.label.apiKey"),
    )}" value="${escapeAttr(apiKey)}" />
  </div>
  <div class="siyuan-plugin-share__actions">
    <button class="b3-button b3-button--outline" data-action="sync-remote">${escapeHtml(
      t("siyuanShare.action.verifySync"),
    )}</button>
    <button class="b3-button b3-button--outline" data-action="disconnect">${escapeHtml(
      t("siyuanShare.action.disconnect"),
    )}</button>
  </div>
  <div class="siyuan-plugin-share__muted">${statusLabel}</div>
  <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.hint.checkApiKey"))}</div>
</div>

<div class="siyuan-plugin-share__section">
  <div class="siyuan-plugin-share__title">${escapeHtml(
    t("siyuanShare.title.shareListCount", {count: this.shares.length}),
  )}</div>
  <table class="siyuan-plugin-share__table">
    <thead>
      <tr>
        <th style="width: 34%;">${escapeHtml(t("siyuanShare.label.title"))}</th>
        <th style="width: 14%;">${escapeHtml(t("siyuanShare.label.type"))}</th>
        <th style="width: 36%;">${escapeHtml(t("siyuanShare.label.link"))}</th>
        <th style="width: 16%;">${escapeHtml(t("siyuanShare.label.actions"))}</th>
      </tr>
    </thead>
    <tbody>
      ${rows || `<tr><td colspan="4" class="siyuan-plugin-share__muted">${escapeHtml(
          t("siyuanShare.message.noShareRecords"),
        )}</td></tr>`}
    </tbody>
  </table>
</div>
`;
    try {
      this.dockElement.removeEventListener("click", this.onDockClick);
      this.dockElement.removeEventListener("change", this.onDockChange);
      this.dockElement.addEventListener("click", this.onDockClick);
      this.dockElement.addEventListener("change", this.onDockChange);
    } catch {
      // ignore
    }
  }
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/`/g, "&#96;");
}

module.exports = SiYuanSharePlugin;
module.exports.default = SiYuanSharePlugin;
