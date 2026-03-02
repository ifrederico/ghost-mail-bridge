(function () {
  var cardsEl = document.getElementById('summary-cards');
  var healthEl = document.getElementById('health-json');
  var healthMetaEl = document.getElementById('health-meta');
  var failureEl = document.getElementById('failure-rows');
  var failureMetaEl = document.getElementById('failure-meta');
  var presetEl = document.getElementById('preset');
  var intervalEl = document.getElementById('interval');
  var refreshBtn = document.getElementById('refresh');
  var statusEl = document.getElementById('status');
  var basePathEl = document.getElementById('base-path');

  var timer = null;
  var currentPreset = 'healthy';

  function getBasePath() {
    var path = window.location.pathname;
    if (path.endsWith('/index.html')) path = path.slice(0, -11);
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return path || '/ghost/email';
  }

  var basePath = getBasePath();
  basePathEl.textContent = basePath;

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function esc(str) {
    return String(str === undefined || str === null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtTime(ts) {
    if (!ts) return '-';
    return new Date(ts * 1000).toLocaleString();
  }

  function metricClass(label, value) {
    if (label.indexOf('Failed') === 0 || label.indexOf('Complained') === 0) {
      return value > 0 ? 'danger' : 'ok';
    }
    if (label.indexOf('Suppressed') === 0) {
      return value > 0 ? 'warn' : 'ok';
    }
    return '';
  }

  function metric(label, value) {
    var cls = metricClass(label, value);
    return '<article class="metric">' +
      '<div class="metric-label">' + label + '</div>' +
      '<div class="metric-value ' + cls + '">' + value + '</div>' +
      '</article>';
  }

  function eventPill(evt) {
    var eventName = esc(evt || '');
    return '<span class="event-pill ' + eventName + '">' + eventName + '</span>';
  }

  function updateAutoRefresh() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }

    var intervalMs = parseInt(intervalEl.value, 10);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      setStatus('manual mode');
      return;
    }

    timer = setInterval(function () {
      load();
    }, intervalMs);
    setStatus('auto refresh every ' + Math.round(intervalMs / 1000) + 's');
  }

  async function loadPresets() {
    var response = await fetch(basePath + '/api/presets');
    if (!response.ok) {
      throw new Error('Failed to load presets');
    }

    var data = await response.json();
    var options = data.items || [];

    presetEl.innerHTML = options.map(function (row) {
      return '<option value="' + esc(row.id) + '">' + esc(row.label) + '</option>';
    }).join('');

    if (!options.length) {
      presetEl.innerHTML = '<option value="healthy">Healthy traffic</option>';
    }
  }

  async function load() {
    var query = '?preset=' + encodeURIComponent(currentPreset);

    try {
      setStatus('loading...');

      var responses = await Promise.all([
        fetch(basePath + '/api/summary' + query),
        fetch(basePath + '/api/health' + query),
        fetch(basePath + '/api/failures' + query + '&limit=25')
      ]);

      if (!responses[0].ok || !responses[1].ok || !responses[2].ok) {
        throw new Error('Dashboard API request failed');
      }

      var summary = await responses[0].json();
      var health = await responses[1].json();
      var failures = await responses[2].json();

      cardsEl.innerHTML = [
        metric('Sent (24h)', summary.sent_24h),
        metric('Delivered (24h)', summary.delivered_24h),
        metric('Opened (24h)', summary.opened_24h),
        metric('Clicked (24h)', summary.clicked_24h),
        metric('Failed (24h)', summary.failed_24h),
        metric('Complained (24h)', summary.complained_24h),
        metric('Suppressed bounces', summary.suppressions.bounces),
        metric('Suppressed complaints', summary.suppressions.complaints),
        metric('Suppressed unsubscribes', summary.suppressions.unsubscribes)
      ].join('');

      healthMetaEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
      healthEl.textContent = JSON.stringify(health, null, 2);

      var items = failures.items || [];
      failureMetaEl.textContent = items.length + ' rows';
      failureEl.innerHTML = items.map(function (row) {
        return '<tr>' +
          '<td>' + esc(fmtTime(row.timestamp)) + '</td>' +
          '<td>' + eventPill(row.event) + '</td>' +
          '<td class="mono">' + esc(row.recipient) + '</td>' +
          '<td>' + esc(row.reason || row.enhanced_code || '-') + '</td>' +
          '</tr>';
      }).join('') || '<tr><td colspan="4">No recent failed or complained events.</td></tr>';

      setStatus('loaded ' + new Date().toLocaleTimeString());
    } catch (err) {
      cardsEl.innerHTML = metric('Error', 'Failed');
      healthEl.textContent = String(err && err.message ? err.message : err);
      failureEl.innerHTML = '<tr><td colspan="4">Failed to load</td></tr>';
      failureMetaEl.textContent = '';
      setStatus('error');
    }
  }

  presetEl.addEventListener('change', function () {
    currentPreset = presetEl.value || 'healthy';
    load();
  });

  intervalEl.addEventListener('change', updateAutoRefresh);
  refreshBtn.addEventListener('click', load);

  (async function bootstrap() {
    await loadPresets();
    currentPreset = presetEl.value || 'healthy';
    updateAutoRefresh();
    load();
  })();
})();
