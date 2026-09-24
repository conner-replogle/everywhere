package browser

import (
	"encoding/json"
	"fmt"

	"github.com/conner-replogle/everywhere/daemon/internal/protocol"
)

// elementJS defines, in the page, helpers for describing elements:
//   - __ewDescribe(el): a protocol.BrowserElement
//   - __ewSelector(el): a CSS selector that finds el
//   - __ewDeepAt(x, y): the element at a point, looking inside shadow roots
//
// It runs in the page, so a hostile page can lie through it; that's fine for
// pages the user is developing and pointing at.
const elementJS = `(() => {
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
})()`

// evalJSON evaluates expr (after installing elementJS) and decodes its
// JSON-serializable result into out.
func (t *Tab) evalJSON(expr string, out any) error {
	var r struct {
		Result struct {
			Value json.RawMessage `json:"value"`
		} `json:"result"`
		ExceptionDetails *struct {
			Text      string `json:"text"`
			Exception struct {
				Description string `json:"description"`
			} `json:"exception"`
		} `json:"exceptionDetails"`
	}
	err := t.call("Runtime.evaluate", map[string]any{
		"expression":    elementJS + ";\n" + expr,
		"returnByValue": true,
		"awaitPromise":  true,
	}, &r)
	if err != nil {
		return err
	}
	if e := r.ExceptionDetails; e != nil {
		msg := e.Exception.Description
		if msg == "" {
			msg = e.Text
		}
		return fmt.Errorf("page script failed: %s", msg)
	}
	if out == nil || len(r.Result.Value) == 0 {
		return nil
	}
	return json.Unmarshal(r.Result.Value, out)
}

// elementAt describes the element at x/y in CSS pixels of the viewport, or
// returns nil if there's none.
func (t *Tab) elementAt(x, y float64) (*protocol.BrowserElement, error) {
	var el *protocol.BrowserElement
	err := t.evalJSON(fmt.Sprintf(`(() => { const el = __ewDeepAt(%g, %g); return el ? __ewDescribe(el) : null; })()`, x, y), &el)
	return el, err
}
