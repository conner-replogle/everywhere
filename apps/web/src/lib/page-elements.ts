// The same helpers the device browser's annotations use to describe an
// element (daemon/internal/browser/pick.go, elementJS; keep the two alike),
// for running in a web tab's page:
//   - __ewDescribe(el): a BrowserElement
//   - __ewDeepAt(x, y): the element at a point, looking inside shadow roots
// They run in the page, so a page can lie through them; that's fine for
// pages the user points at.

export const ELEMENT_JS = String.raw`(() => {
  if (window.__ewDescribe) return;
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, "\\$&"));
  const unique = (sel, root) => { try { return root.querySelectorAll(sel).length === 1; } catch { return false; } };
  const selector = (el) => {
    const root = el.getRootNode();
    const doc = root.querySelectorAll ? root : document;
    const parts = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (e.id) {
        const s = "#" + esc(e.id);
        if (unique(s, doc)) { parts.unshift(s); break; }
      }
      for (const a of ["data-testid", "data-test", "data-cy"]) {
        const v = e.getAttribute(a);
        if (v) {
          const s = e.tagName.toLowerCase() + "[" + a + '="' + v.replace(/"/g, '\\"') + '"]';
          if (unique(s, doc)) { parts.unshift(s); return parts.join(" > "); }
        }
      }
      let s = e.tagName.toLowerCase();
      const p = e.parentElement;
      if (p) {
        const same = [...p.children].filter((c) => c.tagName === e.tagName);
        if (same.length > 1) s += ":nth-of-type(" + (same.indexOf(e) + 1) + ")";
      }
      parts.unshift(s);
      if (unique(parts.join(" > "), doc)) break;
    }
    return parts.join(" > ");
  };
  const implicitRole = (el) => {
    const t = el.tagName;
    if (t === "BUTTON" || (t === "INPUT" && /^(button|submit|reset)$/.test(el.type))) return "button";
    if (t === "A" && el.hasAttribute("href")) return "link";
    if (t === "INPUT" && el.type === "checkbox") return "checkbox";
    if (t === "INPUT" && el.type === "radio") return "radio";
    if (t === "INPUT" || t === "TEXTAREA") return "textbox";
    if (t === "SELECT") return "combobox";
    if (t === "IMG") return "img";
    if (/^H[1-6]$/.test(t)) return "heading";
    if (t === "NAV") return "navigation";
    if (t === "MAIN") return "main";
    if (t === "DIALOG") return "dialog";
    if (t === "LI") return "listitem";
    if (t === "UL" || t === "OL") return "list";
    return "";
  };
  const clip = (s, n) => { s = (s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; };
  const react = (el) => {
    let key = null;
    for (let e = el; e && !key; e = e.parentElement) {
      key = Object.keys(e).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
      if (key) el = e;
    }
    if (!key) return {};
    const names = [];
    let source = "";
    for (let f = el[key]; f && names.length < 5; f = f.return) {
      const t = f.type;
      if (!t || typeof t === "string") continue;
      const n = t.displayName || t.name || (t.render && (t.render.displayName || t.render.name));
      if (!n || /^(Fragment|Suspense|Provider|Consumer)$/.test(n)) continue;
      names.push(n);
      const src = f._debugSource;
      if (!source && src && src.fileName) source = src.fileName + ":" + src.lineNumber;
    }
    return { component: names.join(" < "), source };
  };
  const STYLES = ["display", "position", "color", "background-color", "font-family", "font-size", "font-weight",
    "line-height", "padding", "margin", "border", "border-radius", "gap", "opacity"];
  window.__ewSelector = selector;
  window.__ewDeepAt = (x, y) => {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };
  window.__ewDescribe = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const styles = {};
    for (const k of STYLES) { const v = cs.getPropertyValue(k); if (v && v !== "none" && v !== "normal" && v !== "0px") styles[k] = v; }
    const attrs = {};
    for (const a of [...el.attributes].slice(0, 12)) {
      if (a.name === "class" || a.name === "style" || a.name === "id") continue;
      attrs[a.name] = clip(a.value, 120);
    }
    const text = clip(el.innerText ?? el.textContent, 200);
    const name = clip(el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title") ||
      el.getAttribute("placeholder") || (el.labels && el.labels[0] && el.labels[0].innerText) || text, 80);
    const { component, source } = react(el);
    return {
      tag: el.tagName.toLowerCase(), id: el.id || undefined,
      classes: typeof el.className === "string" && el.className ? el.className.trim().split(/\s+/).slice(0, 12) : undefined,
      selector: selector(el), role: el.getAttribute("role") || implicitRole(el) || undefined, name: name || undefined,
      text: text || undefined, attrs: Object.keys(attrs).length ? attrs : undefined,
      component: component || undefined, source: source || undefined, styles,
      x: r.x, y: r.y, width: r.width, height: r.height,
    };
  };
})()`;
