/*
 * Connects the consultation editor (consultation/index.html) to the shared allto project.
 * Loaded after the editor's own script, which exposes window.alltoEditor = { P, refreshRL, markDirty }.
 *
 * - Adds the allto product switcher and project chip to the editor's top bar.
 * - Takes in a red line drawn in another product (e.g. Ultrahand) when the editor opens.
 * - Shares the editor's red line, site title (as the project name) and subtitle (as the place).
 *   Only the red line flows back in, so a public site's curated title is never overwritten.
 */
(function () {
  'use strict';
  var A = window.Allto, E = window.alltoEditor;
  if (!A || !E) return;
  var PRODUCT = 'consultation';

  // ---- top bar: product switcher next to the editor's own tabs, project chip on the right
  var topbar = document.getElementById('topbar');
  if (topbar) {
    var brand = topbar.querySelector('.tb-brand');
    var slot = document.createElement('span');
    slot.className = 'allto-bridge-slot';
    slot.style.cssText = 'display:flex;align-items:center;margin:0 6px 0 4px';
    if (brand && brand.parentNode) brand.parentNode.insertBefore(slot, brand.nextSibling);
    var dark = function () { return document.documentElement.getAttribute('data-theme') !== 'light'; };
    var nav = A.mountSwitcher(slot, { active: PRODUCT, theme: dark() ? 'dark' : 'light', logo: false });
    var right = topbar.lastElementChild;
    var chipSlot = document.createElement('span');
    chipSlot.style.cssText = 'display:flex;align-items:center;margin-right:6px';
    if (right) right.insertBefore(chipSlot, right.firstChild);
    var chip = A.mountProjectChip(chipSlot, { theme: dark() ? 'dark' : 'light' });
    // Follow the editor's light / dark toggle.
    new MutationObserver(function () {
      var d = dark();
      if (nav) nav.classList.toggle('allto-switch--dark', d);
      if (chip) chip.classList.toggle('allto-chip--dark', d);
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  // ---- take in changes made elsewhere
  function ringOf(p) {
    return p && p.redLine && p.redLine.coordinates && p.redLine.coordinates.length > 2 ? p.redLine.coordinates : null;
  }

  function takeIn() {
    if (!A.hasNews(PRODUCT)) return;
    var shared = A.project();
    if (shared.redLine && JSON.stringify(shared.redLine) !== JSON.stringify(ringOf(E.P))) {
      E.P.redLine = { coordinates: shared.redLine.map(function (c) { return [c[0], c[1]]; }) };
      E.refreshRL();
      E.markDirty();
      A.notify('Red line updated from ' + A.productLabel(shared.source));
    }
    A.markSeen(PRODUCT);
    last = JSON.stringify([ringOf(E.P), E.P.siteTitle, E.P.siteSubtitle]);
  }

  function mine() {
    return { redLine: ringOf(E.P) || undefined, name: E.P.siteTitle || undefined, place: E.P.siteSubtitle || undefined };
  }

  // ---- share changes made here (the editor has no change events, so compare on a timer)
  var last = JSON.stringify([ringOf(E.P), E.P.siteTitle, E.P.siteSubtitle]);
  function share() {
    var now = JSON.stringify([ringOf(E.P), E.P.siteTitle, E.P.siteSubtitle]);
    if (now === last) return;
    last = now;
    A.update(mine(), PRODUCT);
  }

  takeIn();
  // First visit: offer this project's title and red line to the other products.
  if (!A.project().updatedAt) A.update(mine(), PRODUCT);
  setInterval(share, 1500);
  A.onChange(function () { takeIn(); });
  window.addEventListener('focus', takeIn);
})();
