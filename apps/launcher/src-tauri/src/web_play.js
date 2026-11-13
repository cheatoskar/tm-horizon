// Injected into every page of the embedded browser (web.rs). On the TM-Exchange sites (Nations ESWC,
// Sunrise, Original, Nations and United Forever) it adds a "Play" button next to each track download
// link (/trackgbx/<id>): on track pages and in result lists, also in lists the site renders later.
// The button looks like the site's own buttons (it copies the download link's classes, green instead
// of blue) and carries TM Horizon's small mark. It navigates to tmhub-play:<download url>; TM Horizon
// catches that (on_navigation), downloads the map into the game's folder with the normal interception
// and opens it: Forever with /file or TMLoader, a running ESWC or Sunrise through Horizon Client,
// otherwise the map waits under Downloaded. Nothing else on the page is changed.
(function () {
  var HOSTS = ['nations.tm-exchange.com', 'sunrise.tm-exchange.com', 'original.tm-exchange.com', 'tmnf.exchange', 'tmuf.exchange'];
  var host = (location.host || '').toLowerCase().replace(/^www\./, '');
  if (HOSTS.indexOf(host) < 0 || window.__tmhubPlay) return;
  window.__tmhubPlay = true;
  var MARK = 'data-tmhub-play';
  var NS = 'http://www.w3.org/2000/svg';
  // TM Horizon's mark, drawn small: a planet with its ring.
  function mark() {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16');
    s.setAttribute('width', '14');
    s.setAttribute('height', '14');
    s.setAttribute('aria-hidden', 'true');
    s.style.cssText = 'vertical-align:-2px;margin-right:5px;flex:none';
    var c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', '8'); c.setAttribute('cy', '8'); c.setAttribute('r', '4.6'); c.setAttribute('fill', 'currentColor');
    var e = document.createElementNS(NS, 'ellipse');
    e.setAttribute('cx', '8'); e.setAttribute('cy', '8.4'); e.setAttribute('rx', '7.3'); e.setAttribute('ry', '2.4');
    e.setAttribute('fill', 'none'); e.setAttribute('stroke', '#ff9a3c'); e.setAttribute('stroke-width', '1.5');
    e.setAttribute('transform', 'rotate(-18 8 8)');
    s.appendChild(c); s.appendChild(e);
    return s;
  }
  function add(a) {
    if (a.hasAttribute(MARK)) return;
    a.setAttribute(MARK, '1');
    var href;
    try { href = new URL(a.getAttribute('href'), location.href); } catch (e) { return; }
    if (href.host.toLowerCase().replace(/^www\./, '') !== host || !/^\/trackgbx\/\d+\/?$/.test(href.pathname)) return;
    var b = document.createElement('a');
    b.href = 'tmhub-play:' + encodeURIComponent(href.origin + href.pathname.replace(/\/$/, ''));
    b.title = 'Play in TM Horizon';
    b.setAttribute('aria-label', 'Play in TM Horizon');
    b.setAttribute(MARK, '1');
    b.appendChild(mark());
    var cls = (a.getAttribute('class') || '').split(/\s+/).filter(function (c) { return c && c !== 'trackdownload'; });
    var cell = a.parentElement;
    // Result lists: the download icon has its own narrow column. The Play icon goes in front of the
    // track name in the next column instead, so nothing overlaps.
    if (cls.indexOf('btn') < 0 && !(a.textContent || '').trim() && cell && cell.tagName === 'TD' && cell.nextElementSibling && cell.offsetWidth < 48) {
      b.firstChild.style.marginRight = '0';
      b.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin-right:6px;border-radius:5px;' +
        'background:#16a34a;color:#fff;vertical-align:-4px;text-decoration:none';
      cell.nextElementSibling.insertBefore(b, cell.nextElementSibling.firstChild);
      return;
    }
    b.appendChild(document.createTextNode('Play'));
    if (cls.indexOf('btn') >= 0) {
      // Bootstrap sites (the old exchanges): the same button, green.
      b.className = cls.map(function (c) { return /^btn-(primary|secondary|info|light|dark|outline-\w+)$/.test(c) ? 'btn-success' : c; }).join(' ');
      if (b.className.indexOf('btn-success') < 0) b.className += ' btn-success';
      b.style.cssText = 'margin-left:6px;display:inline-flex;align-items:center;white-space:nowrap';
    } else {
      b.style.cssText = 'display:inline-flex;align-items:center;margin-left:8px;padding:2px 10px;border-radius:6px;background:#16a34a;color:#fff;' +
        'font-weight:600;font-size:12px;line-height:20px;text-decoration:none;white-space:nowrap;vertical-align:middle';
    }
    a.insertAdjacentElement('afterend', b);
  }
  function scan(root) {
    var list = (root || document).querySelectorAll('a[href*="/trackgbx/"]:not([' + MARK + '])');
    for (var i = 0; i < list.length; i++) add(list[i]);
  }
  function start() {
    scan();
    var queued = false;
    new MutationObserver(function () {
      if (queued) return;
      queued = true;
      setTimeout(function () { queued = false; scan(); }, 250);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
