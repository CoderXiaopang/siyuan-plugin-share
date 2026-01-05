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
const DOCK_TYPE = "siyuan-plugin-share-dock";
const ASSET_CHUNK_SIZE = 5 * 1024 * 1024;

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
  if (!Number.isFinite(value) || value <= 0) return "0 KB";
  const kb = value / 1024;
  if (kb < 1024) {
    return `${kb < 10 ? kb.toFixed(1) : kb.toFixed(0)} KB`;
  }
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : mb.toFixed(0)} MB`;
}

function throwIfAborted(controller, message) {
  if (controller?.signal?.aborted) {
    throw new Error(message || "Operation cancelled.");
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
    };
    this.shares = [];
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

  clearDocTreeMarks() {
    const scope = this.docTreeContainer && this.docTreeContainer.isConnected ? this.docTreeContainer : document;
    scope.querySelectorAll(`.${TREE_SHARE_CLASS}`).forEach((el) => el.remove());
    scope.querySelectorAll(`.${TREE_SHARED_CLASS}`).forEach((el) => {
      el.classList.remove(TREE_SHARED_CLASS);
    });
  }

  refreshDocTreeMarks() {
    if (this.docTreeContainer && !this.docTreeContainer.isConnected) {
      this.detachDocTree();
      this.bindDocTreeLater();
    }
    const scope = this.docTreeContainer && this.docTreeContainer.isConnected ? this.docTreeContainer : document;
    let items = scope.querySelectorAll(".b3-list-item");
    if (!items.length) {
      items = scope.querySelectorAll("[data-type^='navigation'], [data-type*='navigation'], [data-type='notebook']");
    }
    items.forEach((rawItem) => {
      const item = rawItem.classList?.contains("b3-list-item") ? rawItem : rawItem.closest?.(".b3-list-item") || rawItem;
      if (!isProbablyDocTreeItem(item)) return;
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

    const share =
      itemType === SHARE_TYPES.NOTEBOOK ? this.getShareByNotebookId(itemId) : this.getShareByDocId(itemId);
    const url = share ? this.getShareUrl(share) : "";
    const typeLabel =
      itemType === SHARE_TYPES.NOTEBOOK ? t("siyuanShare.label.notebook") : t("siyuanShare.label.document");
    const hasPassword = !!share?.hasPassword;
    const expiresAt = normalizeTimestampMs(share?.expiresAt || 0);
    const expiresInputValue = expiresAt ? toDateTimeLocalInput(expiresAt) : "";
    const currentPasswordLabel = hasPassword
      ? t("siyuanShare.label.passwordSet")
      : t("siyuanShare.label.passwordNotSet");
    const currentExpiresLabel = expiresAt ? this.formatTime(expiresAt) : t("siyuanShare.label.expiresNotSet");
    const passwordKeepToken = "__KEEP__";
    const passwordInputValue = share && hasPassword ? passwordKeepToken : "";
    const passwordPlaceholder = share
      ? (hasPassword ? t("siyuanShare.hint.passwordKeep") : t("siyuanShare.label.passwordNotSet"))
      : t("siyuanShare.hint.passwordOptional");



    const content = `<div class="siyuan-plugin-share sps-dialog-body">
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
    </div>
    <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.hint.keepOrClear"))}</div>
    <div class="siyuan-plugin-share__muted">${escapeHtml(
      currentPasswordLabel,
    )} · ${escapeHtml(currentExpiresLabel)}</div>
  </div>
  <div class="siyuan-plugin-share__section">
    <div class="siyuan-plugin-share__title">${escapeHtml(t("siyuanShare.section.shareLink"))}</div>
    ${
      share
        ? `<div class="siyuan-plugin-share__muted">${escapeHtml(
            t("siyuanShare.label.shareId"),
          )}：<span class="siyuan-plugin-share__mono">${escapeHtml(share.slug || "")}</span></div>
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

    const readShareOptions = (root) => {
      const passwordInput = root?.querySelector?.("#sps-share-password");
      const expiresInput = root?.querySelector?.("#sps-share-expires");
      const passwordRaw = (passwordInput?.value || "").trim();
      const expiresAt = parseDateTimeLocalInput(expiresInput?.value || "");
      const hasExistingPassword = !!share?.hasPassword;
      const hasExistingExpires = normalizeTimestampMs(share?.expiresAt || 0) > 0;
      const password = passwordRaw === passwordKeepToken ? "" : passwordRaw;
      return {
        password,
        clearPassword: !!share && hasExistingPassword && passwordRaw === "",
        expiresAt,
        clearExpires: !!share && hasExistingExpires && !expiresAt,
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
            const options = readShareOptions(dialog.element);
            await this.updateShare(shareId, options);
            dialog.destroy();
            return;
          }
          if (action === "delete") {
            const shareId = btn.getAttribute("data-share-id");
            await this.deleteShare(shareId);
            dialog.destroy();
            return;
          }
          if (action === "share") {
            const options = readShareOptions(dialog.element);
            if (itemType === SHARE_TYPES.NOTEBOOK) {
              await this.shareNotebook(itemId, options);
            } else {
              await this.shareDoc(itemId, options);
            }
            dialog.destroy();
          }
        } catch (err) {
          this.showErr(err);
        }
      })();
    };

    const dialog = new Dialog({
      title: t("siyuanShare.title.shareManagement"),
      content,
      width: "min(720px, 92vw)",
      destroyCallback: () => {
        dialog.element.removeEventListener("click", onClick);
      },
    });

    dialog.element.addEventListener("click", onClick);

    const input = dialog.element.querySelector("input.b3-text-field[readonly]");
    if (input) {
      input.addEventListener("focus", () => input.select());
    }
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
    const shares = (await this.loadData(STORAGE_SHARES)) || [];
    this.settings = {
      siteUrl: settings.siteUrl || "",
      apiKey: settings.apiKey || "",
    };
    this.shares = Array.isArray(shares)
      ? shares.filter((s) => s && s.id && s.type)
      : [];
    this.hasNodeFs = !!(fs && path);
    this.workspaceDir = "";
    this.syncSettingInputs();
    this.renderSettingShares();
    this.renderDock();
    this.updateTopBarState();
    void this.refreshCurrentDocContext();
  }

  initSettingPanel() {
    const t = this.t.bind(this);
    const siteInput = document.createElement("input");
    siteInput.className = "b3-text-field fn__block";
    siteInput.placeholder = "https://example.com";

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
      currentWrap,
      sharesWrap,
      envHint,
    };

    this.setting = new Setting({
      width: "92vw",
      height: "80vh",
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

  syncSettingInputs() {
    const {siteInput, apiKeyInput, envHint} = this.settingEls || {};
    if (siteInput) siteInput.value = this.settings.siteUrl || "";
    if (apiKeyInput) apiKeyInput.value = this.settings.apiKey || "";
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

  saveSettingsFromSetting = async ({notify = true} = {}) => {
    const t = this.t.bind(this);
    const {siteInput, apiKeyInput} = this.settingEls;
    const next = {
      siteUrl: (siteInput?.value || "").trim(),
      apiKey: (apiKeyInput?.value || "").trim(),
    };
    this.settings = next;
    await this.saveData(STORAGE_SETTINGS, next);
    if (!next.siteUrl || !next.apiKey) {
      this.shares = [];
      await this.saveData(STORAGE_SHARES, this.shares);
    }
    this.remoteUser = null;
    this.remoteVerifiedAt = 0;
    this.renderDock();
    this.renderSettingShares();
    this.syncSettingInputs();
    if (notify) this.notify(t("siyuanShare.message.disconnected"));
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
        )}：<span class="siyuan-plugin-share__mono">${escapeHtml(
          share.slug || "",
        )}</span> · ${escapeHtml(t("siyuanShare.label.updatedAt"))}：${escapeHtml(
          this.formatTime(share.updatedAt),
        )}</div>
  <div class="siyuan-plugin-share__muted">${escapeHtml(passwordLabel)} · ${escapeHtml(expiresLabel)}</div>
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
        )} · ${escapeHtml(expiresLabel)}</span>
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
    const next = {
      siteUrl: this.getInputValue("sps-site").trim(),
      apiKey: this.getInputValue("sps-apikey").trim(),
    };
    this.settings = next;
    await this.saveData(STORAGE_SETTINGS, next);
    if (!next.siteUrl || !next.apiKey) {
      this.shares = [];
      await this.saveData(STORAGE_SHARES, this.shares);
    }
    this.remoteUser = null;
    this.remoteVerifiedAt = 0;
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

  formatUploadDetail(uploaded, total) {
    return this.t("siyuanShare.progress.uploadedBytes", {
      current: formatBytes(uploaded),
      total: formatBytes(total),
    });
  }

  async uploadAssetsChunked(uploadId, entries, controller, progress, totalBytes = 0) {
    const t = this.t.bind(this);
    if (!uploadId) {
      throw new Error(t("siyuanShare.error.remoteRequestFailed", {status: "missing upload id"}));
    }
    if (!Array.isArray(entries) || entries.length === 0) return;
    const total = entries.length;
    const baseLabel = t("siyuanShare.progress.uploadingContent");
    const tracker =
      Number.isFinite(totalBytes) && totalBytes > 0
        ? {totalBytes, uploadedBytes: 0, label: baseLabel}
        : null;
    for (let index = 0; index < total; index += 1) {
      const entry = entries[index] || {};
      const asset = entry.asset || entry;
      const docId = entry.docId || "";
      const suffix = total > 1 ? ` (${index + 1}/${total})` : "";
      const label = baseLabel + suffix;
      if (tracker) {
        if (tracker.uploadedBytes === 0 && index === 0) {
          progress?.update?.({
            text: label,
            percent: 0,
            detail: this.formatUploadDetail(0, tracker.totalBytes),
          });
        }
      } else {
        progress?.update?.(label);
      }
      await this.uploadAssetInChunks(uploadId, asset, docId, controller, progress, tracker, label);
    }
    if (tracker) {
      progress?.update?.({
        text: baseLabel,
        percent: 100,
        detail: this.formatUploadDetail(tracker.totalBytes, tracker.totalBytes),
      });
    }
  }

  async uploadAssetInChunks(uploadId, asset, docId, controller, progress, tracker, label) {
    const t = this.t.bind(this);
    const blob = asset?.blob;
    const assetPath = asset?.path;
    if (!blob || !assetPath) return;
    const size = Number(blob.size) || 0;
    const chunkSize = ASSET_CHUNK_SIZE;
    const totalChunks = Math.max(1, Math.ceil(size / chunkSize));
    for (let index = 0; index < totalChunks; index += 1) {
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
      await this.remoteRequest(REMOTE_API.shareAssetChunk, {
        method: "POST",
        body: form,
        isForm: true,
        controller,
        progress,
      });
      if (tracker && tracker.totalBytes > 0) {
        tracker.uploadedBytes += end - start;
        const percent = (tracker.uploadedBytes / tracker.totalBytes) * 100;
        progress?.update?.({
          text: label || tracker.label,
          percent,
          detail: this.formatUploadDetail(tracker.uploadedBytes, tracker.totalBytes),
        });
      }
    }
  }


  async shareDoc(
    docId,
    {
      slugOverride = "",
      password = "",
      clearPassword = false,
      expiresAt = null,
      clearExpires = false,
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
          throw new Error(t("siyuanShare.error.remoteRequestFailed", {status: "missing upload id"}));
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
          throw new Error(t("siyuanShare.error.remoteRequestFailed", {status: "missing upload id"}));
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
    {password = "", clearPassword = false, expiresAt = null, clearExpires = false} = {},
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
      allowRequestError: false,
    });
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
    await this.saveData(STORAGE_SHARES, shares);
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
    this.settings = {siteUrl: "", apiKey: ""};
    this.remoteUser = null;
    this.remoteVerifiedAt = 0;
    this.shares = [];
    await this.saveData(STORAGE_SETTINGS, this.settings);
    await this.saveData(STORAGE_SHARES, this.shares);
    this.syncSettingInputs();
    this.renderDock();
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
    let workspacePath = normalized;
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
      throw err;
    }
    if (!resp.ok) {
      const err = await resp.json().catch(() => null);
      throw new Error(err?.msg || t("siyuanShare.error.resourceDownloadFailed", {status: resp.status}));
    }
    const blob = await resp.blob();
    return {path: normalized, blob};
  }

  async prepareMarkdownAssets(markdown, controller) {
    const t = this.t.bind(this);
    const cancelledMsg = t("siyuanShare.error.resourceDownloadCanceled");
    const fixed = rewriteAssetLinks(markdown || "");
    const assetPaths = extractAssetPaths(fixed);
    const assets = [];
    const failures = [];
    for (const path of assetPaths) {
      try {
        throwIfAborted(controller, t("siyuanShare.message.cancelled"));
        assets.push(await this.fetchAssetBlob(path, controller));
      } catch (err) {
        if (err?.message === cancelledMsg) {
          throw err;
        }
        failures.push({path, err});
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
        return `<tr>
  <td>
    <div>${escapeHtml(s.title || "")}</div>
    <div class="siyuan-plugin-share__muted siyuan-plugin-share__mono">${escapeHtml(idLabel || "")}</div>
  </td>
  <td class="siyuan-plugin-share__mono">${escapeHtml(typeLabel)}</td>
  <td>
    <div class="siyuan-plugin-share__mono">${escapeHtml(url)}</div>
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
    <div class="siyuan-plugin-share__muted">${escapeHtml(t("siyuanShare.label.siteUrl"))}</div>
    <input id="sps-site" class="b3-text-field" placeholder="https://example.com" value="${escapeAttr(
      siteUrl,
    )}" />
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
