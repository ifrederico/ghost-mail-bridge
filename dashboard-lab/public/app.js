(function () {
  var presetEl = document.getElementById('preset');
  var intervalEl = document.getElementById('interval');
  var refreshBtn = document.getElementById('refresh');
  var statusEl = document.getElementById('status');

  var tabControls = Array.prototype.slice.call(document.querySelectorAll('[data-tab-target]'));
  var tabPanels = Array.prototype.slice.call(document.querySelectorAll('[data-tab-panel]'));

  var overviewCardsEl = document.getElementById('overview-cards');
  var overviewAlertsEl = document.getElementById('overview-alerts');
  var overviewMetaEl = document.getElementById('overview-meta');
  var overviewFailureMetaEl = document.getElementById('overview-failure-meta');
  var overviewFailureRowsEl = document.getElementById('overview-failure-rows');

  var deliveryCardsEl = document.getElementById('delivery-cards');
  var deliveryRowsEl = document.getElementById('delivery-rows');

  var failureFilterEl = document.getElementById('failure-filter');
  var failureMetaEl = document.getElementById('failure-meta');
  var failureReasonRowsEl = document.getElementById('failure-reason-rows');
  var failureRowsEl = document.getElementById('failure-rows');

  var suppressionFilterEl = document.getElementById('suppression-filter');
  var suppressionMetaEl = document.getElementById('suppression-meta');
  var suppressionCardsEl = document.getElementById('suppression-cards');
  var suppressionRowsEl = document.getElementById('suppression-rows');

  var queueMetaEl = document.getElementById('queue-meta');
  var queueRowsEl = document.getElementById('queue-rows');
  var healthMetaEl = document.getElementById('health-meta');
  var healthJsonEl = document.getElementById('health-json');

  var settingsRowsEl = document.getElementById('settings-rows');
  var settingsCheckRowsEl = document.getElementById('settings-check-rows');

  var timer = null;
  var state = {
    basePath: '',
    preset: 'healthy',
    activeTab: 'overview',
    summary: null,
    health: null,
    failures: [],
    delivery: null,
    suppressionTotals: { bounces: 0, complaints: 0, unsubscribes: 0 },
    suppressions: [],
    settings: { values: [], checks: [] }
  };

  function getBasePath() {
    var path = window.location.pathname;
    if (path.endsWith('/index.html')) path = path.slice(0, -11);
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return path || '/ghost/email';
  }

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtTime(ts) {
    if (!ts) return '-';
    return new Date(ts * 1000).toLocaleString();
  }

  function fmtIso(iso) {
    if (!iso) return '-';
    var date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return String(iso);
    return date.toLocaleString();
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function normalizeTab(tab) {
    var value = String(tab || '').replace(/^#/, '').toLowerCase();
    if (!value) return 'overview';
    for (var i = 0; i < tabPanels.length; i += 1) {
      if (tabPanels[i].getAttribute('data-tab-panel') === value) {
        return value;
      }
    }
    return 'overview';
  }

  function setActiveTab(tab, updateHash) {
    var target = normalizeTab(tab);
    state.activeTab = target;

    tabPanels.forEach(function (panel) {
      panel.classList.toggle('active', panel.getAttribute('data-tab-panel') === target);
    });

    tabControls.forEach(function (control) {
      control.classList.toggle('active', control.getAttribute('data-tab-target') === target);
    });

    if (updateHash) {
      if (window.history && typeof window.history.replaceState === 'function') {
        window.history.replaceState(null, '', '#' + target);
      } else {
        window.location.hash = target;
      }
    }
  }

  function seededRng(seed) {
    var stateSeed = seed >>> 0;
    return function () {
      stateSeed = (stateSeed * 1664525 + 1013904223) >>> 0;
      return stateSeed / 4294967296;
    };
  }

  function seedFromSummary(summary, preset) {
    var seed = 0;
    var source = [
      preset,
      summary.sent_24h,
      summary.delivered_24h,
      summary.failed_24h,
      summary.complained_24h,
      summary.suppressions.bounces,
      summary.suppressions.complaints
    ].join('|');

    for (var i = 0; i < source.length; i += 1) {
      seed = (seed + source.charCodeAt(i) * (i + 11)) >>> 0;
    }

    return seed;
  }

  function distribute(total, size, rng) {
    var values = [];
    var i;
    for (i = 0; i < size; i += 1) values.push(0);
    if (!total) return values;

    for (i = 0; i < total; i += 1) {
      var idx = Math.floor(rng() * size);
      if (idx < 0) idx = 0;
      if (idx >= size) idx = size - 1;
      values[idx] += 1;
    }

    return values;
  }

  function buildDelivery(summary, preset) {
    var seed = seedFromSummary(summary, preset) ^ 0xa53f1c9b;
    var rng = seededRng(seed);
    var sentDist = distribute(summary.sent_24h, 24, rng);
    var deliveredDist = distribute(summary.delivered_24h, 24, rng);
    var openedDist = distribute(summary.opened_24h, 24, rng);
    var clickedDist = distribute(summary.clicked_24h, 24, rng);
    var failedDist = distribute(summary.failed_24h, 24, rng);
    var complainedDist = distribute(summary.complained_24h, 24, rng);
    var now = new Date();
    now.setMinutes(0, 0, 0);

    var timeline = [];
    for (var i = 23; i >= 0; i -= 1) {
      var point = new Date(now.getTime() - i * 3600000);
      var idx = 23 - i;
      timeline.push({
        hour: point,
        sent: sentDist[idx],
        delivered: deliveredDist[idx],
        opened: openedDist[idx],
        clicked: clickedDist[idx],
        failed: failedDist[idx],
        complained: complainedDist[idx]
      });
    }

    function percent(num, den) {
      if (!den) return 0;
      return Math.round((num / den) * 1000) / 10;
    }

    return {
      rates: {
        delivery: percent(summary.delivered_24h, summary.sent_24h),
        open: percent(summary.opened_24h, summary.delivered_24h),
        click: percent(summary.clicked_24h, summary.delivered_24h),
        failure: percent(summary.failed_24h, summary.sent_24h),
        complaint: percent(summary.complained_24h, summary.delivered_24h)
      },
      timeline: timeline
    };
  }

  function buildSuppressions(summary, preset) {
    var seed = seedFromSummary(summary, preset) ^ 0x5c31a2ff;
    var rng = seededRng(seed);
    var domains = ['example.net', 'mail.test', 'inbox.sample'];
    var reasons = {
      bounces: [
        'Permanent bounce',
        'Mailbox unavailable',
        'Rejected by recipient domain'
      ],
      complaints: [
        'Spam complaint',
        'Feedback loop complaint',
        'Abuse report'
      ],
      unsubscribes: [
        'Unsubscribed by recipient',
        'Bulk opt-out request',
        'Preference center opt-out'
      ]
    };

    var totals = {
      bounces: summary.suppressions.bounces,
      complaints: summary.suppressions.complaints,
      unsubscribes: summary.suppressions.unsubscribes
    };

    var previewCaps = {
      bounces: Math.min(totals.bounces, 14),
      complaints: Math.min(totals.complaints, 10),
      unsubscribes: Math.min(totals.unsubscribes, 10)
    };

    var items = [];
    var typeKeys = ['bounces', 'complaints', 'unsubscribes'];
    var serial = 0;

    typeKeys.forEach(function (type) {
      var count = previewCaps[type];
      for (var i = 0; i < count; i += 1) {
        serial += 1;
        var localPart = 'recipient+' + (1000 + serial + Math.floor(rng() * 9000));
        var domain = domains[Math.floor(rng() * domains.length)];
        var minuteOffset = Math.floor(rng() * 60 * 24 * 7);
        var createdAt = new Date(Date.now() - minuteOffset * 60000).toISOString();
        var reasonSet = reasons[type];

        items.push({
          email: localPart + '@' + domain,
          type: type,
          reason: reasonSet[Math.floor(rng() * reasonSet.length)],
          created_at: createdAt
        });
      }
    });

    items.sort(function (a, b) {
      return b.created_at.localeCompare(a.created_at);
    });

    return {
      totals: totals,
      items: items
    };
  }

  function buildSettings(summary, health, preset) {
    var deliveryRate = summary.sent_24h ? summary.delivered_24h / summary.sent_24h : 0;
    var complaintRate = summary.delivered_24h ? summary.complained_24h / summary.delivered_24h : 0;

    return {
      values: [
        { key: 'Mode', value: 'Dashboard lab (mock data)' },
        { key: 'Scenario preset', value: preset },
        { key: 'Base path', value: state.basePath },
        { key: 'Polling interval', value: intervalEl.value === '0' ? 'manual' : (Math.round(parseInt(intervalEl.value, 10) / 1000) + ' seconds') },
        { key: 'Service', value: health.service || 'ghost-mail-bridge' },
        { key: 'Service status', value: health.status || 'unknown' }
      ],
      checks: [
        {
          name: 'Service healthy',
          status: health.status === 'ok' ? 'ok' : 'warn',
          detail: health.status === 'ok' ? 'All core signals are green' : 'Service reports degraded state'
        },
        {
          name: 'Poller running',
          status: health.poller && health.poller.isRunning ? 'ok' : 'warn',
          detail: health.poller && health.poller.isRunning ? 'Event poller loop active' : 'Poller loop is not running'
        },
        {
          name: 'Delivery rate',
          status: deliveryRate >= 0.95 ? 'ok' : 'warn',
          detail: Math.round(deliveryRate * 1000) / 10 + '% of sent emails were delivered'
        },
        {
          name: 'Complaint rate',
          status: complaintRate <= 0.002 ? 'ok' : 'warn',
          detail: Math.round(complaintRate * 1000) / 10 + '% of delivered emails were complaints'
        },
        {
          name: 'Recent poller errors',
          status: health.poller && health.poller.lastErrorMessage ? 'warn' : 'ok',
          detail: health.poller && health.poller.lastErrorMessage ? health.poller.lastErrorMessage : 'No recent poller errors'
        }
      ]
    };
  }

  function metricClass(label, value) {
    if (label.indexOf('Failed') === 0 || label.indexOf('Complained') === 0 || label.indexOf('Failure rate') === 0) {
      return value > 0 ? 'danger' : 'ok';
    }
    if (label.indexOf('Suppressed') === 0 || label.indexOf('Complaint rate') === 0) {
      return value > 0 ? 'warn' : 'ok';
    }
    return '';
  }

  function metricTone(label) {
    var lower = String(label || '').toLowerCase();
    if (lower.indexOf('failed') === 0 || lower.indexOf('failure') === 0) return 'tone-rose';
    if (lower.indexOf('complained') === 0 || lower.indexOf('complaint') === 0) return 'tone-orange';
    if (lower.indexOf('suppressed') === 0) return 'tone-amber';
    if (lower.indexOf('opened') === 0 || lower.indexOf('clicked') === 0 || lower.indexOf('open rate') === 0 || lower.indexOf('click rate') === 0) return 'tone-teal';
    if (lower.indexOf('delivered') === 0 || lower.indexOf('delivery rate') === 0) return 'tone-darkblue';
    return 'tone-blue';
  }

  function metricNumber(value) {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : 0;
    }
    var num = parseFloat(String(value).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(num) ? num : 0;
  }

  function metricSparkline(label, value) {
    var seed = 0;
    for (var i = 0; i < label.length; i += 1) {
      seed = (seed + (label.charCodeAt(i) * (i + 17))) >>> 0;
    }

    var numValue = metricNumber(value);
    var amplitude = numValue > 0 ? Math.min(6 + Math.log(numValue + 1) * 2.2, 11) : 4;
    var trend = numValue > 0 ? -0.35 : 0.12;
    var points = [];

    for (var p = 0; p < 12; p += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      var noise = ((seed & 0xffff) / 0xffff) - 0.5;
      var x = p * 10;
      var y = 24 + (trend * p) - (amplitude * noise);
      if (y < 7) y = 7;
      if (y > 29) y = 29;
      points.push(x.toFixed(1) + ',' + y.toFixed(1));
    }

    var areaPath = 'M' + points[0] + ' L' + points.slice(1).join(' L') + ' L110,32 L0,32 Z';

    return '<div class="metric-spark-wrap">' +
      '<svg class="metric-spark" viewBox="0 0 110 32" preserveAspectRatio="none" aria-hidden="true">' +
      '<line class="metric-spark-grid" x1="0" y1="8" x2="110" y2="8"></line>' +
      '<line class="metric-spark-grid" x1="0" y1="24" x2="110" y2="24"></line>' +
      '<path class="metric-spark-area" d="' + areaPath + '"></path>' +
      '<polyline class="metric-spark-line" points="' + points.join(' ') + '"></polyline>' +
      '</svg>' +
      '</div>';
  }

  function metric(label, value, suffix) {
    var cls = metricClass(label, value);
    var tone = metricTone(label);
    var display = suffix ? (value + suffix) : value;
    var classes = ['metric', tone];
    if (cls) classes.push('metric-' + cls);

    return '<article class="' + classes.join(' ') + '">' +
      '<div class="metric-head">' +
      '<div class="metric-label"><span class="metric-dot"></span>' + esc(label) + '</div>' +
      '<button class="metric-action" type="button">View more</button>' +
      '</div>' +
      '<div class="metric-value ' + cls + '">' + esc(display) + '</div>' +
      '<div class="metric-meta">Last 24 hours</div>' +
      metricSparkline(label, value) +
      '</article>';
  }

  function eventPill(eventType) {
    var eventName = esc(eventType || '');
    return '<span class="event-pill ' + eventName + '">' + eventName + '</span>';
  }

  function renderOverview() {
    var summary = state.summary;
    var health = state.health;

    overviewCardsEl.innerHTML = [
      metric('Sent (24h)', summary.sent_24h),
      metric('Delivered (24h)', summary.delivered_24h),
      metric('Opened (24h)', summary.opened_24h),
      metric('Clicked (24h)', summary.clicked_24h),
      metric('Failed (24h)', summary.failed_24h),
      metric('Complained (24h)', summary.complained_24h)
    ].join('');

    var alerts = [];
    var failureRate = summary.sent_24h ? summary.failed_24h / summary.sent_24h : 0;
    var complaintRate = summary.delivered_24h ? summary.complained_24h / summary.delivered_24h : 0;

    if (health.status !== 'ok') {
      alerts.push({ level: 'warn', text: 'Service status is ' + health.status + '.' });
    }
    if (failureRate > 0.05) {
      alerts.push({ level: 'danger', text: 'Failure rate is above 5%.' });
    }
    if (complaintRate > 0.002) {
      alerts.push({ level: 'warn', text: 'Complaint rate is above 0.2%.' });
    }
    if (health.poller && health.poller.lastErrorMessage) {
      alerts.push({ level: 'danger', text: 'Poller error: ' + health.poller.lastErrorMessage });
    }
    if (!alerts.length) {
      alerts.push({ level: 'ok', text: 'No active delivery alerts.' });
    }

    overviewMetaEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
    overviewAlertsEl.innerHTML = alerts.map(function (alert) {
      return '<li class="status-item">' +
        '<span>' + esc(alert.text) + '</span>' +
        '<span class="status-pill ' + esc(alert.level) + '">' + esc(alert.level) + '</span>' +
        '</li>';
    }).join('');

    var previewRows = state.failures.slice(0, 5);
    overviewFailureMetaEl.textContent = previewRows.length + ' rows';
    overviewFailureRowsEl.innerHTML = previewRows.map(function (row) {
      return '<tr>' +
        '<td>' + esc(fmtTime(row.timestamp)) + '</td>' +
        '<td>' + eventPill(row.event) + '</td>' +
        '<td class="mono">' + esc(row.recipient) + '</td>' +
        '<td>' + esc(row.reason || row.enhanced_code || '-') + '</td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="4">No recent failures.</td></tr>';
  }

  function renderDelivery() {
    var summary = state.summary;
    var delivery = state.delivery;

    deliveryCardsEl.innerHTML = [
      metric('Delivery rate', delivery.rates.delivery, '%'),
      metric('Open rate', delivery.rates.open, '%'),
      metric('Click rate', delivery.rates.click, '%'),
      metric('Failure rate', delivery.rates.failure, '%'),
      metric('Complaint rate', delivery.rates.complaint, '%'),
      metric('Sent (24h)', summary.sent_24h)
    ].join('');

    var maxSent = 1;
    delivery.timeline.forEach(function (row) {
      if (row.sent > maxSent) maxSent = row.sent;
    });

    deliveryRowsEl.innerHTML = delivery.timeline.map(function (row) {
      var hour = row.hour.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      var width = Math.round((row.sent / maxSent) * 100);
      return '<tr>' +
        '<td class="mono">' + esc(hour) + '</td>' +
        '<td>' + esc(row.sent) + '</td>' +
        '<td>' + esc(row.delivered) + '</td>' +
        '<td>' + esc(row.opened) + '</td>' +
        '<td>' + esc(row.clicked) + '</td>' +
        '<td>' + esc(row.failed) + '</td>' +
        '<td>' + esc(row.complained) + '</td>' +
        '<td><div class="bar-track"><div class="bar-fill" style="width:' + width + '%"></div></div></td>' +
        '</tr>';
    }).join('');
  }

  function filteredFailures() {
    var type = failureFilterEl.value || 'all';
    if (type === 'all') return state.failures.slice();
    return state.failures.filter(function (row) {
      return row.event === type;
    });
  }

  function renderFailures() {
    var rows = filteredFailures();
    var reasonCounts = {};

    rows.forEach(function (row) {
      var key = row.reason || row.enhanced_code || 'Unknown';
      reasonCounts[key] = (reasonCounts[key] || 0) + 1;
    });

    var reasonRows = Object.keys(reasonCounts).map(function (key) {
      return {
        reason: key,
        count: reasonCounts[key]
      };
    }).sort(function (a, b) {
      return b.count - a.count;
    });

    failureMetaEl.textContent = rows.length + ' rows';
    failureReasonRowsEl.innerHTML = reasonRows.map(function (row) {
      return '<tr><td>' + esc(row.reason) + '</td><td class="mono">' + esc(row.count) + '</td></tr>';
    }).join('') || '<tr><td colspan="2">No reasons available.</td></tr>';

    failureRowsEl.innerHTML = rows.map(function (row) {
      return '<tr>' +
        '<td>' + esc(fmtTime(row.timestamp)) + '</td>' +
        '<td>' + eventPill(row.event) + '</td>' +
        '<td class="mono">' + esc(row.recipient) + '</td>' +
        '<td>' + esc(row.reason || row.enhanced_code || '-') + '</td>' +
        '<td class="mono">' + esc(row.message_id || '-') + '</td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="5">No recent failed or complained events.</td></tr>';
  }

  function filteredSuppressions() {
    var type = suppressionFilterEl.value || 'all';
    if (type === 'all') return state.suppressions.slice();
    return state.suppressions.filter(function (row) {
      return row.type === type;
    });
  }

  function renderSuppressions() {
    var totals = state.suppressionTotals;
    var rows = filteredSuppressions();

    suppressionCardsEl.innerHTML = [
      metric('Suppressed bounces', totals.bounces),
      metric('Suppressed complaints', totals.complaints),
      metric('Suppressed unsubscribes', totals.unsubscribes)
    ].join('');

    suppressionMetaEl.textContent = rows.length + ' rows';
    suppressionRowsEl.innerHTML = rows.map(function (row) {
      return '<tr>' +
        '<td class="mono">' + esc(row.email) + '</td>' +
        '<td>' + esc(row.type) + '</td>' +
        '<td>' + esc(row.reason || '-') + '</td>' +
        '<td>' + esc(fmtIso(row.created_at)) + '</td>' +
        '<td><button type="button" class="table-action-btn" data-remove-email="' + esc(row.email) + '" data-remove-type="' + esc(row.type) + '">Remove</button></td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="5">No suppressions found.</td></tr>';
  }

  function renderQueue() {
    var health = state.health;
    var poller = health.poller || {};

    queueMetaEl.textContent = 'Updated ' + new Date().toLocaleTimeString();
    healthMetaEl.textContent = 'Updated ' + new Date().toLocaleTimeString();

    var rows = [
      ['Status', health.status || '-'],
      ['Poller running', poller.isRunning ? 'Yes' : 'No'],
      ['Last poll started', poller.lastPollStartedAt || '-'],
      ['Last poll finished', poller.lastPollFinishedAt || '-'],
      ['Last error at', poller.lastErrorAt || '-'],
      ['Last error message', poller.lastErrorMessage || '-'],
      ['Messages received (total)', poller.totalMessagesReceived === undefined ? '-' : String(poller.totalMessagesReceived)],
      ['Events stored (total)', poller.totalEventsStored === undefined ? '-' : String(poller.totalEventsStored)],
      ['Queue depth', 'Mock data'],
      ['DLQ depth', 'Mock data']
    ];

    queueRowsEl.innerHTML = rows.map(function (row) {
      return '<tr><td>' + esc(row[0]) + '</td><td class="mono">' + esc(row[1]) + '</td></tr>';
    }).join('');

    healthJsonEl.textContent = JSON.stringify(health, null, 2);
  }

  function renderSettings() {
    settingsRowsEl.innerHTML = state.settings.values.map(function (row) {
      return '<tr><td>' + esc(row.key) + '</td><td class="mono">' + esc(row.value) + '</td></tr>';
    }).join('');

    settingsCheckRowsEl.innerHTML = state.settings.checks.map(function (row) {
      return '<tr>' +
        '<td>' + esc(row.name) + '</td>' +
        '<td><span class="status-pill ' + esc(row.status) + '">' + esc(row.status) + '</span></td>' +
        '<td>' + esc(row.detail) + '</td>' +
        '</tr>';
    }).join('');
  }

  function renderAll() {
    renderOverview();
    renderDelivery();
    renderFailures();
    renderSuppressions();
    renderQueue();
    renderSettings();
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
    var response = await fetch(state.basePath + '/api/presets');
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
    var query = '?preset=' + encodeURIComponent(state.preset);

    try {
      setStatus('loading...');

      var responses = await Promise.all([
        fetch(state.basePath + '/api/summary' + query),
        fetch(state.basePath + '/api/health' + query),
        fetch(state.basePath + '/api/failures' + query + '&limit=80')
      ]);

      if (!responses[0].ok || !responses[1].ok || !responses[2].ok) {
        throw new Error('Dashboard API request failed');
      }

      state.summary = await responses[0].json();
      state.health = await responses[1].json();

      var failurePayload = await responses[2].json();
      state.failures = failurePayload.items || [];

      var suppressionData = buildSuppressions(state.summary, state.preset);
      state.suppressionTotals = suppressionData.totals;
      state.suppressions = suppressionData.items;
      state.delivery = buildDelivery(state.summary, state.preset);
      state.settings = buildSettings(state.summary, state.health, state.preset);

      renderAll();
      setStatus('loaded ' + new Date().toLocaleTimeString());
    } catch (err) {
      overviewCardsEl.innerHTML = metric('Error', 'Failed');
      healthJsonEl.textContent = String(err && err.message ? err.message : err);
      failureRowsEl.innerHTML = '<tr><td colspan="5">Failed to load</td></tr>';
      suppressionRowsEl.innerHTML = '<tr><td colspan="5">Failed to load</td></tr>';
      settingsRowsEl.innerHTML = '<tr><td colspan="2">Failed to load</td></tr>';
      settingsCheckRowsEl.innerHTML = '<tr><td colspan="3">Failed to load</td></tr>';
      setStatus('error');
    }
  }

  suppressionRowsEl.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.classList.contains('table-action-btn')) return;

    var email = target.getAttribute('data-remove-email') || '';
    var type = target.getAttribute('data-remove-type') || '';
    if (!email || !type) return;

    state.suppressions = state.suppressions.filter(function (row) {
      return !(row.email === email && row.type === type);
    });

    if (typeof state.suppressionTotals[type] === 'number' && state.suppressionTotals[type] > 0) {
      state.suppressionTotals[type] -= 1;
    }

    renderSuppressions();
    setStatus('suppression removed (mock)');
  });

  failureFilterEl.addEventListener('change', renderFailures);
  suppressionFilterEl.addEventListener('change', renderSuppressions);

  tabControls.forEach(function (control) {
    control.addEventListener('click', function (event) {
      event.preventDefault();
      setActiveTab(control.getAttribute('data-tab-target'), true);
    });
  });

  window.addEventListener('hashchange', function () {
    setActiveTab(window.location.hash, false);
  });

  presetEl.addEventListener('change', function () {
    state.preset = presetEl.value || 'healthy';
    load();
  });

  intervalEl.addEventListener('change', updateAutoRefresh);
  refreshBtn.addEventListener('click', load);

  (async function bootstrap() {
    state.basePath = getBasePath();
    await loadPresets();
    state.preset = presetEl.value || 'healthy';
    setActiveTab(window.location.hash || 'overview', false);
    updateAutoRefresh();
    load();
  })();
})();
