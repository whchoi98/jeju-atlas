(function () {
  'use strict';
  var preferred = null;
  try {
    preferred = localStorage.getItem('jeju-atlas:workshop:theme');
  } catch (_) {
    // Reading the course never depends on storage permissions.
  }
  var dark = preferred === 'dark' || (preferred !== 'light'
    && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
