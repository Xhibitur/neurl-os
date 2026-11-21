/* NEURL-OS cookie consent + Google Analytics 4
 * Loaded on every page. Google Analytics only loads after the visitor taps "Accept".
 * Browsers that send Global Privacy Control are treated as "Decline" automatically.
 *
 * Pages call:
 *   neurlTrack(name, params)    record an event (dropped unless analytics was accepted)
 *   neurlPage(path, title)      record a screen view in the app (/today, /habits, ...)
 *   neurlUser(props)            set user properties (tests_bucket, partner, ...)
 * Any element with data-cookie-settings reopens the banner.
 */
(function () {
  var GA_ID = 'G-HNBQNHRJEL';
  var KEY = 'neurl:consent';
  var VERSION = 1;
  var isApp = document.documentElement.hasAttribute('data-app');
  var loaded = false, lastPage = null, userProps = null;

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  gtag('consent', 'default', {
    analytics_storage: 'denied', ad_storage: 'denied',
    ad_user_data: 'denied', ad_personalization: 'denied'
  });

  function read() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY));
      if (v && v.v === VERSION) return v.choice;
    } catch (e) {}
    return null;
  }
  function write(choice) {
    try { localStorage.setItem(KEY, JSON.stringify({ v: VERSION, choice: choice, at: new Date().toISOString() })); } catch (e) {}
  }
  function granted() { return read() === 'accept'; }

  function loadGA() {
    if (loaded) return;
    loaded = true;
    gtag('consent', 'update', { analytics_storage: 'granted' });
    gtag('js', new Date());
    gtag('config', GA_ID, { send_page_view: !isApp });
    if (userProps) gtag('set', 'user_properties', userProps);
    if (isApp && lastPage) gtag('event', 'page_view', lastPage);
    if (document.querySelector('script[src*="googletagmanager.com/gtag/js"]')) return;
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
    document.head.appendChild(s);
  }

  window.neurlTrack = function (name, params) {
    if (loaded) gtag('event', name, params || {});
  };
  window.neurlPage = function (path, title) {
    lastPage = { page_location: location.origin + path + location.search, page_path: path, page_title: title };
    if (loaded) gtag('event', 'page_view', lastPage);
  };
  window.neurlUser = function (props) {
    userProps = Object.assign(userProps || {}, props);
    if (loaded) gtag('set', 'user_properties', userProps);
  };

  /* ---------- banner ---------- */
  var css =
    '.ck{position:fixed;left:0;right:0;bottom:0;z-index:1000;display:flex;justify-content:center;' +
    'padding:0 max(12px,env(safe-area-inset-right,0px)) calc(12px + env(safe-area-inset-bottom,0px)) max(12px,env(safe-area-inset-left,0px));pointer-events:none}' +
    '.ck-box{pointer-events:auto;width:100%;max-width:520px;background:#14181D;border:1px solid #2C323B;border-radius:16px;' +
    'box-shadow:0 12px 40px rgba(0,0,0,.5);padding:16px 18px;color:#D7DCE3;font:13px/1.5 "Helvetica Neue",Helvetica,Arial,system-ui,sans-serif}' +
    '.ck-box b{display:block;color:#fff;font-size:14px;margin-bottom:4px}' +
    '.ck-box p{margin:0 0 12px}' +
    '.ck-box a{color:#38EE66}' +
    '.ck-row{display:flex;gap:8px}' +
    '.ck-row button{flex:1;font:inherit;font-weight:700;font-size:14px;border-radius:12px;padding:12px;cursor:pointer}' +
    '.ck-yes{background:#38EE66;color:#06210F;border:0}' +
    '.ck-no{background:none;color:#D7DCE3;border:1px solid #2C323B}' +
    '.ck-row button:focus-visible{outline:2px solid #38EE66;outline-offset:2px}';

  function showBanner() {
    if (document.getElementById('ck')) return;
    if (!document.getElementById('ck-css')) {
      var st = document.createElement('style'); st.id = 'ck-css'; st.textContent = css; document.head.appendChild(st);
    }
    var wrap = document.createElement('div');
    wrap.className = 'ck'; wrap.id = 'ck';
    wrap.innerHTML =
      '<div class="ck-box" role="dialog" aria-live="polite" aria-labelledby="ck-t">' +
      '<b id="ck-t">Cookies</b>' +
      '<p>We use Google Analytics cookies to see which screens people use and whether they come back. ' +
      'Your test results and habit answers are never sent. <a href="/privacy.html#cookies">Privacy policy</a></p>' +
      '<div class="ck-row"><button type="button" class="ck-no" id="ck-no">Decline</button>' +
      '<button type="button" class="ck-yes" id="ck-yes">Accept</button></div></div>';
    document.body.appendChild(wrap);
    document.getElementById('ck-yes').onclick = function () { write('accept'); hide(); loadGA(); neurlTrack('consent_choice', { choice: 'accept' }); };
    document.getElementById('ck-no').onclick = function () { write('decline'); hide(); revoke(); };
  }
  function hide() { var el = document.getElementById('ck'); if (el) el.remove(); }
  function revoke() {
    if (!loaded) return;
    loaded = false;
    gtag('consent', 'update', { analytics_storage: 'denied' });
    document.cookie.split(';').forEach(function (c) {
      var n = c.split('=')[0].trim();
      if (n.indexOf('_ga') === 0) {
        document.cookie = n + '=; Max-Age=0; path=/';
        document.cookie = n + '=; Max-Age=0; path=/; domain=.' + location.hostname.replace(/^www\./, '');
      }
    });
  }

  function init() {
    var choice = read();
    if (!choice && navigator.globalPrivacyControl) { write('decline'); choice = 'decline'; }
    if (choice === 'accept') loadGA();
    else if (!choice) showBanner();
    document.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('[data-cookie-settings]');
      if (!t) return;
      e.preventDefault();
      try { localStorage.removeItem(KEY); } catch (err) {}
      showBanner();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
