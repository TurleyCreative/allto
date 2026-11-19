/*
 * allto shared layer: the project every product works on, and the product switcher.
 *
 * Plain JavaScript (no build step) so the consultation editor, which is a single HTML file,
 * can load it exactly like Ultrahand and Present do. Exposes window.Allto.
 *
 * The project lives in this browser's localStorage under "allto:project":
 *   { name, place, redLine: [[lng, lat], ...] (closed ring), updatedAt, source }
 * Each product records when it last took the shared project in ("allto:seen:<product>"), so a
 * change made in one product is picked up by the others the next time they open, or straight
 * away if they are open in another tab.
 */
(function () {
  'use strict';

  var KEY = 'allto:project';
  var PRODUCTS = [
    { id: 'consultation', label: 'Consultation', path: 'consultation/index.html', blurb: 'Build the public consultation site: scenes, map, questions and feedback.' },
    { id: 'present', label: 'Present', path: 'present/index.html', blurb: 'Present the project to clients, committees and the public from the same material.' },
    { id: 'ultrahand', label: 'Ultrahand', path: 'ultrahand/index.html', blurb: 'Design and constraints: red line, designations, axonometric, atlas and building passports.' },
  ];

  // Work out the site root from this script's own address, so links work locally and on Pages.
  var me = document.currentScript && document.currentScript.src;
  var ROOT = me ? me.replace(/shared\/allto\.js(\?.*)?$/, '') : './';

  function read() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || 'null') || {};
    } catch (e) {
      return {};
    }
  }

  function write(p) {
    try {
      localStorage.setItem(KEY, JSON.stringify(p));
    } catch (e) { /* storage blocked */ }
    listeners.forEach(function (fn) { fn(p); });
  }

  var listeners = [];

  function closeRing(ring) {
    if (!ring || ring.length < 3) return null;
    var a = ring[0], b = ring[ring.length - 1];
    return a[0] === b[0] && a[1] === b[1] ? ring : ring.concat([a]);
  }

  function sameRing(a, b) {
    return JSON.stringify(a || null) === JSON.stringify(b || null);
  }

  var Allto = {
    PRODUCTS: PRODUCTS,
    ROOT: ROOT,
    url: function (id) {
      var p = PRODUCTS.filter(function (x) { return x.id === id; })[0];
      return ROOT + (p ? p.path : 'index.html');
    },

    /** The shared project ({} when nothing has been started). */
    project: read,

    /**
     * Update the shared project. `patch` may hold name, place and redLine (a ring of [lng, lat]).
     * Nothing is written if nothing changed. Returns the project.
     */
    update: function (patch, source) {
      var p = read();
      var changed = false;
      if (patch.redLine !== undefined) {
        var ring = closeRing(patch.redLine);
        if (ring && !sameRing(ring, p.redLine)) { p.redLine = ring; changed = true; }
      }
      ['name', 'place'].forEach(function (k) {
        if (patch[k] && patch[k] !== p[k]) { p[k] = patch[k]; changed = true; }
      });
      if (!changed) return p;
      p.updatedAt = Date.now();
      p.source = source;
      write(p);
      Allto.markSeen(source);
      return p;
    },

    /** Forget the shared project (the products keep their own copies). */
    clear: function () {
      try { localStorage.removeItem(KEY); } catch (e) { /* storage blocked */ }
      listeners.forEach(function (fn) { fn({}); });
    },

    /** True when another product changed the project since `product` last took it in. */
    hasNews: function (product) {
      var p = read();
      if (!p.updatedAt || p.source === product) return false;
      var seen = 0;
      try { seen = +(localStorage.getItem('allto:seen:' + product) || 0); } catch (e) { /* ignore */ }
      return p.updatedAt > seen;
    },

    markSeen: function (product) {
      try { localStorage.setItem('allto:seen:' + product, String(Date.now())); } catch (e) { /* ignore */ }
    },

    /** Call fn(project) whenever the project changes, here or in another tab. */
    onChange: function (fn) {
      listeners.push(fn);
    },

    productLabel: function (id) {
      var p = PRODUCTS.filter(function (x) { return x.id === id; })[0];
      return p ? p.label : id;
    },

    /**
     * Put the allto product switcher into `host`.
     * opts.active: current product id. opts.theme: 'light' (default) or 'dark'.
     * opts.logo: false to leave the logo out (when the page shows its own).
     */
    mountSwitcher: function (host, opts) {
      opts = opts || {};
      if (!host) return null;
      var nav = document.createElement('nav');
      nav.className = 'allto-switch' + (opts.theme === 'dark' ? ' allto-switch--dark' : '');
      nav.setAttribute('aria-label', 'allto products');
      var html = '';
      if (opts.logo !== false) {
        var logo = ROOT + 'shared/' + (opts.theme === 'dark' ? 'allto-logo-dark-bg.svg' : 'allto-logo.svg');
        html += '<a class="allto-switch__home" href="' + ROOT + 'index.html" title="allto home"><img src="' + logo + '" alt="allto*"></a>';
      }
      html += '<span class="allto-switch__tabs">';
      PRODUCTS.forEach(function (p) {
        var on = p.id === opts.active;
        html += '<a href="' + ROOT + p.path + '"' + (on ? ' class="on" aria-current="page"' : '') + '>' + p.label + '</a>';
      });
      html += '</span>';
      nav.innerHTML = html;
      host.appendChild(nav);
      return nav;
    },

    /** A small project chip: name and whether a red line is shared. */
    mountProjectChip: function (host, opts) {
      opts = opts || {};
      if (!host) return null;
      var chip = document.createElement('span');
      chip.className = 'allto-chip' + (opts.theme === 'dark' ? ' allto-chip--dark' : '');
      function render() {
        var p = read();
        chip.innerHTML = p.name || p.redLine
          ? '<span class="allto-chip__dot' + (p.redLine ? ' on' : '') + '"></span>' + escapeHtml(p.name || 'Untitled project') +
            (p.redLine ? '<span class="allto-chip__meta">red line shared</span>' : '')
          : '<span class="allto-chip__dot"></span>No shared project yet';
        chip.title = p.updatedAt ? 'Last changed in ' + Allto.productLabel(p.source) + ', ' + new Date(p.updatedAt).toLocaleString('en-GB') : '';
      }
      render();
      Allto.onChange(render);
      host.appendChild(chip);
      return chip;
    },

    /**
     * The allto intro animation, once per browser session (opts.force to replay).
     * It belongs at the start of allto, not inside a tool; published consultation sites and
     * exported presentations carry their own copy so the public sees it too.
     */
    playIntro: function (opts) {
      opts = opts || {};
      try {
        if (!opts.force && sessionStorage.getItem('allto:intro')) return;
        sessionStorage.setItem('allto:intro', '1');
      } catch (e) { /* storage blocked: play it */ }
      if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      var box = document.createElement('div');
      box.className = 'allto-intro';
      box.setAttribute('role', 'presentation');
      box.innerHTML = '<img src="' + ROOT + 'shared/allto-intro.gif?' + Date.now() + '" alt=""><button class="allto-intro__skip" type="button">Skip</button>';
      document.body.appendChild(box);
      var img = box.querySelector('img');
      var done = false;
      function close() {
        if (done) return;
        done = true;
        box.classList.add('out');
        setTimeout(function () { box.remove(); }, 650);
      }
      img.addEventListener('load', function () { box.classList.add('ready'); setTimeout(close, 5100); });
      box.addEventListener('click', close);
      document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
      setTimeout(close, 6500); // in case the animation can't load
    },

    /** A short notice in the corner, e.g. "Red line updated from Ultrahand". */
    notify: function (msg) {
      var n = document.createElement('div');
      n.className = 'allto-note';
      n.setAttribute('role', 'status');
      n.textContent = msg;
      document.body.appendChild(n);
      setTimeout(function () { n.classList.add('out'); }, 3800);
      setTimeout(function () { n.remove(); }, 4400);
    },
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  // Changes made in another tab.
  window.addEventListener('storage', function (e) {
    if (e.key === KEY) listeners.forEach(function (fn) { fn(read()); });
  });

  // Shared styles, injected once so every product gets them with a single script tag.
  var css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = ROOT + 'shared/allto.css';
  document.head.appendChild(css);

  window.Allto = Allto;
})();
