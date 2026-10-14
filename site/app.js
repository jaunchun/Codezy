/* CODEZY site — interaction layer. Plain ES5-friendly JS, no dependencies. */
(function () {
  'use strict';

  var doc = document;
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------- theme toggle (dark ⇄ light, persisted) ---------------- */
  var toggle = doc.querySelector('.theme-toggle');
  function currentTheme() {
    return doc.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  }
  function applyTheme(t) {
    doc.documentElement.dataset.theme = t;
    try { localStorage.setItem('codezy-site-theme', t); } catch (e) { /* private mode */ }
    if (toggle) {
      toggle.setAttribute('aria-label', t === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
    }
    var meta = doc.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'light' ? '#f7f7fa' : '#101018');
  }
  if (toggle) {
    toggle.addEventListener('click', function () {
      applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
    });
    /* sync label/meta with the pre-paint choice from the head script */
    if (toggle.getAttribute('aria-label') !== (currentTheme() === 'light' ? 'Switch to dark theme' : 'Switch to light theme')) {
      applyTheme(currentTheme());
    }
  }

  /* ---------------- scroll reveals ---------------- */
  var reveals = Array.prototype.slice.call(doc.querySelectorAll('.reveal'));
  if (reduce || !('IntersectionObserver' in window)) {
    reveals.forEach(function (el) { el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          en.target.classList.add('in');
          io.unobserve(en.target);
        }
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.08 });
    reveals.forEach(function (el) { io.observe(el); });
  }

  /* ---------------- hero typewriter ---------------- */
  var type = doc.querySelector('.type');
  var caret = doc.querySelector('.caret');
  if (type && doc.documentElement.classList.contains('anim')) {
    var full = type.getAttribute('data-text') || type.textContent;
    type.textContent = '';
    if (caret) caret.classList.add('typing');
    /* starts right after the last chat step settles (s = 2.9s) */
    setTimeout(function () {
      var i = 0;
      var iv = setInterval(function () {
        i += 1;
        type.textContent = full.slice(0, i);
        if (i >= full.length) {
          clearInterval(iv);
          setTimeout(function () {
            if (caret) caret.classList.remove('typing');
          }, 600);
        }
      }, 16);
    }, 3500);
  }

  /* ---------------- mode tabs (roving tabindex) ---------------- */
  var tabs = Array.prototype.slice.call(doc.querySelectorAll('[role="tab"]'));
  function selectTab(tab, moveFocus) {
    tabs.forEach(function (t) {
      var selected = t === tab;
      t.setAttribute('aria-selected', selected ? 'true' : 'false');
      t.tabIndex = selected ? 0 : -1;
      var panel = doc.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !selected;
    });
    if (moveFocus) tab.focus();
  }
  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () { selectTab(tab); });
    tab.addEventListener('keydown', function (e) {
      var i = tabs.indexOf(tab);
      var next = null;
      if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
      else if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs[tabs.length - 1];
      if (next) { e.preventDefault(); selectTab(next, true); }
    });
  });

  /* ---------------- copy-to-clipboard buttons ---------------- */
  var live = doc.getElementById('live');
  function announce(msg) {
    if (!live) return;
    live.textContent = '';
    setTimeout(function () { live.textContent = msg; }, 30);
  }
  Array.prototype.slice.call(doc.querySelectorAll('.copy')).forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy') || '';
      function ok() {
        btn.classList.add('done');
        btn.textContent = 'copied';
        announce('Copied ' + text);
        setTimeout(function () {
          btn.classList.remove('done');
          btn.textContent = 'copy';
        }, 1600);
      }
      function legacy() {
        var ta = doc.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        doc.body.appendChild(ta);
        ta.select();
        var done = false;
        try { done = doc.execCommand('copy'); } catch (e) { done = false; }
        doc.body.removeChild(ta);
        if (done) ok(); else announce('Copying failed');
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(ok, legacy);
      } else {
        legacy();
      }
    });
  });

  /* ---------------- nav: active section highlight ---------------- */
  var links = {};
  Array.prototype.slice.call(doc.querySelectorAll('[data-navlink]')).forEach(function (a) {
    links[a.getAttribute('data-navlink')] = a;
  });
  if ('IntersectionObserver' in window) {
    var sio = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          Object.keys(links).forEach(function (k) { links[k].removeAttribute('aria-current'); });
          var a = links[en.target.id];
          if (a) a.setAttribute('aria-current', 'true');
        }
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    Object.keys(links).forEach(function (id) {
      var section = doc.getElementById(id);
      if (section) sio.observe(section);
    });
  }
})();
