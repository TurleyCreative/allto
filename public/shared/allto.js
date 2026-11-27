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
  var meP = null;

  var FILE_FORMAT = 'allto-project';
  // What belongs to the project. Per-person preferences (theme, guides, snapping) stay out of it.
  var FILE_KEYS = ['allto:project', 'consultation_builder_project', 'ultrahand:last'];
  var FILE_PREFIXES = ['present:project'];
  var flushers = [];
  function fileKeys() {
    var out = FILE_KEYS.slice();
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (out.indexOf(k) < 0 && FILE_PREFIXES.some(function (p) { return k.indexOf(p) === 0; })) out.push(k);
      }
    } catch (e) { /* storage blocked */ }
    return out;
  }
  function gzip(text) {
    if (typeof CompressionStream === 'undefined') return Promise.resolve(new Blob([text], { type: 'application/json' }));
    return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob()
      .then(function (b) { return new Blob([b], { type: 'application/x-allto' }); });
  }

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
      if (opts.file !== false) html += '<span class="allto-switch__file"><button type="button" data-allto-file="save" title="Save the whole project (Consultation, Present and Ultrahand) as one .allto file">Save project</button><button type="button" data-allto-file="open" title="Open a .allto project file">Open</button></span>';
      nav.innerHTML = html;
      nav.addEventListener('click', function (e) {
        var b = e.target.closest && e.target.closest('[data-allto-file]'); if (!b) return;
        if (b.getAttribute('data-allto-file') === 'save') Allto.saveFile(); else Allto.pickFile();
      });
      host.appendChild(nav);
      Allto.whoAmI().then(function (me) {
        if (!me || !me.email) return;
        var who = document.createElement('span');
        who.className = 'allto-me';
        who.innerHTML = escapeHtml(me.email) + ' · <a href="' + ROOT + 'cdn-cgi/access/logout">Sign out</a>';
        nav.appendChild(who);
      });
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

    /**
     * Who is signed in, when allto is served by its Cloudflare Worker behind Cloudflare Access.
     * Resolves to { email, unlocked } or null (elsewhere, e.g. a local copy).
     */
    whoAmI: function () {
      if (!meP) meP = fetch(ROOT + 'me', { credentials: 'same-origin' })
        .then(function (r) { return r.ok && /json/.test(r.headers.get('content-type') || '') ? r.json() : null; })
        .catch(function () { return null; });
      return meP;
    },

    /**
     * The .allto project file: everything allto keeps in this browser for the project
     * (the shared project, the consultation project, the Ultrahand site and anything Present
     * saves), in one file. It is JSON, gzip-compressed where the browser supports it.
     */
    FILE_FORMAT: FILE_FORMAT,

    /** Run fn() just before a project file is written, so a product can store its latest state. */
    beforeSave: function (fn) { flushers.push(fn); },

    /** The project as one object (what goes in the file). */
    fileData: function () {
      flushers.forEach(function (fn) { try { fn(); } catch (e) { /* keep going */ } });
      var store = {};
      fileKeys().forEach(function (k) {
        var v = null;
        try { v = localStorage.getItem(k); } catch (e) { /* storage blocked */ }
        if (v == null) return;
        try { store[k] = JSON.parse(v); } catch (e) { store[k] = v; }
      });
      var p = store['allto:project'] || {}, c = store['consultation_builder_project'] || {};
      return { format: FILE_FORMAT, version: 1, savedAt: new Date().toISOString(), name: p.name || c.siteTitle || c.name || 'allto project', store: store };
    },

    /** Download the project as name.allto. */
    saveFile: function () {
      var data = Allto.fileData();
      var json = JSON.stringify(data);
      var name = String(data.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
      return gzip(json).then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name + '.allto';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
        Allto.notify('Saved ' + name + '.allto');
        return name + '.allto';
      });
    },

    /** Read a .allto file (or a consultation .json saved before .allto existed) into a project object. */
    readFile: function (file) {
      return file.arrayBuffer().then(function (buf) {
        var b = new Uint8Array(buf);
        if (b[0] === 0x1f && b[1] === 0x8b) {
          if (typeof DecompressionStream === 'undefined') throw new Error('This browser can\u2019t open compressed project files.');
          return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
        }
        return new TextDecoder().decode(buf);
      }).then(function (text) {
        var d = JSON.parse(text);
        if (d && d.format === FILE_FORMAT && d.store) return d;
        if (d && Array.isArray(d.scenes)) return { format: FILE_FORMAT, version: 1, name: d.siteTitle || d.name || file.name, store: { consultation_builder_project: d }, legacy: true };
        throw new Error('This isn\u2019t an allto project file.');
      });
    },

    /**
     * Open a project file: it replaces what this browser holds for the project in every
     * product, then reloads the page so the product starts from the file.
     */
    openFile: function (file) {
      return Allto.readFile(file).then(function (d) {
        var keys = Object.keys(d.store);
        try {
          // A full .allto file replaces the whole project; an old consultation .json only the consultation.
          if (!d.legacy) fileKeys().forEach(function (k) { if (!(k in d.store)) localStorage.removeItem(k); });
          keys.forEach(function (k) { var v = d.store[k]; localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); });
          // Each product starts from its own part of the file, not from an older shared red line.
          var now = String(Date.now() + 1000);
          PRODUCTS.forEach(function (p) { localStorage.setItem('allto:seen:' + p.id, now); });
        } catch (e) {
          throw new Error(/quota/i.test(String(e && e.name) + String(e && e.message)) ? 'The project is too big for this browser\u2019s storage.' : String(e && e.message || e));
        }
        try { sessionStorage.setItem('allto:opened', d.name || file.name); } catch (e) { /* ignore */ }
        location.reload();
        return d;
      });
    },

    /** Ask for a project file and open it. */
    pickFile: function () {
      var inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.allto,.json,application/json,application/gzip';
      inp.onchange = function () {
        var f = inp.files && inp.files[0]; if (!f) return;
        if (!confirm('Open \u201c' + f.name + '\u201d? It replaces the project currently open in allto (Consultation, Present and Ultrahand). Save first if you want to keep it.')) return;
        Allto.openFile(f).catch(function (e) { alert('Could not open the file: ' + (e && e.message || e)); });
      };
      inp.click();
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
  try {
    var opened = sessionStorage.getItem('allto:opened');
    if (opened) { sessionStorage.removeItem('allto:opened'); setTimeout(function () { Allto.notify('Opened ' + opened); }, 600); }
  } catch (e) { /* ignore */ }
})();
