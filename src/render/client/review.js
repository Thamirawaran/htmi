/*
 * HTMi review client. Runs inside the generated review page.
 *
 * It selects targets by their identity (data-doc-target in rendered diagrams,
 * data-hm-key with this build's nonce in authored HTML), never by screen
 * position; shows threads and pins; and lets a reviewer write a comment. In
 * live mode the comment is saved through the local HTMi server; in an editor
 * host (VS Code) through the host's message channel. In snapshot mode (for
 * example a GitHub issue artifact) nothing can be sent: the page prepares a
 * GitHub comment for the reviewer to paste, and keeps the draft marked as not
 * sent. Untrusted text is only ever set with textContent.
 */
(function () {
  "use strict";

  // Elements are found by tag and class, never by id alone: authored content keeps its ids,
  // and an id such as "hm-data" in a document must not be able to stand in for the page's own.
  var data = JSON.parse(document.querySelector('script[type="application/json"].hm-data').textContent);
  var isHtml = data.format === "html";
  var nonce = data.nonce;
  var XHTML = "http://www.w3.org/1999/xhtml";
  var hostApi = data.host && typeof window.acquireVsCodeApi === "function" ? window.acquireVsCodeApi() : null;
  /* True when a comment can be saved from this page (live server, or an editor host with a saved file). */
  var live = data.mode === "live" || !!(hostApi && data.host.canSave);
  /* Shown by the browser extension on github.com: prepared comments go to GitHub's comment box. */
  var handoff = data.handoff;
  /* Embedded in a host page's own layout (GitHub's file view or a description): the panel is a card. */
  var embed = !!(handoff && handoff.embed);
  var panel = document.querySelector("aside.hm-panel");
  var pinsLayer = document.querySelector("div.hm-pins");
  var docEl = document.querySelector("main.hm-doc");
  var liveRegion = document.querySelector("div.hm-live");
  var banner = document.querySelector("div.hm-banner");

  var state = {
    threads: data.threads,
    selected: null,
    tab: "open",
    quoteRanges: {},
    stale: false,
    /* A confirmation to show once in the next composer, since saving re-renders the panel. */
    notice: null,
  };

  var KIND_NAMES = {
    diagram: "Diagram",
    node: "Component",
    edge: "Connection",
    group: "Group",
    text: "Text",
    image: "Image",
    element: "Element",
    region: "Region",
  };
  var BLOCK_NAMES = {
    heading: "Heading",
    paragraph: "Paragraph",
    list: "List",
    "definition-list": "Definitions",
    table: "Table",
    code: "Code",
    figure: "Figure",
    image: "Image",
    quote: "Quote",
    svg: "Graphic",
    math: "Math",
    container: "Block",
    element: "Element",
  };
  var COMMENT_KINDS = [
    ["comment", "Comment"],
    ["question", "Question"],
    ["change-request", "Change request"],
  ];
  var TARGET_NOTES = {
    changed: "target changed",
    heuristic: "target uncertain",
    ambiguous: "target ambiguous",
    orphaned: "target gone",
    unverified: "target unverified",
    "snapshot-only": "spatial note",
  };

  /* ---------- small helpers ---------- */

  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "text") el.textContent = v;
        else if (k === "onclick") el.addEventListener("click", v);
        else el.setAttribute(k, v === true ? "" : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var child = arguments[i];
      if (child === null || child === undefined || child === false) continue;
      el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return el;
  }

  function announce(message) {
    liveRegion.textContent = "";
    window.setTimeout(function () {
      liveRegion.textContent = message;
    }, 30);
  }

  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  }

  var storage = {
    get: function (key) {
      try {
        var raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return null;
      }
    },
    set: function (key, value) {
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        return false;
      }
    },
    remove: function (key) {
      try {
        window.localStorage.removeItem(key);
      } catch (e) {
        /* storage unavailable: nothing to remove */
      }
    },
  };

  var CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  function randomId(prefix) {
    var bytes = new Uint8Array(6);
    window.crypto.getRandomValues(bytes);
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += CROCKFORD[bytes[i] % 32];
    return prefix + "-" + out;
  }

  /* SHA-256 of a UTF-8 string, in plain JS so it works where crypto.subtle is unavailable. */
  function sha256Hex(text) {
    var bytes = new TextEncoder().encode(text);
    var K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
      0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
      0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
      0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
      0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
      0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
      0xc67178f2,
    ];
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var len = bytes.length;
    var padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(bytes);
    padded[len] = 0x80;
    var bitLen = len * 8;
    var view = new DataView(padded.buffer);
    view.setUint32(padded.length - 4, bitLen >>> 0);
    view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
    var w = new Uint32Array(64);
    for (var off = 0; off < padded.length; off += 64) {
      for (var t = 0; t < 16; t++) w[t] = view.getUint32(off + t * 4);
      for (t = 16; t < 64; t++) {
        var x = w[t - 15];
        var y = w[t - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
      }
      var a = H[0],
        b = H[1],
        c = H[2],
        d = H[3],
        e = H[4],
        f = H[5],
        g = H[6],
        hh = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K[t] + w[t]) >>> 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;
        hh = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0;
      H[1] = (H[1] + b) >>> 0;
      H[2] = (H[2] + c) >>> 0;
      H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0;
      H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0;
      H[7] = (H[7] + hh) >>> 0;
    }
    return H.map(function (v) {
      return ("00000000" + v.toString(16)).slice(-8);
    }).join("");
  }

  /* ---------- targets ---------- */

  function keyOf(ref) {
    if (ref.kind === "diagram") return "diagram:" + ref.targetId;
    if (ref.kind === "text") return ref.targetId;
    return ref.diagramId ? ref.diagramId + "/" + ref.targetId : ref.targetId;
  }

  function refForKey(key) {
    var t = data.targets[key];
    if (!t) return null;
    return {
      documentId: data.document.id,
      documentPath: data.document.path,
      kind: t.kind,
      diagramId: t.diagramId || undefined,
      targetId: t.id,
      label: t.label,
      from: t.from || undefined,
      to: t.to || undefined,
      tag: t.tag || undefined,
    };
  }

  function refForDiagram(id) {
    return {
      documentId: data.document.id,
      documentPath: data.document.path,
      kind: "diagram",
      targetId: id,
      label: "Diagram " + id,
    };
  }

  function observedFor(ref) {
    var observed = {
      revision: data.document.revision.label,
      commit: data.document.revision.commit,
      documentDigest: data.document.digest,
    };
    if (ref.kind === "diagram") observed.targetDigest = data.diagrams[ref.targetId].digest;
    else if (ref.kind !== "text") {
      var t = data.targets[keyOf(ref)];
      if (t) observed.targetDigest = t.digest;
    }
    return observed;
  }

  function describe(ref) {
    if (ref.kind === "text" && ref.selector) {
      var q = ref.selector.exact;
      return '"' + (q.length > 90 ? q.slice(0, 87) + "..." : q) + '"';
    }
    if (ref.kind === "edge" && ref.from && ref.to) {
      var from = data.targets[ref.diagramId + "/" + ref.from];
      var to = data.targets[ref.diagramId + "/" + ref.to];
      return (from ? from.label : ref.from) + " \u2192 " + (to ? to.label : ref.to);
    }
    if (isRegion(ref)) return (ref.label || ref.targetId) + ", marked region";
    return ref.label || ref.targetId;
  }

  function isRegion(ref) {
    return !!(ref && ref.selector && ref.selector.type === "ImageRegionSelector");
  }

  /* Must stay in step with describeRegion in src/core/annotations.ts. */
  function regionWords(sel) {
    function pct(v) {
      return Math.round(v * 100) + "%";
    }
    return (
      "from " +
      pct(sel.x) +
      " to " +
      pct(sel.x + sel.w) +
      " across, " +
      pct(sel.y) +
      " to " +
      pct(sel.y + sel.h) +
      " down"
    );
  }

  function hmKeySelector(key) {
    return '[data-hm-key="' + cssEscape(nonce + ":" + key) + '"]';
  }

  function elementsFor(ref) {
    if (isHtml) {
      if (ref.kind === "text") return [];
      var hk = ref.kind === "diagram" ? "diagram:" + ref.targetId : keyOf(ref);
      return Array.prototype.slice.call(document.querySelectorAll(hmKeySelector(hk)));
    }
    if (ref.kind === "diagram") {
      return Array.prototype.slice.call(
        document.querySelectorAll('figure[data-doc-diagram="' + cssEscape(ref.targetId) + '"]'),
      );
    }
    if (ref.kind === "text") return [];
    return Array.prototype.slice.call(document.querySelectorAll('[data-doc-key="' + cssEscape(keyOf(ref)) + '"]'));
  }

  function cssEscape(value) {
    return window.CSS && window.CSS.escape ? window.CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
  }

  function threadKey(thread) {
    if (thread.resolution.key) return thread.resolution.key;
    return keyOf(thread.target);
  }

  function threadsFor(ref) {
    var key = keyOf(ref);
    return state.threads.filter(function (t) {
      if (ref.kind === "text") return t.target.kind === "text" && t.target.targetId === ref.targetId;
      return threadKey(t) === key || keyOf(t.target) === key;
    });
  }

  /* ---------- selection ---------- */

  function clearMarks() {
    Array.prototype.forEach.call(document.querySelectorAll(".hm-selected"), function (el) {
      el.classList.remove("hm-selected");
    });
    if (window.CSS && CSS.highlights) CSS.highlights.delete("hm-quote-selected");
  }

  function select(ref, options) {
    options = options || {};
    state.selected = ref;
    clearMarks();
    var els = elementsFor(ref);
    els.forEach(function (el) {
      el.classList.add("hm-selected");
    });
    if (ref.kind === "text" && options.range && window.CSS && CSS.highlights && window.Highlight) {
      CSS.highlights.set("hm-quote-selected", new Highlight(options.range));
    }
    if (options.scroll && els[0]) {
      els[0].scrollIntoView({ block: "center", behavior: "smooth" });
    } else if (options.scroll && options.range) {
      var node = options.range.startContainer.parentElement;
      if (node) node.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    if (options.flash && els[0]) {
      els[0].classList.remove("hm-flash");
      void els[0].getBoundingClientRect();
      els[0].classList.add("hm-flash");
    }
    renderPanel();
    if (embed)
      openCard(options.range ? options.range.getBoundingClientRect() : els[0] && els[0].getBoundingClientRect());
    announce("Selected " + (KIND_NAMES[ref.kind] || ref.kind).toLowerCase() + " " + describe(ref));
    if (hostApi && ref.kind !== "text") {
      hostApi.postMessage({
        type: "htmi:selected",
        key: ref.kind === "diagram" ? "diagram:" + ref.targetId : keyOf(ref),
      });
    }
  }

  function clearSelection() {
    state.selected = null;
    clearMarks();
    renderPanel();
    if (embed) closeCard();
  }

  /* ---------- embedded in a host page ---------- */

  /** Open the comment card beside what was selected (or at the top), inside the page's own height. */
  function openCard(rect) {
    var top = rect ? rect.top + window.scrollY - 8 : 8;
    panel.style.top = Math.max(8, Math.round(top)) + "px";
    document.body.classList.add("hm-panel-open");
    postHeight();
  }

  function closeCard() {
    document.body.classList.remove("hm-panel-open");
    postHeight();
  }

  /** The host sizes its frame to the page, so the page never scrolls inside the host's layout. */
  var lastHeight = 0;
  function postHeight() {
    if (!embed || window.parent === window) return;
    // The body is never stretched to the frame here, so its scroll height is the page's own height.
    var bottom = Math.max(
      document.body.scrollHeight,
      document.querySelector("div.hm-layout").getBoundingClientRect().bottom + window.scrollY,
    );
    if (document.body.classList.contains("hm-panel-open"))
      bottom = Math.max(bottom, panel.getBoundingClientRect().bottom + window.scrollY + 16);
    var height = Math.ceil(bottom);
    if (Math.abs(height - lastHeight) < 2) return;
    lastHeight = height;
    window.parent.postMessage({ type: "htmi:height", height: height }, "*");
  }

  if (embed) {
    window.addEventListener("message", function (event) {
      if (event.source !== window.parent || !event.data) return;
      if (event.data.type === "htmi:panel") {
        if (document.body.classList.contains("hm-panel-open") && !state.selected) closeCard();
        else {
          state.selected = null;
          clearMarks();
          renderPanel();
          openCard(null);
        }
      }
    });
    if (window.ResizeObserver) new ResizeObserver(postHeight).observe(document.body);
    window.addEventListener("load", postHeight);
  }

  document.addEventListener("click", function (event) {
    var path = event.composedPath ? event.composedPath() : [];
    for (var i = 0; i < path.length; i++) {
      var el = path[i];
      if (!el || !el.getAttribute) continue;
      if (el.classList && el.classList.contains("hm-pin")) return;
      if (isHtml) {
        var hk = el.getAttribute("data-hm-key");
        if (hk && hk.indexOf(nonce + ":") === 0) {
          // Releasing a text selection also clicks; that is a quote, not an element.
          var sel = window.getSelection();
          if (sel && !sel.isCollapsed) return;
          var k = hk.slice(nonce.length + 1);
          if (k.indexOf("diagram:") === 0) {
            select(refForDiagram(k.slice(8)), {});
            return;
          }
          if (data.targets[k]) {
            select(refForKey(k), {});
            return;
          }
        }
        // Authored links and controls keep working.
        if (
          el.closest &&
          el.closest(".hm-authored") &&
          el.matches("a[href], button, input, select, textarea, summary, label")
        )
          return;
      }
      var action = el.getAttribute("data-action");
      if (action === "comment-diagram") {
        select(refForDiagram(el.getAttribute("data-diagram")), {});
        return;
      }
      var key = el.getAttribute("data-doc-key");
      if (key && data.targets[key]) {
        select(refForKey(key), {});
        return;
      }
      if (el.classList && el.classList.contains("hm-diagram-bg")) {
        var svg = el.ownerSVGElement;
        select(refForDiagram(svg.getAttribute("data-doc-diagram")), {});
        return;
      }
      if (el === panel || el === document.body) break;
    }
  });

  document.addEventListener("keydown", function (event) {
    var el = event.target;
    if ((event.key === "Enter" || event.key === " ") && el && el.getAttribute && el.getAttribute("data-doc-key")) {
      event.preventDefault();
      select(refForKey(el.getAttribute("data-doc-key")), {});
    } else if (event.key === "Escape" && state.selected) {
      clearSelection();
    }
  });

  /* ---------- text selection and quotes ---------- */

  /** Visible text of a section body, with whitespace collapsed and a map back to DOM positions. */
  function textIndex(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        return n.parentElement && n.parentElement.closest("figure, script, style")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT;
      },
    });
    var text = "";
    var map = [];
    var lastSpace = true;
    var node;
    while ((node = walker.nextNode())) {
      var value = node.nodeValue;
      for (var i = 0; i < value.length; i++) {
        var space = /\s/.test(value[i]);
        if (space && lastSpace) continue;
        text += space ? " " : value[i];
        map.push([node, i]);
        lastSpace = space;
      }
    }
    return { text: text, map: map };
  }

  /** Position in the text index of the first visible character at or after a DOM boundary point. */
  function indexOfPosition(index, container, offset) {
    var point = document.createRange();
    point.setStart(container, offset);
    point.collapse(true);
    for (var i = 0; i < index.map.length; i++) {
      if (point.comparePoint(index.map[i][0], index.map[i][1]) >= 0) return i;
    }
    return index.map.length;
  }

  function rangeFor(index, start, end) {
    if (start >= index.map.length || end <= start) return null;
    var range = document.createRange();
    var a = index.map[start];
    var b = index.map[end - 1];
    range.setStart(a[0], a[1]);
    range.setEnd(b[0], b[1] + 1);
    return range;
  }

  /*
   * HTML documents are not wrapped per section, so the text of each section is
   * collected the way the model collects it: text nodes in document order,
   * a new section at each heading, nothing from headings, SVG or MathML.
   */
  var htmlIndexCache = null;
  function htmlIndexes() {
    if (htmlIndexCache) return htmlIndexCache;
    var out = {};
    var current = "_top";
    var root = docEl.querySelector(".hm-authored-body");
    function add(node) {
      var index = out[current] || (out[current] = { text: "", map: [], lastSpace: true });
      var value = node.nodeValue;
      for (var i = 0; i < value.length; i++) {
        var space = /\s/.test(value[i]);
        if (space && index.lastSpace) continue;
        index.text += space ? " " : value[i];
        index.map.push([node, i]);
        index.lastSpace = space;
      }
    }
    function walk(el) {
      for (var c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) add(c);
        else if (c.nodeType === 1 && c.namespaceURI === XHTML) {
          if (/^H[1-6]$/.test(c.tagName)) {
            var hs = c.getAttribute("data-hm-section");
            if (hs && hs.indexOf(nonce + ":") === 0) current = hs.slice(nonce.length + 1);
            continue;
          }
          walk(c);
        }
      }
    }
    if (root) walk(root);
    htmlIndexCache = out;
    return out;
  }

  /** Section of a point in the authored page: the last section heading before it. */
  function htmlSectionAt(node) {
    var heads = docEl.querySelectorAll('.hm-authored-body [data-hm-section^="' + cssEscape(nonce + ":") + '"]');
    var found = "_top";
    for (var i = 0; i < heads.length; i++) {
      if (heads[i] === node || heads[i].contains(node)) return null;
      if (heads[i].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
        found = heads[i].getAttribute("data-hm-section").slice(nonce.length + 1);
      }
    }
    return found;
  }

  function findQuote(sectionId, selector) {
    var index;
    if (isHtml) index = htmlIndexes()[sectionId];
    else {
      var body = document.querySelector('.hm-section-body[data-section-id="' + cssEscape(sectionId) + '"]');
      index = body ? textIndex(body) : null;
    }
    if (!index) return null;
    var exact = selector.exact.replace(/\s+/g, " ").trim();
    var prefix = (selector.prefix || "").replace(/\s+/g, " ").trim();
    var suffix = (selector.suffix || "").replace(/\s+/g, " ").trim();
    var hits = [];
    for (var i = index.text.indexOf(exact); i >= 0; i = index.text.indexOf(exact, i + 1)) hits.push(i);
    var withContext = hits.filter(function (i) {
      var before = index.text.slice(Math.max(0, i - prefix.length - 1), i).trim();
      var after = index.text.slice(i + exact.length, i + exact.length + suffix.length + 1).trim();
      return before.slice(-prefix.length) === prefix && after.slice(0, suffix.length) === suffix;
    });
    var at = withContext.length === 1 ? withContext[0] : hits.length === 1 ? hits[0] : -1;
    return at < 0 ? null : rangeFor(index, at, at + exact.length);
  }

  var selectionButton = h("button", {
    type: "button",
    class: "hm-btn hm-btn-small hm-selection-button",
    hidden: true,
    text: "Comment on selection",
  });
  docEl.appendChild(selectionButton);
  var pendingQuote = null;

  function captureSelection() {
    var sel = window.getSelection();
    selectionButton.hidden = true;
    pendingQuote = null;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    var range = sel.getRangeAt(0).cloneRange();
    var startEl = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    var index;
    var sectionId;
    if (isHtml) {
      var root = startEl && startEl.closest(".hm-authored-body");
      if (!root || startEl.closest("svg, math")) return;
      sectionId = htmlSectionAt(range.startContainer);
      if (sectionId === null) return;
      index = htmlIndexes()[sectionId];
      if (!index) return;
    } else {
      var body = startEl && startEl.closest(".hm-section-body");
      if (!body || startEl.closest("figure")) return;
      // Triple-click and drag selections often end just outside the section (at the next heading); keep the part inside.
      if (!body.contains(range.endContainer)) range.setEnd(body, body.childNodes.length);
      index = textIndex(body);
      sectionId = body.getAttribute("data-section-id");
    }
    var start = indexOfPosition(index, range.startContainer, range.startOffset);
    var end = indexOfPosition(index, range.endContainer, range.endOffset);
    var exact = index.text.slice(start, end).trim();
    if (!exact) return;
    var lead = index.text.slice(start, end).length - index.text.slice(start, end).replace(/^\s+/, "").length;
    start += lead;
    end = start + exact.length;
    pendingQuote = {
      sectionId: sectionId,
      exact: exact.slice(0, 2000),
      prefix: index.text.slice(Math.max(0, start - 32), start).trim(),
      suffix: index.text.slice(end, end + 32).trim(),
      range: rangeFor(index, start, end),
    };
    var rect = range.getBoundingClientRect();
    var host = docEl.getBoundingClientRect();
    selectionButton.style.left = rect.left + rect.width / 2 - host.left + "px";
    selectionButton.style.top = rect.top - host.top - 6 + "px";
    selectionButton.hidden = false;
  }

  document.addEventListener("mouseup", function (event) {
    if (event.target === selectionButton) return;
    window.setTimeout(captureSelection, 0);
  });
  document.addEventListener("keyup", function (event) {
    if (event.shiftKey || event.key === "Shift") captureSelection();
  });
  selectionButton.addEventListener("click", function () {
    if (!pendingQuote) return;
    var q = pendingQuote;
    selectionButton.hidden = true;
    select(
      {
        documentId: data.document.id,
        documentPath: data.document.path,
        kind: "text",
        targetId: "t." + q.sectionId,
        label: q.exact.slice(0, 120),
        selector: { type: "TextQuoteSelector", exact: q.exact, prefix: q.prefix, suffix: q.suffix },
      },
      { range: q.range },
    );
  });

  function highlightQuotes() {
    state.quoteRanges = {};
    var ranges = [];
    state.threads.forEach(function (t) {
      if (t.target.kind !== "text" || !t.target.selector) return;
      if (t.resolution.status !== "exact" && t.resolution.status !== "changed" && t.resolution.status !== "unverified")
        return;
      var range = findQuote(t.target.targetId.replace(/^t\./, ""), t.target.selector);
      if (range) {
        state.quoteRanges[t.id] = range;
        ranges.push(range);
      }
    });
    if (window.CSS && CSS.highlights && window.Highlight) {
      var highlight = new Highlight();
      ranges.forEach(function (r) {
        highlight.add(r);
      });
      CSS.highlights.set("hm-quotes", highlight);
    }
  }

  /* ---------- pins ---------- */

  var STATUS_RANK = { open: 0, acknowledged: 1, addressed: 2, wontfix: 3, resolved: 4 };

  function anchorPoint(el) {
    var host = docEl.getBoundingClientRect();
    if (el.hasAttribute("data-pin-x") && el.ownerSVGElement) {
      var svg = el.ownerSVGElement;
      var ctm = svg.getScreenCTM();
      if (ctm) {
        var p = svg.createSVGPoint();
        p.x = parseFloat(el.getAttribute("data-pin-x"));
        p.y = parseFloat(el.getAttribute("data-pin-y"));
        var s = p.matrixTransform(ctm);
        return { x: s.x - host.left, y: s.y - host.top };
      }
    }
    var r = el.getBoundingClientRect();
    if (el.tagName === "FIGURE") return { x: r.right - host.left - 16, y: r.top - host.top };
    return { x: r.right - host.left - 4, y: r.top - host.top + 4 };
  }

  function layoutPins() {
    pinsLayer.textContent = "";
    var groups = {};
    state.threads.forEach(function (t) {
      if (t.resolution.status !== "exact" && t.resolution.status !== "changed" && t.resolution.status !== "unverified")
        return;
      // Each marked region gets its own outline and pin; whole-image comments share one.
      var key = threadKey(t) + (isRegion(t.target) ? "|region|" + t.id : "");
      (groups[key] = groups[key] || []).push(t);
    });
    Object.keys(groups).forEach(function (key) {
      var threads = groups[key];
      var first = threads[0];
      var anchor = null;
      if (first.target.kind === "text") {
        var range = state.quoteRanges[first.id];
        if (range) {
          var r = range.getBoundingClientRect();
          var host = docEl.getBoundingClientRect();
          anchor = { x: r.left - host.left - 2, y: r.top - host.top };
        }
      } else if (isRegion(first.target)) {
        var box = regionBox(first);
        if (box) anchor = { x: box.x + box.w - 4, y: box.y + 4 };
      } else {
        var el = elementsFor(first.target)[0];
        if (el) anchor = anchorPoint(el);
      }
      if (!anchor) return;
      threads.sort(function (a, b) {
        return STATUS_RANK[a.discussion] - STATUS_RANK[b.discussion];
      });
      var worst = threads[0];
      var changed = threads.some(function (t) {
        return t.resolution.status === "changed" || t.resolution.status === "unverified";
      });
      var pin = h("button", {
        type: "button",
        class: "hm-pin",
        "data-status": worst.discussion,
        "data-target": changed ? "changed" : "exact",
        "data-thread": worst.id,
        "aria-label": threads.length + " comment" + (threads.length > 1 ? "s" : "") + " on " + describe(first.target),
        text: String(threads.length),
      });
      pin.style.left = anchor.x + "px";
      pin.style.top = anchor.y + "px";
      if (isRegion(first.target)) {
        var b = regionBox(first);
        var mark = h("div", { class: "hm-region-mark", "data-target": changed ? "changed" : "exact" });
        mark.style.left = b.x + "px";
        mark.style.top = b.y + "px";
        mark.style.width = b.w + "px";
        mark.style.height = b.h + "px";
        pinsLayer.appendChild(mark);
      }
      pin.addEventListener("click", function () {
        focusThread(worst);
      });
      pinsLayer.appendChild(pin);
    });
  }

  /* ---------- image regions ---------- */

  function imageOf(ref) {
    var el = elementsFor({
      documentId: ref.documentId,
      documentPath: ref.documentPath,
      kind: ref.kind,
      diagramId: ref.diagramId,
      targetId: ref.targetId,
    })[0];
    if (!el) return null;
    return el.tagName === "IMG" || el.tagName === "img" ? el : el.querySelector("img");
  }

  /** The rectangle of an image, relative to the document area that pins are placed in. */
  function imageRect(img) {
    var host = docEl.getBoundingClientRect();
    var r = img.getBoundingClientRect();
    return { x: r.left - host.left, y: r.top - host.top, w: r.width, h: r.height };
  }

  /** Where a thread's marked region is now drawn, or null when its image is not on the page. */
  function regionBox(thread) {
    var key = thread.resolution.key;
    var ref = key && data.targets[key] ? refForKey(key) : thread.target;
    var img = imageOf(ref);
    if (!img) return null;
    var r = imageRect(img);
    var sel = thread.target.selector;
    return { x: r.x + sel.x * r.w, y: r.y + sel.y * r.h, w: sel.w * r.w, h: sel.h * r.h };
  }

  var regionLayer = h("div", { class: "hm-region-layer" });
  docEl.appendChild(regionLayer);
  var drawing = null;

  function stopRegion() {
    regionLayer.textContent = "";
    drawing = null;
  }

  /**
   * Let the reviewer mark part of the selected image: drag with a pointer, or
   * move a rectangle with the arrow keys and resize it with Shift and the arrow
   * keys. Enter keeps it, Escape cancels. Coordinates are fractions of the
   * image as displayed, so they do not depend on the screen.
   */
  function startRegion(ref) {
    var img = imageOf(ref);
    if (!img) return;
    stopRegion();
    var r = imageRect(img);
    var sel =
      ref.selector && isRegion(ref)
        ? { x: ref.selector.x, y: ref.selector.y, w: ref.selector.w, h: ref.selector.h }
        : { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    var overlay = h("div", {
      class: "hm-region-draw",
      tabindex: "0",
      role: "group",
      "aria-label":
        "Mark a region of the image. Drag, or use the arrow keys to move and Shift with the arrow keys to resize. Enter keeps it, Escape cancels.",
    });
    var box = h("div", { class: "hm-region-box" });
    overlay.appendChild(box);
    overlay.style.left = r.x + "px";
    overlay.style.top = r.y + "px";
    overlay.style.width = r.w + "px";
    overlay.style.height = r.h + "px";
    regionLayer.appendChild(overlay);
    drawing = { ref: ref, sel: sel, overlay: overlay, box: box };
    function clamp(v) {
      return Math.max(0, Math.min(1, v));
    }
    function draw() {
      box.style.left = sel.x * 100 + "%";
      box.style.top = sel.y * 100 + "%";
      box.style.width = sel.w * 100 + "%";
      box.style.height = sel.h * 100 + "%";
    }
    function keep() {
      if (sel.w < 0.01 || sel.h < 0.01) {
        announce("The region is too small; drag a larger rectangle");
        return;
      }
      ref.selector = {
        type: "ImageRegionSelector",
        x: +sel.x.toFixed(4),
        y: +sel.y.toFixed(4),
        w: +sel.w.toFixed(4),
        h: +sel.h.toFixed(4),
      };
      stopRegion();
      select(ref, {});
      announce("Marked region " + regionWords(ref.selector));
    }
    function point(event) {
      var b = overlay.getBoundingClientRect();
      return { x: clamp((event.clientX - b.left) / b.width), y: clamp((event.clientY - b.top) / b.height) };
    }
    var start = null;
    overlay.addEventListener("pointerdown", function (event) {
      event.preventDefault();
      overlay.setPointerCapture(event.pointerId);
      start = point(event);
      sel = { x: start.x, y: start.y, w: 0, h: 0 };
      draw();
    });
    overlay.addEventListener("pointermove", function (event) {
      if (!start) return;
      var p = point(event);
      sel = {
        x: Math.min(start.x, p.x),
        y: Math.min(start.y, p.y),
        w: Math.abs(p.x - start.x),
        h: Math.abs(p.y - start.y),
      };
      draw();
    });
    overlay.addEventListener("pointerup", function () {
      if (!start) return;
      start = null;
      keep();
    });
    overlay.addEventListener("click", function (event) {
      event.stopPropagation();
    });
    overlay.addEventListener("keydown", function (event) {
      var step = 0.05;
      var dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
      var dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
      if (dx || dy) {
        event.preventDefault();
        if (event.shiftKey) {
          sel.w = clamp(Math.max(0.05, sel.w + dx));
          sel.h = clamp(Math.max(0.05, sel.h + dy));
          sel.w = Math.min(sel.w, 1 - sel.x);
          sel.h = Math.min(sel.h, 1 - sel.y);
        } else {
          sel.x = clamp(Math.min(sel.x + dx, 1 - sel.w));
          sel.y = clamp(Math.min(sel.y + dy, 1 - sel.h));
        }
        draw();
      } else if (event.key === "Enter") {
        event.preventDefault();
        keep();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        stopRegion();
        announce("Region not changed");
      }
    });
    draw();
    overlay.focus();
  }

  function focusThread(thread) {
    var range = state.quoteRanges[thread.id];
    if (thread.target.kind === "text") {
      select(thread.target, { scroll: true, range: range || null });
      return;
    }
    var key = thread.resolution.key;
    var ref = key && data.targets[key] ? refForKey(key) : thread.target;
    select(ref, { scroll: true, flash: true });
  }

  /* ---------- panel ---------- */

  function chip(kind, value, label) {
    var attrs = { class: "hm-chip", text: label || value };
    attrs["data-" + kind] = value;
    return h("span", attrs);
  }

  function threadCard(thread, options) {
    var card = h("article", { class: "hm-thread", "data-thread-id": thread.id });
    var head = h(
      "div",
      { class: "hm-thread-head" },
      h("strong", { text: thread.id }),
      chip("status", thread.discussion),
      thread.resolution.status !== "exact"
        ? chip("target", thread.resolution.status, TARGET_NOTES[thread.resolution.status])
        : null,
      h("span", {
        text:
          (thread.kind === "change-request" ? "change request" : thread.kind) +
          " by " +
          thread.author.name +
          (thread.author.verified ? "" : " (unverified)"),
      }),
      h("span", { text: when(thread.at) }),
    );
    card.appendChild(head);
    if (options.showTarget) {
      card.appendChild(
        h(
          "div",
          { class: "hm-thread-target" },
          (KIND_NAMES[thread.target.kind] || thread.target.kind) + ": ",
          h("button", {
            type: "button",
            class: "hm-link",
            text: describe(thread.target),
            onclick: function () {
              focusThread(thread);
            },
          }),
        ),
      );
    }
    card.appendChild(h("p", { class: "hm-thread-text", text: thread.text }));
    if (thread.resolution.status !== "exact")
      card.appendChild(h("p", { class: "hm-note", text: thread.resolution.note }));
    card.appendChild(
      h("p", {
        class: "hm-note",
        text:
          "Written against " +
          thread.observed.revision +
          (thread.visibility === "local" ? "; not shared outside this repository" : ""),
      }),
    );
    if (thread.resolution.candidates && thread.resolution.candidates.length) {
      var list = h("div", { class: "hm-note" }, "Possible targets, not chosen: ");
      thread.resolution.candidates.forEach(function (c, i) {
        if (i) list.appendChild(document.createTextNode(", "));
        if (live && data.targets[c.key]) {
          list.appendChild(
            h("button", {
              type: "button",
              class: "hm-btn hm-btn-small",
              text: "Reattach to " + c.label,
              onclick: function () {
                post("/api/reattach", { threadId: thread.id, key: c.key }, "Comment reattached to " + c.label);
              },
            }),
          );
        } else list.appendChild(h("span", { text: c.label }));
      });
      card.appendChild(list);
    }
    thread.replies.forEach(function (r) {
      card.appendChild(
        h(
          "div",
          { class: "hm-reply" },
          h("div", {
            class: "hm-thread-head",
            text:
              r.author.name +
              " (" +
              r.author.kind +
              ")" +
              ", " +
              when(r.at) +
              (r.revision ? ", revision " + r.revision : ""),
          }),
          h("p", { class: "hm-thread-text", text: r.text }),
        ),
      );
    });
    thread.statuses.forEach(function (s) {
      card.appendChild(
        h("div", {
          class: "hm-note",
          text:
            "Marked " +
            s.discussion +
            " by " +
            s.author.name +
            " (" +
            s.author.kind +
            "), " +
            when(s.at) +
            (s.note ? ": " + s.note : ""),
        }),
      );
    });
    thread.evidence.forEach(function (e) {
      card.appendChild(
        h("div", { class: "hm-note", text: "Evidence " + e.result + ": " + e.claim + " at " + e.revision }),
      );
    });
    if (thread.url)
      card.appendChild(
        h("a", { href: thread.url, target: "_blank", rel: "noopener noreferrer", text: "Open on GitHub" }),
      );
    if (live) card.appendChild(threadActions(thread));
    return card;
  }

  function threadActions(thread) {
    var box = h("div", { class: "hm-composer" });
    var area = h("textarea", { "aria-label": "Reply to " + thread.id, placeholder: "Reply", maxlength: "20000" });
    area.style.minHeight = "60px";
    var row = h("div", { class: "hm-row" });
    row.appendChild(
      h("button", {
        type: "button",
        class: "hm-btn hm-btn-small",
        text: "Reply",
        onclick: function () {
          if (!area.value.trim()) return;
          post("/api/replies", { threadId: thread.id, text: area.value }, "Reply saved");
        },
      }),
    );
    var next =
      thread.discussion === "resolved" || thread.discussion === "wontfix"
        ? [["open", "Reopen"]]
        : [
            ["resolved", "Resolve"],
            ["wontfix", "Won't fix"],
          ];
    next.forEach(function (n) {
      row.appendChild(
        h("button", {
          type: "button",
          class: "hm-btn hm-btn-small",
          text: n[1],
          onclick: function () {
            post("/api/status", { threadId: thread.id, discussion: n[0] }, thread.id + " marked " + n[0]);
          },
        }),
      );
    });
    box.appendChild(area);
    box.appendChild(row);
    return box;
  }

  function renderPanel() {
    panel.textContent = "";
    if (state.stale)
      panel.appendChild(
        h("p", {
          class: "hm-draft-state",
          "data-state": "error",
          text: "This page is out of date. Reload it before writing more comments.",
        }),
      );
    if (state.selected) renderSelected(state.selected);
    else renderOverview();
    layoutPins();
    postHeight();
  }

  function renderSelected(ref) {
    var t = data.targets[keyOf(ref)];
    var card = h(
      "div",
      { class: "hm-target-card" },
      h("div", { class: "hm-kind", text: (t && BLOCK_NAMES[t.blockKind]) || KIND_NAMES[ref.kind] || ref.kind }),
      h("div", { class: "hm-label", text: describe(ref) }),
      ref.kind === "text"
        ? h("code", { text: "section " + ref.targetId.replace(/^t\./, "") })
        : h("code", { text: (ref.diagramId ? ref.diagramId + " / " : "") + ref.targetId }),
    );
    if (t && t.lines) {
      card.appendChild(
        h("div", {
          class: "hm-source-line",
          text: data.document.path + ":" + t.lines.start + (t.lines.end !== t.lines.start ? "-" + t.lines.end : ""),
        }),
      );
    }
    if (ref.kind === "image" && imageOf(ref)) {
      var regionRow = h("div", { class: "hm-region-row" });
      if (isRegion(ref)) {
        regionRow.appendChild(h("p", { class: "hm-region-note", text: "Marked region " + regionWords(ref.selector) }));
      }
      regionRow.appendChild(
        h("button", {
          type: "button",
          class: "hm-btn hm-btn-small",
          text: isRegion(ref) ? "Change region" : "Mark a region",
          onclick: function () {
            startRegion(ref);
          },
        }),
      );
      if (isRegion(ref)) {
        regionRow.appendChild(
          h("button", {
            type: "button",
            class: "hm-btn hm-btn-small",
            text: "Whole image",
            onclick: function () {
              delete ref.selector;
              select(ref, {});
            },
          }),
        );
      }
      card.appendChild(regionRow);
    }
    if (hostApi && t) {
      card.appendChild(
        h("button", {
          type: "button",
          class: "hm-btn hm-btn-small",
          text: "Show in source",
          onclick: function () {
            hostApi.postMessage({ type: "htmi:reveal", key: keyOf(ref) });
          },
        }),
      );
    }
    if (t && t.mapping !== "exact") {
      card.appendChild(
        h("p", {
          class: "hm-note",
          text: isHtml
            ? "This element has no id in the source, so its key is positional: a comment on it is reported as uncertain if blocks are added before it. An id on the element keeps comments attached."
            : "This element has no declared id; its id is derived from the source, so a comment on it can become uncertain if the diagram changes.",
        }),
      );
    }
    panel.appendChild(
      h(
        "div",
        { class: "hm-row" },
        h("h2", { text: "Selected" }),
        h("button", {
          type: "button",
          class: "hm-btn hm-btn-small",
          text: embed ? "Close" : "Back to all comments",
          onclick: clearSelection,
        }),
      ),
    );
    panel.appendChild(card);
    var threads = threadsFor(ref);
    panel.appendChild(h("h3", { text: threads.length ? "Comments here" : "No comments here yet" }));
    threads.forEach(function (thread) {
      panel.appendChild(threadCard(thread, { showTarget: ref.kind === "text" }));
    });
    panel.appendChild(composer(ref));
  }

  function renderOverview() {
    var open = state.threads.filter(function (t) {
      return t.discussion !== "resolved" && t.discussion !== "wontfix";
    });
    var attention = state.threads.filter(function (t) {
      return t.resolution.status !== "exact" && t.discussion !== "resolved" && t.discussion !== "wontfix";
    });
    var lists = { open: open, attention: attention, all: state.threads };
    panel.appendChild(h("h2", { text: "Comments" }));
    var tabs = h("div", { class: "hm-tabs", role: "group", "aria-label": "Filter comments" });
    [
      ["open", "Open"],
      ["attention", "Needs attention"],
      ["all", "All"],
    ].forEach(function (tab) {
      tabs.appendChild(
        h("button", {
          type: "button",
          class: "hm-btn hm-btn-small",
          "aria-pressed": String(state.tab === tab[0]),
          text: tab[1] + " (" + lists[tab[0]].length + ")",
          onclick: function () {
            state.tab = tab[0];
            renderPanel();
          },
        }),
      );
    });
    panel.appendChild(tabs);
    var shown = lists[state.tab];
    if (!shown.length) {
      panel.appendChild(
        h("p", {
          class: "hm-empty",
          text: state.threads.length
            ? "Nothing in this list."
            : isHtml
              ? "No comments yet. Click a paragraph, table, figure or other element, or select some text, to comment on it."
              : "No comments yet. Select a component, a connection, a group, an image or some text to comment on it.",
        }),
      );
    }
    var picker = elementPicker();
    if (picker) panel.appendChild(picker);
    shown.forEach(function (thread) {
      panel.appendChild(threadCard(thread, { showTarget: true }));
    });
    if (data.coverage.length || data.errors) {
      var cov = h("div", { class: "hm-coverage" }, h("h3", { text: "Not fully represented" }));
      var ul = h("ul");
      data.coverage.forEach(function (c) {
        ul.appendChild(h("li", { text: c.what + (c.consequence ? ": " + c.consequence : "") }));
      });
      if (data.errors)
        ul.appendChild(
          h("li", { text: data.errors + " source problem" + (data.errors > 1 ? "s" : "") + "; run htmi validate" }),
        );
      cov.appendChild(ul);
      panel.appendChild(cov);
    }
    if (!live) {
      panel.appendChild(
        h("p", {
          class: "hm-note",
          text: handoff
            ? "This view shows the page and takes new comments. Comments already posted are on the GitHub page, under the description; this view does not show them."
            : data.includesLocalComments
              ? "This snapshot includes comments that were only stored locally when it was built."
              : "This snapshot shows comments shared on GitHub when it was built. It does not update by itself.",
        }),
      );
    }
  }

  /** Every target in a keyboard friendly list, grouped by section. */
  function elementPicker() {
    var keys = Object.keys(data.targets);
    if (!keys.length) return null;
    var uid = "hm-picker-" + ++composerCount;
    var list = h("select", { id: uid, class: "hm-picker" }, h("option", { value: "", text: "Choose an element" }));
    var groups = {};
    data.sections.forEach(function (s) {
      groups[s.id] = h("optgroup", { label: s.title });
    });
    keys.forEach(function (k) {
      var t = data.targets[k];
      var name = BLOCK_NAMES[t.blockKind] || KIND_NAMES[t.kind] || t.kind;
      (groups[t.sectionId] || list).appendChild(h("option", { value: k, text: name + ": " + t.label }));
    });
    data.sections.forEach(function (s) {
      if (groups[s.id].childNodes.length) list.appendChild(groups[s.id]);
    });
    list.addEventListener("change", function () {
      if (list.value && data.targets[list.value]) select(refForKey(list.value), { scroll: true, flash: true });
    });
    return h("div", { class: "hm-picker-row" }, h("label", { for: uid, text: "Comment on an element" }), list);
  }

  /* ---------- composer ---------- */

  function draftKey(ref) {
    return (
      "htmi:draft:" +
      data.document.id +
      ":" +
      keyOf(ref) +
      (ref.selector && ref.selector.type === "TextQuoteSelector"
        ? ":" + sha256Hex(ref.selector.exact).slice(0, 12)
        : "")
    );
  }

  function codeSpan(text) {
    return "`" + String(text).replace(/`/g, "'") + "`";
  }

  function describeForGitHub(ref) {
    var names = {
      diagram: "diagram",
      node: "component",
      edge: "connection",
      group: "group",
      text: "text",
      image: "image",
      element: "element",
      region: "region",
    };
    if (ref.kind === "text" && ref.selector) {
      var excerpt = ref.selector.exact.length > 80 ? ref.selector.exact.slice(0, 77) + "..." : ref.selector.exact;
      return (
        "text in section " + codeSpan(ref.targetId.replace(/^t\./, "")) + ': "' + excerpt.replace(/\|/g, "\\|") + '"'
      );
    }
    var where = ref.diagramId ? " in " + codeSpan(ref.diagramId) : "";
    var label = ref.label ? ": " + ref.label.replace(/\n/g, " ").replace(/\|/g, "\\|") : "";
    var region = isRegion(ref) ? "; marked region " + regionWords(ref.selector) : "";
    return (names[ref.kind] || ref.kind) + " " + codeSpan(ref.targetId) + where + label + region;
  }

  /* Must stay in step with renderFeedback in src/core/feedback.ts: the server parses this output back. */
  function feedbackMarkdown(id, kind, text, ref, observed) {
    var meta = { v: 1, id: id, kind: kind, target: ref, observed: observed, textDigest: "sha256:" + sha256Hex(text) };
    var json = JSON.stringify(meta).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
    var titles = { comment: "comment", question: "question", "change-request": "change request" };
    var quoted = text
      .split("\n")
      .map(function (l) {
        return l ? "> " + l : ">";
      })
      .join("\n");
    var rows = [
      "| Document | " + codeSpan(ref.documentId) + " (" + codeSpan(ref.documentPath) + ") |",
      "| Target | " + describeForGitHub(ref) + " |",
      "| Seen at | " +
        codeSpan(observed.revision) +
        " (document sha256 " +
        codeSpan(observed.documentDigest.replace(/^sha256:/, "").slice(0, 12)) +
        ") |",
      "| Context | " +
        ((handoff ? "HTMi extension on GitHub, page read " : "review snapshot built ") + when(data.builtAt)).replace(
          /\|/g,
          "\\|",
        ) +
        " |",
    ];
    return [
      "### HTMi feedback: " + titles[kind] + " on " + codeSpan(ref.targetId),
      "",
      quoted,
      "",
      "| Field | Value |",
      "| --- | --- |",
    ]
      .concat(rows)
      .concat(["", "<!-- htmi:feedback " + json + " -->"])
      .join("\n");
  }

  function cleanRef(ref) {
    var out = {};
    ["documentId", "documentPath", "kind", "diagramId", "targetId", "label", "from", "to", "tag", "selector"].forEach(
      function (k) {
        if (ref[k] !== undefined && ref[k] !== null) out[k] = ref[k];
      },
    );
    return out;
  }

  var composerCount = 0;
  function composer(ref) {
    var key = draftKey(ref);
    var draft = storage.get(key) || { id: randomId("D"), kind: "comment", text: "" };
    var box = h("form", { class: "hm-composer", "aria-label": "New comment" });
    box.addEventListener("submit", function (e) {
      e.preventDefault();
    });
    // Unique ids for label association; authored hm- ids are removed from content, so these cannot collide.
    var uid = "hm-composer-" + ++composerCount;
    var kindSelect = h("select", { class: "hm-kind", id: uid + "-kind" });
    COMMENT_KINDS.forEach(function (k) {
      kindSelect.appendChild(h("option", { value: k[0], selected: draft.kind === k[0], text: k[1] }));
    });
    var area = h("textarea", {
      class: "hm-text",
      id: uid + "-text",
      maxlength: "20000",
      placeholder: "Write what you see or ask. It is passed on word for word.",
    });
    area.value = draft.text;
    var status = h("p", { class: "hm-draft-state", role: "status" });
    var copyBox = h("textarea", {
      class: "hm-copybox",
      readonly: true,
      hidden: true,
      "aria-label": "GitHub comment text",
    });

    function save() {
      draft.kind = kindSelect.value;
      draft.text = area.value;
      if (!draft.text.trim()) {
        storage.remove(key);
        status.textContent = "";
        return;
      }
      var stored = storage.set(key, draft);
      status.removeAttribute("data-state");
      status.textContent = live
        ? "Draft, not saved yet" + (stored ? " (kept in this browser)" : "")
        : stored
          ? "Draft, not sent. Kept in this browser only."
          : "Draft, not sent. This browser cannot keep it; copy it before leaving.";
    }
    area.addEventListener("input", save);
    kindSelect.addEventListener("change", save);
    if (draft.text) save();
    else if (state.notice) {
      status.setAttribute("data-state", "saved");
      status.textContent = state.notice;
      state.notice = null;
    }

    box.appendChild(h("label", { for: uid + "-kind", text: "Type" }));
    box.appendChild(kindSelect);
    box.appendChild(h("label", { for: uid + "-text", text: "Comment" }));
    box.appendChild(area);
    var row = h("div", { class: "hm-row" });
    var primary = h("button", {
      type: "button",
      class: "hm-btn hm-btn-primary",
      text: live ? "Save comment" : handoff && handoff.to ? "Add to the GitHub comment box" : "Prepare GitHub comment",
    });
    row.appendChild(primary);
    if (hostApi && !data.host.canSave) {
      primary.disabled = true;
      status.textContent = data.host.reason || "This view cannot save comments.";
    }
    if (handoff && handoff.disabled) {
      primary.disabled = true;
      status.textContent = handoff.disabled;
    }
    row.appendChild(
      h("button", {
        type: "button",
        class: "hm-btn",
        text: "Discard",
        onclick: function () {
          storage.remove(key);
          area.value = "";
          copyBox.hidden = true;
          draft = { id: randomId("D"), kind: kindSelect.value, text: "" };
          status.textContent = "Draft discarded";
        },
      }),
    );
    box.appendChild(row);
    box.appendChild(status);
    box.appendChild(copyBox);

    primary.addEventListener("click", function () {
      var text = area.value.trim();
      if (!text) {
        status.setAttribute("data-state", "error");
        status.textContent = "Write a comment first.";
        area.focus();
        return;
      }
      if (state.stale) {
        status.setAttribute("data-state", "error");
        status.textContent = "The document changed since this page was built. Reload, then comment.";
        return;
      }
      var target = cleanRef(ref);
      var observed = observedFor(ref);
      if (live) {
        primary.disabled = true;
        request("/api/comments", { target: target, observed: observed, kind: kindSelect.value, text: text })
          .then(function (result) {
            storage.remove(key);
            area.value = "";
            state.notice = "Saved as " + result.id + " in .htmi/annotations.jsonl";
            if (isRegion(ref)) delete ref.selector;
            status.setAttribute("data-state", "saved");
            status.textContent = state.notice;
            announce("Comment " + result.id + " saved");
            return refresh();
          })
          .catch(function (error) {
            status.setAttribute("data-state", "error");
            status.textContent = "Not saved: " + error.message + ". Your draft is still here.";
          })
          .then(function () {
            primary.disabled = false;
          });
        return;
      }
      var markdown = feedbackMarkdown(draft.id, kindSelect.value, text, target, observed);
      copyBox.value = markdown;
      copyBox.hidden = false;
      if (handoff && window.parent !== window) {
        // The extension on github.com puts the text in GitHub's own comment box; the reviewer posts it there.
        window.parent.postMessage({ type: "htmi:comment", markdown: markdown, draftId: draft.id }, "*");
        storage.remove(key);
        status.setAttribute("data-state", "saved");
        status.textContent = handoff.to
          ? "Added to " + handoff.to + ". It is not posted until you press Comment there."
          : "Prepared. Copy it into a comment on the issue or pull request; nothing is posted from here.";
        if (!handoff.to) {
          copyBox.focus();
          copyBox.select();
        }
        return;
      }
      var where = data.github ? "issue #" + data.github.issue : "the issue or pull request for this document";
      function manual() {
        copyBox.focus();
        copyBox.select();
        status.removeAttribute("data-state");
        status.textContent = "Copy the text above and paste it as a new comment on " + where + ". Not sent yet.";
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(markdown).then(function () {
          status.setAttribute("data-state", "saved");
          status.textContent = "Copied. Paste it as a new comment on " + where + ". Not sent until you post it there.";
        }, manual);
      } else manual();
      if (data.github && !box.querySelector(".hm-issue-link")) {
        box.appendChild(
          h("a", {
            class: "hm-issue-link",
            href: data.github.issueUrl,
            target: "_blank",
            rel: "noopener noreferrer",
            text: "Open issue #" + data.github.issue,
          }),
        );
      }
    });
    return box;
  }

  /* ---------- live mode ---------- */

  var hostPending = {};
  var hostSeq = 0;
  if (hostApi) {
    window.addEventListener("message", function (event) {
      var m = event.data;
      // The editor moved its cursor into an element: show it here.
      if (m && m.type === "htmi:select" && typeof m.key === "string" && data.targets[m.key]) {
        if (!state.selected || keyOf(state.selected) !== m.key) select(refForKey(m.key), { scroll: true });
        return;
      }
      if (!m || m.type !== "htmi:response" || !hostPending[m.id]) return;
      var p = hostPending[m.id];
      delete hostPending[m.id];
      if (m.ok) p.resolve(m.json);
      else {
        if (m.status === 409) markStale(m.json && m.json.error);
        p.reject(new Error((m.json && m.json.error) || "request failed"));
      }
    });
  }

  function request(path, body) {
    if (hostApi) {
      return new Promise(function (resolve, reject) {
        var id = ++hostSeq;
        hostPending[id] = { resolve: resolve, reject: reject };
        hostApi.postMessage({
          type: "htmi:request",
          id: id,
          path: path,
          body: body ? Object.assign({ documentId: data.document.id }, body) : null,
        });
      });
    }
    return fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json", "X-HTMi-Token": data.live.token } : {},
      body: body ? JSON.stringify(Object.assign({ documentId: data.document.id }, body)) : undefined,
      credentials: "same-origin",
    }).then(function (res) {
      return res.json().then(function (json) {
        if (!res.ok) {
          if (res.status === 409) markStale(json.error);
          throw new Error(json.error || "request failed (" + res.status + ")");
        }
        return json;
      });
    });
  }

  function post(path, body, message) {
    return request(path, body)
      .then(function () {
        announce(message);
        return refresh();
      })
      .catch(function (error) {
        showBanner("Not saved: " + error.message);
      });
  }

  function refresh() {
    return request("/api/state?doc=" + encodeURIComponent(data.document.id)).then(function (json) {
      state.threads = json.threads;
      if (json.document.digest !== data.document.digest) markStale("The document changed on disk.");
      highlightQuotes();
      renderPanel();
    });
  }

  function showBanner(message, withReload) {
    banner.textContent = "";
    banner.appendChild(h("span", { text: message }));
    if (withReload) {
      banner.appendChild(
        h("button", {
          type: "button",
          class: "hm-btn hm-btn-small",
          text: "Reload",
          onclick: function () {
            window.location.reload();
          },
        }),
      );
    }
    banner.hidden = false;
  }

  function markStale(message) {
    if (state.stale) return;
    state.stale = true;
    showBanner((message || "The document changed.") + " This page shows an older revision.", true);
    renderPanel();
  }

  if (data.mode === "live" && window.EventSource) {
    var events = new EventSource("/api/events?doc=" + encodeURIComponent(data.document.id));
    events.addEventListener("annotations", function () {
      refresh().catch(function () {});
    });
    events.addEventListener("document", function () {
      markStale("The document changed on disk.");
    });
  }

  /* ---------- start ---------- */

  function sizeFigures() {
    Array.prototype.forEach.call(document.querySelectorAll(".hm-figure"), function (fig) {
      var svg = fig.querySelector("svg.hm-diagram");
      var canvas = fig.querySelector(".hm-figure-canvas");
      if (!svg || !canvas) return;
      var natural = parseFloat(svg.getAttribute("data-diagram-width"));
      fig.classList.toggle("hm-wide", canvas.clientWidth / natural < 0.8);
    });
  }

  var pending = false;
  function relayout() {
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(function () {
      pending = false;
      sizeFigures();
      layoutPins();
    });
  }
  window.addEventListener("resize", function () {
    if (drawing) stopRegion();
    relayout();
  });
  Array.prototype.forEach.call(document.querySelectorAll("details, img"), function (el) {
    el.addEventListener(el.tagName === "IMG" ? "load" : "toggle", relayout);
  });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(relayout);

  sizeFigures();
  highlightQuotes();
  renderPanel();
  if (hostApi) {
    hostApi.postMessage({
      type: "htmi:ready",
      nonce: nonce,
      targets: document.querySelectorAll("[data-hm-key], [data-doc-key]").length,
    });
  }
  window.__htmi = {
    data: data,
    state: state,
    feedbackMarkdown: feedbackMarkdown,
    sha256Hex: sha256Hex,
    select: select,
    refForKey: refForKey,
  };
})();
