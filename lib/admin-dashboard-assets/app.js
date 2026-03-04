(function () {
  var runtimeConfig = window.__GMB_RUNTIME__ || {};
  var siteDomainEl = document.querySelector('.muted-link');
  var siteLinkEls = Array.prototype.slice.call(document.querySelectorAll('[data-site-link]'));
  var demoMode = (function () {
    try {
      var raw = new URLSearchParams(window.location.search || '').get('demo') || '';
      var value = String(raw).toLowerCase();
      return value === '1' || value === 'true' || value === 'yes';
    } catch (_err) {
      return false;
    }
  })();
  var autoRefreshEnabled = (function () {
    try {
      var raw = new URLSearchParams(window.location.search || '').get('refresh');
      if (raw === null || raw === undefined || raw === '') {
        return !demoMode;
      }
      var value = String(raw).toLowerCase();
      return !(value === '0' || value === 'false' || value === 'no' || value === 'off');
    } catch (_err) {
      return !demoMode;
    }
  })();

  var tabControls = Array.prototype.slice.call(document.querySelectorAll('[data-tab-target]'));
  var tabPanels = Array.prototype.slice.call(document.querySelectorAll('[data-tab-panel]'));
  var pageContentEl = document.querySelector('.page-content');
  var pageNavbarEl = document.querySelector('.page-navbar');
  var pageTitleEl = document.querySelector('.page-header h1');
  var periodSelectEl = document.getElementById('period-select');

  var overviewCardsEl = document.getElementById('overview-cards');
  var overviewAlertsEl = document.getElementById('overview-alerts');
  var overviewMetaEl = document.getElementById('overview-meta');
  var overviewFailureRowsEl = document.getElementById('overview-failure-rows');

  var deliveryInsightsEl = document.getElementById('delivery-insights');
  var deliveryRowsEl = document.getElementById('delivery-rows');
  var deliveryTimelineTitleEl = document.getElementById('delivery-timeline-title');
  var deliveryTimelineMetaEl = document.getElementById('delivery-timeline-meta');
  var deliveryTimelineColEl = document.getElementById('delivery-timeline-col');

  var failureFilterEl = document.getElementById('failure-filter');
  var failureMetaEl = document.getElementById('failure-meta');
  var failureReasonRowsEl = document.getElementById('failure-reason-rows');
  var failureRowsEl = document.getElementById('failure-rows');
  var failureInsightsEl = document.getElementById('failure-insights');

  var suppressionFilterEl = document.getElementById('suppression-filter');
  var suppressionMetaEl = document.getElementById('suppression-meta');
  var suppressionInsightsEl = document.getElementById('suppression-insights');
  var suppressionRowsEl = document.getElementById('suppression-rows');

  var healthMetaEl = document.getElementById('health-meta');
  var healthStatusPillEl = document.getElementById('health-status-pill');
  var healthRowsEl = document.getElementById('health-rows');
  var healthCheckRowsEl = document.getElementById('health-check-rows');
  var healthNavBadgeEl = document.getElementById('health-nav-badge');

  var timer = null;
  var REFRESH_MS = 15000;
  var state = {
    basePath: '',
    preset: 'healthy',
    activeTab: 'overview',
    summary: null,
    health: null,
    failures: [],
    delivery: null,
    period: periodSelectEl ? String(periodSelectEl.value || '30d') : '30d',
    deliveryMetric: 'delivery',
    failureMetric: 'failure',
    suppressionMetric: 'bounces',
    suppressionTotals: { bounces: 0, complaints: 0, unsubscribes: 0 },
    suppressions: []
  };
  var sparkUid = 0;

  function getBasePath() {
    if (runtimeConfig.basePath) {
      return String(runtimeConfig.basePath);
    }
    var path = window.location.pathname;
    if (path.endsWith('/index.html')) path = path.slice(0, -11);
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return path || '/ghost/mail';
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

  function domainFromUrl(value) {
    if (!value) return '';
    try {
      return new URL(String(value)).hostname || '';
    } catch (_err) {
      return '';
    }
  }

  function resolveSiteDomain() {
    var configured = String(runtimeConfig.siteDomain || '').trim();
    if (configured) return configured;

    var fromUrl = domainFromUrl(runtimeConfig.siteUrl);
    if (fromUrl) return fromUrl;

    return window.location.hostname || '';
  }

  function applyRuntimeSiteDomain() {
    if (!siteDomainEl) return;
    var domain = resolveSiteDomain();
    if (!domain) return;
    if (demoMode) {
      siteDomainEl.textContent = String(domain) + ' (demo data)';
      return;
    }
    siteDomainEl.textContent = String(domain);
  }

  function resolveSiteUrl() {
    var raw = String(runtimeConfig.siteUrl || runtimeConfig.siteDomain || '').trim();
    if (!raw) return window.location.origin || '/';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.indexOf('//') === 0) return 'https:' + raw;
    return 'https://' + raw.replace(/^\/+/, '');
  }

  function applyRuntimeSiteLinks() {
    if (!siteLinkEls.length) return;
    var siteUrl = resolveSiteUrl();
    siteLinkEls.forEach(function (el) {
      el.setAttribute('href', siteUrl);
    });
  }

  function emptySummary() {
    return {
      sent_24h: 0,
      delivered_24h: 0,
      opened_24h: 0,
      clicked_24h: 0,
      failed_24h: 0,
      complained_24h: 0,
      suppressions: {
        bounces: 0,
        complaints: 0,
        unsubscribes: 0
      }
    };
  }

  function normalizeSuppressionTotals(summary) {
    var suppressions = summary && summary.suppressions ? summary.suppressions : {};
    return {
      bounces: typeof suppressions.bounces === 'number' ? suppressions.bounces : 0,
      complaints: typeof suppressions.complaints === 'number' ? suppressions.complaints : 0,
      unsubscribes: typeof suppressions.unsubscribes === 'number' ? suppressions.unsubscribes : 0
    };
  }

  function normalizeTab(tab) {
    var value = String(tab || '').trim().replace(/^#/, '').replace(/^\//, '').toLowerCase();
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
    var isHealthView = target === 'health';

    tabPanels.forEach(function (panel) {
      panel.classList.toggle('active', panel.getAttribute('data-tab-panel') === target);
    });

    tabControls.forEach(function (control) {
      control.classList.toggle('active', control.getAttribute('data-tab-target') === target);
    });

    if (pageContentEl) {
      pageContentEl.classList.toggle('health-view', isHealthView);
    }
    if (pageNavbarEl) {
      pageNavbarEl.setAttribute('aria-hidden', isHealthView ? 'true' : 'false');
    }
    if (pageTitleEl) {
      pageTitleEl.textContent = isHealthView ? 'Health' : 'Email delivery';
    }

    if (state.summary) {
      if (target === 'delivery') {
        renderDelivery();
      } else if (target === 'failures') {
        renderFailures();
      } else if (target === 'suppressions') {
        renderSuppressions();
      }
    }

    if (updateHash) {
      var nextHash = '#/' + target;
      if (window.history && typeof window.history.replaceState === 'function') {
        window.history.replaceState(null, '', nextHash);
      } else {
        window.location.hash = nextHash;
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

  function getPeriodConfig(periodKey) {
    var now = new Date();
    var yearStart = new Date(now.getFullYear(), 0, 1);
    var ytdDays = Math.max(1, Math.ceil((now.getTime() - yearStart.getTime()) / 86400000));
    var presets = {
      '7d': { key: '7d', buckets: 7, stepHours: 24, label: 'Last 7 days', axisLabel: 'Date' },
      '30d': { key: '30d', buckets: 30, stepHours: 24, label: 'Last 30 days', axisLabel: 'Date' },
      '90d': { key: '90d', buckets: 90, stepHours: 24, label: 'Last 90 days', axisLabel: 'Date' },
      ytd: { key: 'ytd', buckets: ytdDays, stepHours: 24, label: 'Year to date', axisLabel: 'Date' },
      '12m': { key: '12m', buckets: 12, stepHours: 24 * 30, label: 'Last 12 months', axisLabel: 'Month' },
      all: { key: 'all', buckets: 24, stepHours: 24 * 30, label: 'All time', axisLabel: 'Month' }
    };

    return presets[periodKey] || presets['30d'];
  }

  function buildDelivery(summary, preset, periodKey) {
    var period = getPeriodConfig(periodKey);
    var seed = seedFromSummary(summary, preset) ^ 0xa53f1c9b;
    var rng = seededRng(seed);
    var sentDist = distribute(summary.sent_24h, period.buckets, rng);
    var deliveredDist = distribute(summary.delivered_24h, period.buckets, rng);
    var openedDist = distribute(summary.opened_24h, period.buckets, rng);
    var clickedDist = distribute(summary.clicked_24h, period.buckets, rng);
    var failedDist = distribute(summary.failed_24h, period.buckets, rng);
    var complainedDist = distribute(summary.complained_24h, period.buckets, rng);
    var now = new Date();
    now.setMinutes(0, 0, 0);

    var timeline = [];
    for (var i = period.buckets - 1; i >= 0; i -= 1) {
      var point = new Date(now.getTime() - i * period.stepHours * 3600000);
      var idx = (period.buckets - 1) - i;
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
      sent: summary.sent_24h,
      delivered: summary.delivered_24h,
      period: period,
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

  function metricClass(label, value) {
    if (label.indexOf('Failed') === 0 || label.indexOf('Complained') === 0 || label.indexOf('Failure rate') === 0) {
      return value > 0 ? 'danger' : 'ok';
    }
    if (label.indexOf('Suppressed') === 0 || label.indexOf('Suppression') === 0 || label.indexOf('Complaint rate') === 0) {
      return value > 0 ? 'warn' : 'ok';
    }
    return '';
  }

  function metricTone(label) {
    var lower = String(label || '').toLowerCase();
    if (lower.indexOf('failed') === 0 || lower.indexOf('failure') === 0) return 'tone-rose';
    if (lower.indexOf('complained') === 0 || lower.indexOf('complaint') === 0) return 'tone-orange';
    if (lower.indexOf('suppressed') === 0 || lower.indexOf('suppression') === 0) return 'tone-amber';
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
    var width = 110;
    var height = 56;
    var gridTop = 8;
    var gridBottom = 55;
    var plotTop = 12;
    var plotBottom = 51;
    var seed = 0;
    for (var i = 0; i < label.length; i += 1) {
      seed = (seed + (label.charCodeAt(i) * (i + 17))) >>> 0;
    }

    var numValue = metricNumber(value);
    var amplitude = numValue > 0 ? Math.min(6 + Math.log(numValue + 1) * 2.2, 11) : 4;
    var trend = numValue > 0 ? -0.35 : 0.12;
    var rawPoints = [];

    for (var p = 0; p < 12; p += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      var noise = ((seed & 0xffff) / 0xffff) - 0.5;
      var x = p * 10;
      var y = 24 + (trend * p) - (amplitude * noise);
      if (y < 7) y = 7;
      if (y > 29) y = 29;
      rawPoints.push({ x: x, y: y });
    }

    // Normalize each sparkline into a consistent vertical band so all cards keep visible area fill.
    var minY = Infinity;
    var maxY = -Infinity;
    for (var j = 0; j < rawPoints.length; j += 1) {
      if (rawPoints[j].y < minY) minY = rawPoints[j].y;
      if (rawPoints[j].y > maxY) maxY = rawPoints[j].y;
    }
    var span = Math.max(maxY - minY, 1);
    var targetTop = plotTop;
    var targetBottom = plotBottom;
    var points = rawPoints.map(function(point) {
      var normalizedY = targetTop + ((point.y - minY) / span) * (targetBottom - targetTop);
      return point.x.toFixed(1) + ',' + normalizedY.toFixed(1);
    });

    var period = getPeriodConfig(state.period || '30d');
    var now = new Date();
    now.setHours(0, 0, 0, 0);
    var spanMs = Math.max(period.buckets - 1, 1) * period.stepHours * 3600000;
    var start = new Date(now.getTime() - spanMs);

    function formatSparkLabel(date) {
      if (period.key === '12m' || period.key === 'all') {
        return date.toLocaleDateString([], { month: 'short', year: 'numeric' });
      }
      return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    var startLabel = formatSparkLabel(start);
    var endLabel = formatSparkLabel(now);

    sparkUid += 1;
    var chartId = 'spark-' + sparkUid.toString(36) + '-' + seed.toString(16);
    var areaPath = 'M' + points[0] + ' L' + points.slice(1).join(' L') + ' L' + width + ',' + gridBottom + ' L0,' + gridBottom + ' Z';

    return '<div class="metric-spark-wrap">' +
      '<svg class="metric-spark" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<defs>' +
      '<linearGradient id="' + chartId + '-area" gradientUnits="userSpaceOnUse" x1="0" y1="' + gridTop + '" x2="0" y2="' + gridBottom + '">' +
      '<stop offset="0%" stop-color="hsl(var(--spark-color))" stop-opacity="0.34"></stop>' +
      '<stop offset="70%" stop-color="hsl(var(--spark-color))" stop-opacity="0.12"></stop>' +
      '<stop offset="100%" stop-color="hsl(var(--spark-color))" stop-opacity="0"></stop>' +
      '</linearGradient>' +
      '</defs>' +
      '<line class="metric-spark-grid" x1="0" y1="' + gridTop + '" x2="' + width + '" y2="' + gridTop + '"></line>' +
      '<line class="metric-spark-grid" x1="0" y1="' + gridBottom + '" x2="' + width + '" y2="' + gridBottom + '"></line>' +
      '<path class="metric-spark-area" fill="url(#' + chartId + '-area)" d="' + areaPath + '"></path>' +
      '<polyline class="metric-spark-line" points="' + points.join(' ') + '"></polyline>' +
      '</svg>' +
      '<div class="metric-spark-axis">' +
      '<span class="metric-spark-axis-label">' + esc(startLabel) + '</span>' +
      '<span class="metric-spark-axis-label">' + esc(endLabel) + '</span>' +
      '</div>' +
      '</div>';
  }

  function metricIcon(viewTarget) {
    if (viewTarget === 'delivery') {
      return '<svg class="metric-icon lucide lucide-send-icon lucide-send" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"></path><path d="m21.854 2.147-10.94 10.939"></path></svg>';
    }
    if (viewTarget === 'failures') {
      return '<svg class="metric-icon lucide lucide-skull-icon lucide-skull" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12.5 17-.5-1-.5 1h1z"></path><path d="M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z"></path><circle cx="15" cy="12" r="1"></circle><circle cx="9" cy="12" r="1"></circle></svg>';
    }
    if (viewTarget === 'suppressions') {
      return '<svg class="metric-icon lucide lucide-fire-extinguisher-icon lucide-fire-extinguisher" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6.5V3a1 1 0 0 0-1-1h-2a1 1 0 0 0-1 1v3.5"></path><path d="M9 18h8"></path><path d="M18 3h-3"></path><path d="M11 3a6 6 0 0 0-6 6v11"></path><path d="M5 13h4"></path><path d="M17 10a4 4 0 0 0-8 0v10a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2Z"></path></svg>';
    }
    return '';
  }

  function metric(label, value, suffix, viewTarget) {
    var cls = metricClass(label, value);
    var tone = metricTone(label);
    var display = suffix ? (value + suffix) : value;
    var classes = ['metric', tone];
    var actionAttr = viewTarget ? ' data-view-target="' + esc(viewTarget) + '"' : '';
    var icon = metricIcon(viewTarget);
    if (cls) classes.push('metric-' + cls);

    return '<article class="' + classes.join(' ') + '">' +
      '<div class="metric-head">' +
      '<div class="metric-label">' + (icon || '<span class="metric-dot"></span>') + esc(label) + '</div>' +
      '<button class="metric-action" type="button"' + actionAttr + '>View more</button>' +
      '</div>' +
      '<div class="metric-value ' + cls + '">' + esc(display) + '</div>' +
      metricSparkline(label, value) +
      '</article>';
  }

  function insightsChartHeight() {
    var viewport = window.innerWidth || document.documentElement.clientWidth || 1280;
    if (viewport <= 720) return 196;
    if (viewport <= 800) return 220;
    return 208;
  }

  function insightsChartDimensions(hostEl) {
    var width = 760;
    if (hostEl && hostEl.clientWidth) {
      width = Math.max(420, Math.round(hostEl.clientWidth - 20));
    }
    return { width: width, height: insightsChartHeight() };
  }

  function formatRate(value) {
    var num = Number(value);
    if (!Number.isFinite(num)) return '0%';
    var rounded = Math.round(num * 10) / 10;
    if (Math.abs(rounded - Math.round(rounded)) < 0.001) {
      return String(Math.round(rounded)) + '%';
    }
    return rounded.toFixed(1) + '%';
  }

  function deliveryMetricTabs(delivery) {
    var metrics = [
      {
        key: 'delivery',
        label: 'Delivered',
        labelMeta: 'Sent ' + formatCount(delivery.sent),
        colorVar: 'var(--chart-darkblue)',
        value: delivery.delivered,
        chartValue: delivery.rates.delivery,
        displayType: 'count'
      },
      { key: 'open', label: 'Avg. open rate', colorVar: 'var(--chart-blue)', value: delivery.rates.open },
      { key: 'click', label: 'Avg. click rate', colorVar: 'var(--chart-teal)', value: delivery.rates.click }
    ];

    var activeKey = state.deliveryMetric || 'delivery';
    var active = metrics[0];
    metrics.forEach(function (metricTab) {
      if (metricTab.key === activeKey) active = metricTab;
    });

    return { metrics: metrics, active: active };
  }

  function deliveryMetricSeries(delivery, metricKey) {
    var timeline = Array.isArray(delivery.timeline) ? delivery.timeline : [];
    var points = [];
    var sent = 0;
    var delivered = 0;
    var opened = 0;
    var clicked = 0;

    timeline.forEach(function (row, idx) {
      sent += row.sent || 0;
      delivered += row.delivered || 0;
      opened += row.opened || 0;
      clicked += row.clicked || 0;

      var value = 0;
      if (metricKey === 'delivery') {
        value = sent ? (delivered / sent) * 100 : 0;
      } else if (metricKey === 'open') {
        value = delivered ? (opened / delivered) * 100 : 0;
      } else if (metricKey === 'click') {
        value = delivered ? (clicked / delivered) * 100 : 0;
      }

      if (!Number.isFinite(value)) value = 0;
      points.push({ idx: idx, value: Math.max(0, Math.min(100, value)) });
    });

    return points;
  }

  function deliveryMetricBars(delivery, metricKey) {
    var timeline = Array.isArray(delivery.timeline) ? delivery.timeline : [];
    if (!timeline.length) return [];

    var buckets = [];
    var bucketSize = 2;
    for (var i = 0; i < timeline.length; i += bucketSize) {
      var delivered = 0;
      var opened = 0;
      var clicked = 0;

      for (var j = i; j < i + bucketSize && j < timeline.length; j += 1) {
        delivered += timeline[j].delivered || 0;
        opened += timeline[j].opened || 0;
        clicked += timeline[j].clicked || 0;
      }

      var value = 0;
      if (metricKey === 'open') {
        value = delivered ? (opened / delivered) * 100 : 0;
      } else if (metricKey === 'click') {
        value = delivered ? (clicked / delivered) * 100 : 0;
      }

      if (!Number.isFinite(value)) value = 0;
      buckets.push({ idx: buckets.length, value: Math.max(0, Math.min(100, value)) });
    }

    return buckets;
  }

  function deliveryInsightsChart(delivery, activeMetric, dims) {
    var width = dims && dims.width ? dims.width : 760;
    var height = dims && dims.height ? dims.height : 236;
    var chartLeft = 46;
    var chartRight = 16;
    var chartTop = 24;
    var chartBottom = 42;
    var plotWidth = width - chartLeft - chartRight;
    var plotHeight = height - chartTop - chartBottom;
    var currentRate = Number(
      activeMetric.chartValue === undefined ? activeMetric.value : activeMetric.chartValue
    ) || 0;
    var firstHour = delivery.timeline[0] ? delivery.timeline[0].hour : null;
    var lastHour = delivery.timeline[delivery.timeline.length - 1] ? delivery.timeline[delivery.timeline.length - 1].hour : null;
    var firstLabel = firstHour ? firstHour.toLocaleDateString([], { month: 'short', day: 'numeric' }) : '-';
    var lastLabel = lastHour ? lastHour.toLocaleDateString([], { month: 'short', day: 'numeric' }) : '-';

    function yFor(value, axisMin, axisMax) {
      var ratio = (axisMax - value) / Math.max(axisMax - axisMin, 0.0001);
      return chartTop + (ratio * plotHeight);
    }

    if (activeMetric.key === 'delivery') {
      var series = deliveryMetricSeries(delivery, activeMetric.key);
      if (!series.length) return '';

      var values = series.map(function (point) { return point.value; });
      values.push(currentRate);

      var minValue = Math.min.apply(null, values);
      var maxValue = Math.max.apply(null, values);
      var span = maxValue - minValue;
      var padding = Math.max(span * 0.22, 0.8);
      var axisMin = Math.max(0, minValue - padding);
      var axisMax = Math.min(100, maxValue + padding);

      if (axisMax - axisMin < 1.8) {
        axisMax = Math.min(100, axisMax + 0.9);
        axisMin = Math.max(0, axisMin - 0.9);
      }

      var linePoints = series.map(function (point, idx) {
        var x = chartLeft + ((plotWidth * idx) / Math.max(series.length - 1, 1));
        var y = yFor(point.value, axisMin, axisMax);
        return x.toFixed(2) + ',' + y.toFixed(2);
      });

      var pathBottom = chartTop + plotHeight;
      var areaPath = 'M' + linePoints[0] +
        ' L' + linePoints.slice(1).join(' L') +
        ' L' + (chartLeft + plotWidth).toFixed(2) + ',' + pathBottom.toFixed(2) +
        ' L' + chartLeft.toFixed(2) + ',' + pathBottom.toFixed(2) +
        ' Z';

      sparkUid += 1;
      var gradientId = 'delivery-insight-' + sparkUid.toString(36);
      var midValue = axisMin + ((axisMax - axisMin) / 2);
      var xLabelY = Math.min(height - 8, pathBottom + 18);

      return '<div class="delivery-insights-chart-wrap">' +
        '<svg class="delivery-insights-chart" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true">' +
        '<defs>' +
        '<linearGradient id="' + gradientId + '" gradientUnits="userSpaceOnUse" x1="0" y1="' + chartTop + '" x2="0" y2="' + (chartTop + plotHeight) + '">' +
        '<stop offset="0%" stop-color="hsl(var(--delivery-chart-color))" stop-opacity="0.30"></stop>' +
        '<stop offset="86%" stop-color="hsl(var(--delivery-chart-color))" stop-opacity="0.08"></stop>' +
        '<stop offset="100%" stop-color="hsl(var(--delivery-chart-color))" stop-opacity="0"></stop>' +
        '</linearGradient>' +
        '</defs>' +
        '<line class="delivery-insights-grid" x1="' + chartLeft + '" y1="' + chartTop + '" x2="' + (chartLeft + plotWidth) + '" y2="' + chartTop + '"></line>' +
        '<line class="delivery-insights-grid" x1="' + chartLeft + '" y1="' + yFor(midValue, axisMin, axisMax).toFixed(2) + '" x2="' + (chartLeft + plotWidth) + '" y2="' + yFor(midValue, axisMin, axisMax).toFixed(2) + '"></line>' +
        '<line class="delivery-insights-grid" x1="' + chartLeft + '" y1="' + pathBottom + '" x2="' + (chartLeft + plotWidth) + '" y2="' + pathBottom + '"></line>' +
        '<text class="delivery-insights-y-label" x="' + (chartLeft - 8) + '" y="' + chartTop + '" text-anchor="end" dominant-baseline="middle">' + esc(formatRate(axisMax)) + '</text>' +
        '<text class="delivery-insights-y-label" x="' + (chartLeft - 8) + '" y="' + yFor(midValue, axisMin, axisMax).toFixed(2) + '" text-anchor="end" dominant-baseline="middle">' + esc(formatRate(midValue)) + '</text>' +
        '<text class="delivery-insights-y-label" x="' + (chartLeft - 8) + '" y="' + pathBottom + '" text-anchor="end" dominant-baseline="middle">' + esc(formatRate(axisMin)) + '</text>' +
        '<path class="delivery-insights-area" fill="url(#' + gradientId + ')" d="' + areaPath + '"></path>' +
        '<polyline class="delivery-insights-line" points="' + linePoints.join(' ') + '"></polyline>' +
        '<text class="delivery-insights-x-label" x="' + chartLeft + '" y="' + xLabelY.toFixed(2) + '" text-anchor="start">' + esc(firstLabel) + '</text>' +
        '<text class="delivery-insights-x-label" x="' + (chartLeft + plotWidth) + '" y="' + xLabelY.toFixed(2) + '" text-anchor="end">' + esc(lastLabel) + '</text>' +
        '</svg>' +
        '</div>';
    }

    var bars = deliveryMetricBars(delivery, activeMetric.key);
    if (!bars.length) return '';

    var barValues = bars.map(function (point) { return point.value; });
    barValues.push(currentRate);
    var maxBarValue = Math.max.apply(null, barValues);
    var minBarValue = Math.min.apply(null, barValues);
    var axisMinBar = activeMetric.key === 'click'
      ? 0
      : Math.max(0, Math.floor((Math.min(minBarValue, currentRate) - 8) / 5) * 5);
    var axisMaxBar = Math.min(100, Math.ceil((Math.max(maxBarValue, currentRate) + 4) / 5) * 5);

    if (activeMetric.key === 'open') {
      axisMinBar = Math.max(0, Math.min(axisMinBar, Math.floor(currentRate / 10) * 10));
      axisMaxBar = Math.max(axisMaxBar, Math.ceil(currentRate / 10) * 10 + 10);
    } else {
      axisMaxBar = Math.max(axisMaxBar, 30);
    }

    if (axisMaxBar - axisMinBar < 10) axisMaxBar = Math.min(100, axisMinBar + 10);

    var pathBottomBar = chartTop + plotHeight;
    var refY = yFor(currentRate, axisMinBar, axisMaxBar);
    var barStep = plotWidth / bars.length;
    var barWidth = Math.min(30, barStep * 0.36);

    sparkUid += 1;
    var barGradientId = 'delivery-bars-' + sparkUid.toString(36);

    var barRects = bars.map(function (bar, index) {
      var x = chartLeft + (barStep * index) + ((barStep - barWidth) / 2);
      var y = yFor(bar.value, axisMinBar, axisMaxBar);
      var h = Math.max(1, pathBottomBar - y);
      return '<rect class="delivery-insights-bar" x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + barWidth.toFixed(2) + '" height="' + h.toFixed(2) + '" rx="4" fill="url(#' + barGradientId + ')"></rect>';
    }).join('');

    var caption = activeMetric.key === 'open'
      ? 'Newsletters opens in this period'
      : 'Newsletters clicks in this period';

    return '<div class="delivery-insights-chart-wrap">' +
      '<svg class="delivery-insights-chart" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<defs>' +
      '<linearGradient id="' + barGradientId + '" gradientUnits="userSpaceOnUse" x1="0" y1="' + chartTop + '" x2="0" y2="' + pathBottomBar + '">' +
      '<stop offset="0%" stop-color="hsl(var(--delivery-chart-color))" stop-opacity="0.46"></stop>' +
      '<stop offset="100%" stop-color="hsl(var(--delivery-chart-color))" stop-opacity="0.38"></stop>' +
      '</linearGradient>' +
      '</defs>' +
      '<line class="delivery-insights-grid" x1="' + chartLeft + '" y1="' + chartTop + '" x2="' + (chartLeft + plotWidth) + '" y2="' + chartTop + '"></line>' +
      '<line class="delivery-insights-grid" x1="' + chartLeft + '" y1="' + refY.toFixed(2) + '" x2="' + (chartLeft + plotWidth) + '" y2="' + refY.toFixed(2) + '"></line>' +
      '<line class="delivery-insights-grid" x1="' + chartLeft + '" y1="' + pathBottomBar + '" x2="' + (chartLeft + plotWidth) + '" y2="' + pathBottomBar + '"></line>' +
      '<line class="delivery-insights-reference" x1="' + chartLeft + '" y1="' + refY.toFixed(2) + '" x2="' + (chartLeft + plotWidth) + '" y2="' + refY.toFixed(2) + '"></line>' +
      '<text class="delivery-insights-y-label" x="' + (chartLeft - 8) + '" y="' + chartTop + '" text-anchor="end" dominant-baseline="middle">' + esc(formatRate(axisMaxBar)) + '</text>' +
      '<text class="delivery-insights-y-label" x="' + (chartLeft - 8) + '" y="' + refY.toFixed(2) + '" text-anchor="end" dominant-baseline="middle">' + esc(formatRate(currentRate)) + '</text>' +
      '<text class="delivery-insights-y-label" x="' + (chartLeft - 8) + '" y="' + pathBottomBar + '" text-anchor="end" dominant-baseline="middle">' + esc(formatRate(axisMinBar)) + '</text>' +
      barRects +
      '<text class="delivery-insights-caption" x="' + (chartLeft + (plotWidth / 2)).toFixed(2) + '" y="' + (height - 8) + '" text-anchor="middle">' + esc(caption) + '</text>' +
      '</svg>' +
      '</div>';
  }

  function renderDeliveryInsights(delivery) {
    var tabs = deliveryMetricTabs(delivery);
    var dims = insightsChartDimensions(deliveryInsightsEl);
    state.deliveryMetric = tabs.active.key;

    return '<div class="delivery-insights-shell" style="--delivery-chart-color: ' + tabs.active.colorVar + ';">' +
      '<div class="delivery-insights-tabs" role="tablist" aria-label="Delivery metrics">' +
      tabs.metrics.map(function (tab) {
        var isActive = tab.key === tabs.active.key;
        var labelMeta = tab.labelMeta
          ? '<span class="delivery-insights-tab-label-meta">' + esc(tab.labelMeta) + '</span>'
          : '';
        return '<button type="button" class="delivery-insights-tab' + (isActive ? ' active' : '') + '"' +
          ' role="tab" data-delivery-metric="' + esc(tab.key) + '"' +
          ' aria-selected="' + (isActive ? 'true' : 'false') + '">' +
          '<span class="delivery-insights-tab-label">' +
          '<span class="delivery-insights-dot" style="background: hsl(' + tab.colorVar + ');"></span>' +
          '<span class="delivery-insights-tab-label-text">' + esc(tab.label) + '</span>' +
          labelMeta +
          '</span>' +
          '<span class="delivery-insights-tab-value">' +
          esc(tab.displayType === 'count' ? formatCount(tab.value) : formatRate(tab.value)) +
          '</span>' +
          (tab.detail ? '<span class="delivery-insights-tab-detail">' + esc(tab.detail) + '</span>' : '') +
          '</button>';
      }).join('') +
      '</div>' +
      deliveryInsightsChart(delivery, tabs.active, dims) +
      '</div>';
  }

  function formatCount(value) {
    var num = Number(value);
    if (!Number.isFinite(num)) return '0';
    return Math.max(0, Math.round(num)).toLocaleString();
  }

  function timelineDateLabels(timeline) {
    var list = Array.isArray(timeline) ? timeline : [];
    var firstHour = list[0] ? list[0].hour : null;
    var lastHour = list[list.length - 1] ? list[list.length - 1].hour : null;
    return {
      first: firstHour ? firstHour.toLocaleDateString([], { month: 'short', day: 'numeric' }) : '-',
      last: lastHour ? lastHour.toLocaleDateString([], { month: 'short', day: 'numeric' }) : '-'
    };
  }

  function formatTimelinePoint(date, period) {
    if (!date || !(date instanceof Date)) return '-';
    var key = period && period.key ? period.key : '30d';
    if (key === '12m' || key === 'all') {
      return date.toLocaleDateString([], { month: 'short', year: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function failureLineSeries(delivery, metricKey) {
    var timeline = Array.isArray(delivery.timeline) ? delivery.timeline : [];
    var numerator = 0;
    var denominator = 0;

    return timeline.map(function (row, idx) {
      if (metricKey === 'failure') {
        numerator += row.failed || 0;
        denominator += row.sent || 0;
      } else {
        numerator += row.complained || 0;
        denominator += row.delivered || 0;
      }

      var value = denominator ? (numerator / denominator) * 100 : 0;
      if (!Number.isFinite(value)) value = 0;
      return { idx: idx, value: Math.max(0, value) };
    });
  }

  function suppressionLineSeries(type) {
    var deliveryTimeline = state.delivery && Array.isArray(state.delivery.timeline)
      ? state.delivery.timeline
      : [];
    if (!deliveryTimeline.length) return [];

    var startMs = deliveryTimeline[0].hour.getTime();
    var hourMs = 3600000;
    var buckets = deliveryTimeline.map(function () { return 0; });

    state.suppressions.forEach(function (row) {
      if (!row || row.type !== type) return;
      var ts = Date.parse(row.created_at || '');
      if (!Number.isFinite(ts)) return;
      var idx = Math.floor((ts - startMs) / hourMs);
      if (idx < 0 || idx >= buckets.length) return;
      buckets[idx] += 1;
    });

    var running = 0;
    return buckets.map(function (count, idx) {
      running += count;
      return { idx: idx, value: running };
    });
  }

  function renderLineInsightsChart(series, options, dims) {
    if (!series || !series.length) return '';

    var width = dims && dims.width ? dims.width : 760;
    var height = dims && dims.height ? dims.height : 236;
    var chartLeft = 46;
    var chartRight = 16;
    var chartTop = 24;
    var chartBottom = 42;
    var plotWidth = width - chartLeft - chartRight;
    var plotHeight = height - chartTop - chartBottom;
    var formatter = options && typeof options.formatter === 'function' ? options.formatter : formatCount;
    var labels = options && options.labels ? options.labels : { first: '-', last: '-' };
    var minZero = options && options.minZero;
    var values = series.map(function (point) {
      return Number(point.value) || 0;
    });

    var minValue = Math.min.apply(null, values);
    var maxValue = Math.max.apply(null, values);
    var span = maxValue - minValue;
    var axisMin = minZero ? 0 : Math.max(0, minValue - Math.max(span * 0.2, 0.6));
    var axisMax = Math.max(axisMin + 1, maxValue + Math.max(span * 0.2, 0.8));

    if (minZero) {
      axisMax = Math.max(1, axisMax);
    }

    function yFor(value) {
      var ratio = (axisMax - value) / Math.max(axisMax - axisMin, 0.0001);
      return chartTop + (ratio * plotHeight);
    }

    var linePoints = series.map(function (point, idx) {
      var x = chartLeft + ((plotWidth * idx) / Math.max(series.length - 1, 1));
      var y = yFor(Number(point.value) || 0);
      return x.toFixed(2) + ',' + y.toFixed(2);
    });

    var pathBottom = chartTop + plotHeight;
    var areaPath = 'M' + linePoints[0] +
      ' L' + linePoints.slice(1).join(' L') +
      ' L' + (chartLeft + plotWidth).toFixed(2) + ',' + pathBottom.toFixed(2) +
      ' L' + chartLeft.toFixed(2) + ',' + pathBottom.toFixed(2) +
      ' Z';

    sparkUid += 1;
    var gradientId = 'line-insight-' + sparkUid.toString(36);
    var midValue = axisMin + ((axisMax - axisMin) / 2);
    var xLabelY = Math.min(height - 8, pathBottom + 18);

    return '<div class="delivery-insights-chart-wrap">' +
      '<svg class="delivery-insights-chart" viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<defs>' +
      '<linearGradient id="' + gradientId + '" gradientUnits="userSpaceOnUse" x1="0" y1="' + chartTop + '" x2="0" y2="' + (chartTop + plotHeight) + '">' +
      '<stop offset="0%" stop-color="hsl(var(--delivery-chart-color))" stop-opacity="0.30"></stop>' +
      '<stop offset="86%" stop-color="hsl(var(--delivery-chart-color))" stop-opacity="0.08"></stop>' +
      '<stop offset="100%" stop-color="hsl(var(--delivery-chart-color))" stop-opacity="0"></stop>' +
      '</linearGradient>' +
      '</defs>' +
      '<line class="delivery-insights-grid" x1="' + chartLeft + '" y1="' + chartTop + '" x2="' + (chartLeft + plotWidth) + '" y2="' + chartTop + '"></line>' +
      '<line class="delivery-insights-grid" x1="' + chartLeft + '" y1="' + yFor(midValue).toFixed(2) + '" x2="' + (chartLeft + plotWidth) + '" y2="' + yFor(midValue).toFixed(2) + '"></line>' +
      '<line class="delivery-insights-grid" x1="' + chartLeft + '" y1="' + pathBottom + '" x2="' + (chartLeft + plotWidth) + '" y2="' + pathBottom + '"></line>' +
      '<text class="delivery-insights-y-label" x="' + (chartLeft - 8) + '" y="' + chartTop + '" text-anchor="end" dominant-baseline="middle">' + esc(formatter(axisMax)) + '</text>' +
      '<text class="delivery-insights-y-label" x="' + (chartLeft - 8) + '" y="' + yFor(midValue).toFixed(2) + '" text-anchor="end" dominant-baseline="middle">' + esc(formatter(midValue)) + '</text>' +
      '<text class="delivery-insights-y-label" x="' + (chartLeft - 8) + '" y="' + pathBottom + '" text-anchor="end" dominant-baseline="middle">' + esc(formatter(axisMin)) + '</text>' +
      '<path class="delivery-insights-area" fill="url(#' + gradientId + ')" d="' + areaPath + '"></path>' +
      '<polyline class="delivery-insights-line" points="' + linePoints.join(' ') + '"></polyline>' +
      '<text class="delivery-insights-x-label" x="' + chartLeft + '" y="' + xLabelY.toFixed(2) + '" text-anchor="start">' + esc(labels.first) + '</text>' +
      '<text class="delivery-insights-x-label" x="' + (chartLeft + plotWidth) + '" y="' + xLabelY.toFixed(2) + '" text-anchor="end">' + esc(labels.last) + '</text>' +
      '</svg>' +
      '</div>';
  }

  function renderFailureInsights(delivery) {
    var metrics = [
      { key: 'failure', label: 'Failure rate', colorVar: 'var(--chart-rose)', value: delivery.rates.failure },
      { key: 'complaint', label: 'Complaint rate', colorVar: 'var(--chart-orange)', value: delivery.rates.complaint }
    ];
    var activeKey = state.failureMetric || 'failure';
    var activeMetric = metrics[0];
    metrics.forEach(function (metricTab) {
      if (metricTab.key === activeKey) activeMetric = metricTab;
    });
    state.failureMetric = activeMetric.key;

    var labels = timelineDateLabels(delivery.timeline);
    var dims = insightsChartDimensions(failureInsightsEl);
    var chart = renderLineInsightsChart(failureLineSeries(delivery, activeMetric.key), {
      formatter: formatRate,
      labels: labels,
      minZero: true
    }, dims);

    return '<div class="delivery-insights-shell" style="--delivery-chart-color: ' + activeMetric.colorVar + ';">' +
      '<div class="delivery-insights-tabs" role="tablist" aria-label="Failure metrics">' +
      metrics.map(function (tab) {
        var isActive = tab.key === activeMetric.key;
        return '<button type="button" class="delivery-insights-tab' + (isActive ? ' active' : '') + '"' +
          ' role="tab" data-failure-metric="' + esc(tab.key) + '"' +
          ' aria-selected="' + (isActive ? 'true' : 'false') + '">' +
          '<span class="delivery-insights-tab-label">' +
          '<span class="delivery-insights-dot" style="background: hsl(' + tab.colorVar + ');"></span>' +
          esc(tab.label) +
          '</span>' +
          '<span class="delivery-insights-tab-value">' + esc(formatRate(tab.value)) + '</span>' +
          '</button>';
      }).join('') +
      '</div>' +
      chart +
      '</div>';
  }

  function renderSuppressionInsights() {
    var totals = state.suppressionTotals || { bounces: 0, complaints: 0, unsubscribes: 0 };
    var metrics = [
      { key: 'bounces', label: 'Bounces', colorVar: 'var(--chart-amber)', value: totals.bounces },
      { key: 'complaints', label: 'Complaints', colorVar: 'var(--chart-orange)', value: totals.complaints },
      { key: 'unsubscribes', label: 'Unsubscribes', colorVar: 'var(--chart-teal)', value: totals.unsubscribes }
    ];
    var activeKey = state.suppressionMetric || 'bounces';
    var activeMetric = metrics[0];
    metrics.forEach(function (metricTab) {
      if (metricTab.key === activeKey) activeMetric = metricTab;
    });
    state.suppressionMetric = activeMetric.key;

    var labels = timelineDateLabels(state.delivery && state.delivery.timeline ? state.delivery.timeline : []);
    var dims = insightsChartDimensions(suppressionInsightsEl);
    var chart = renderLineInsightsChart(suppressionLineSeries(activeMetric.key), {
      formatter: formatCount,
      labels: labels,
      minZero: true
    }, dims);

    return '<div class="delivery-insights-shell" style="--delivery-chart-color: ' + activeMetric.colorVar + ';">' +
      '<div class="delivery-insights-tabs" role="tablist" aria-label="Suppression metrics">' +
      metrics.map(function (tab) {
        var isActive = tab.key === activeMetric.key;
        return '<button type="button" class="delivery-insights-tab' + (isActive ? ' active' : '') + '"' +
          ' role="tab" data-suppression-metric="' + esc(tab.key) + '"' +
          ' aria-selected="' + (isActive ? 'true' : 'false') + '">' +
          '<span class="delivery-insights-tab-label">' +
          '<span class="delivery-insights-dot" style="background: hsl(' + tab.colorVar + ');"></span>' +
          esc(tab.label) +
          '</span>' +
          '<span class="delivery-insights-tab-value">' + esc(formatCount(tab.value)) + '</span>' +
          '</button>';
      }).join('') +
      '</div>' +
      chart +
      '</div>';
  }

  function eventPill(eventType) {
    var eventName = esc(eventType || '');
    return '<span class="event-pill ' + eventName + '">' + eventName + '</span>';
  }

  function rawFailureReason(row) {
    if (!row) return '';
    return String(row.reason || row.enhanced_code || '').trim();
  }

  function humanizeFailureReason(row) {
    var raw = rawFailureReason(row);
    var event = String((row && row.event) || '').toLowerCase();

    if (!raw) {
      if (event === 'complained') return 'Recipient reported spam';
      return 'Unknown delivery issue';
    }

    var lower = raw.toLowerCase();

    if (lower.indexOf('not authorized to perform') !== -1 && lower.indexOf('ses:sendrawemail') !== -1) {
      if (lower.indexOf(':configuration-set/') !== -1) {
        return 'Missing AWS permission for SES configuration set';
      }
      if (lower.indexOf(':identity/') !== -1) {
        return 'Missing AWS permission for SES identity';
      }
      return 'Missing AWS permission to send with SES';
    }

    if (lower.indexOf('configuration set') !== -1 && lower.indexOf('does not exist') !== -1) {
      return 'SES configuration set not found';
    }
    if (lower.indexOf('not verified') !== -1 && lower.indexOf('identity') !== -1) {
      return 'SES identity is not verified';
    }
    if (lower.indexOf('mailbox unavailable') !== -1 || lower.indexOf('user unknown') !== -1 || lower.indexOf('invalid mailbox') !== -1) {
      return 'Recipient mailbox unavailable';
    }
    if (lower.indexOf('complaint') !== -1 || event === 'complained') {
      return 'Recipient reported spam';
    }
    if (lower.indexOf('throttl') !== -1 || lower.indexOf('rate exceeded') !== -1) {
      return 'Sending rate limited by provider';
    }
    if (lower.indexOf('timeout') !== -1 || lower.indexOf('timed out') !== -1) {
      return 'Temporary timeout from provider';
    }
    if (lower.indexOf('greylist') !== -1 || lower.indexOf('temporarily deferred') !== -1) {
      return 'Recipient server temporarily deferred message';
    }

    if (raw.length > 96) return raw.slice(0, 93) + '...';
    return raw;
  }

  function failureReasonHtml(row) {
    var human = humanizeFailureReason(row);
    var raw = rawFailureReason(row);
    if (!raw || raw === human) return esc(human || '-');
    return '<span title="' + esc(raw) + '">' + esc(human) + '</span>';
  }

  function renderOverview() {
    var summary = state.summary;
    var health = state.health;
    var delivery = state.delivery || buildDelivery(summary, state.preset, state.period);
    var suppressionTotals = normalizeSuppressionTotals(summary);
    var totalSuppressions = suppressionTotals.bounces + suppressionTotals.complaints + suppressionTotals.unsubscribes;

    overviewCardsEl.innerHTML = [
      metric('Sent', summary.sent_24h, null, 'delivery'),
      metric('Failure rate', delivery.rates.failure, '%', 'failures'),
      metric('Suppressions', totalSuppressions, null, 'suppressions')
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
    overviewFailureRowsEl.innerHTML = previewRows.map(function (row) {
      return '<tr>' +
        '<td>' + esc(fmtTime(row.timestamp)) + '</td>' +
        '<td>' + eventPill(row.event) + '</td>' +
        '<td class="mono">' + esc(row.recipient) + '</td>' +
        '<td>' + failureReasonHtml(row) + '</td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="4">No recent failures.</td></tr>';
  }

  function renderDelivery() {
    var delivery = state.delivery;
    var period = delivery.period || getPeriodConfig(state.period);

    if (deliveryInsightsEl) {
      deliveryInsightsEl.innerHTML = renderDeliveryInsights(delivery);
    }

    if (deliveryTimelineTitleEl) deliveryTimelineTitleEl.textContent = 'Timeline';
    if (deliveryTimelineMetaEl) deliveryTimelineMetaEl.textContent = period.label;
    if (deliveryTimelineColEl) deliveryTimelineColEl.textContent = period.axisLabel;

    var maxSent = 1;
    delivery.timeline.forEach(function (row) {
      if (row.sent > maxSent) maxSent = row.sent;
    });

    deliveryRowsEl.innerHTML = delivery.timeline.map(function (row) {
      var point = formatTimelinePoint(row.hour, period);
      var width = Math.round((row.sent / maxSent) * 100);
      return '<tr>' +
        '<td class="mono">' + esc(point) + '</td>' +
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
    var delivery = state.delivery || { rates: { failure: 0, complaint: 0 } };
    var rows = filteredFailures();
    var reasonCounts = {};

    if (failureInsightsEl) {
      failureInsightsEl.innerHTML = renderFailureInsights(delivery);
    }

    rows.forEach(function (row) {
      var key = humanizeFailureReason(row);
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
        '<td>' + failureReasonHtml(row) + '</td>' +
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
    var rows = filteredSuppressions();

    if (suppressionInsightsEl) {
      suppressionInsightsEl.innerHTML = renderSuppressionInsights();
    }

    suppressionMetaEl.textContent = rows.length + ' rows';
    suppressionRowsEl.innerHTML = rows.map(function (row) {
      return '<tr>' +
        '<td class="mono">' + esc(row.email) + '</td>' +
        '<td>' + esc(row.type) + '</td>' +
        '<td>' + esc(row.reason || '-') + '</td>' +
        '<td>' + esc(fmtIso(row.created_at)) + '</td>' +
        '</tr>';
    }).join('') || '<tr><td colspan="4">No suppressions found.</td></tr>';
  }

  function buildIntegrationChecks() {
    var health = state.health || {};
    var poller = health.poller || {};
    var delivery = state.delivery || { rates: { delivery: 0, complaint: 0 } };
    var deliveryRate = delivery.rates.delivery;
    var complaintRate = delivery.rates.complaint;

    return [
      {
        name: 'Service healthy',
        status: health.status === 'ok' ? 'ok' : 'warn',
        detail: health.status === 'ok' ? 'All core signals are green' : 'Service reports degraded state'
      },
      {
        name: 'Poller running',
        status: poller.isRunning ? 'ok' : 'warn',
        detail: poller.isRunning ? 'Event poller loop active' : 'Poller loop is not running'
      },
      {
        name: 'Delivery rate',
        status: deliveryRate >= 95 ? 'ok' : 'warn',
        detail: String(Math.round(deliveryRate * 10) / 10) + '% of sent emails were delivered'
      },
      {
        name: 'Complaint rate',
        status: complaintRate <= 0.2 ? 'ok' : 'warn',
        detail: String(Math.round(complaintRate * 10) / 10) + '% of delivered emails were complaints'
      },
      {
        name: 'Recent poller errors',
        status: poller.lastErrorMessage ? 'warn' : 'ok',
        detail: poller.lastErrorMessage || 'No recent poller errors'
      }
    ];
  }

  function renderHealth() {
    var health = state.health;
    var poller = health.poller || {};
    var statusValue = String(health.status || 'unknown').toLowerCase();
    var statusClass = 'warn';
    var queueDepth = null;
    var lastUpdate = poller.lastPollFinishedAt || poller.lastPollStartedAt || null;
    var lastError = poller.lastErrorMessage || 'None';

    healthMetaEl.textContent = 'Updated ' + new Date().toLocaleTimeString();

    if (statusValue === 'ok') {
      statusClass = 'ok';
    } else if (statusValue === 'error' || statusValue === 'failed' || statusValue === 'down') {
      statusClass = 'danger';
    }

    if (typeof poller.queueDepth === 'number') {
      queueDepth = poller.queueDepth;
    } else if (typeof poller.approxQueueDepth === 'number') {
      queueDepth = poller.approxQueueDepth;
    } else if (typeof health.queueDepth === 'number') {
      queueDepth = health.queueDepth;
    }

    healthStatusPillEl.className = 'status-pill ' + statusClass;
    healthStatusPillEl.textContent = statusValue;
    if (healthNavBadgeEl) {
      healthNavBadgeEl.className = 'menu-badge ' + statusClass;
      healthNavBadgeEl.textContent = statusValue.toUpperCase();
    }

    var rows = [
      ['Queue depth', queueDepth === null ? '-' : String(queueDepth)],
      ['Last poll update', lastUpdate ? fmtIso(lastUpdate) : '-'],
      ['Last error', lastError]
    ];

    healthRowsEl.innerHTML = rows.map(function (row) {
      return '<tr><td>' + esc(row[0]) + '</td><td class="mono">' + esc(row[1]) + '</td></tr>';
    }).join('');

    var checks = buildIntegrationChecks();
    healthCheckRowsEl.innerHTML = checks.map(function (row) {
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
    renderHealth();
  }

  async function load() {
    var query = '?preset=' + encodeURIComponent(state.preset) + '&period=' + encodeURIComponent(state.period);

    try {
      if (demoMode) {
        var demoResponse = await fetch(state.basePath + '/test-data.json');
        if (!demoResponse.ok) {
          throw new Error('Dashboard demo data request failed');
        }

        var demoData = await demoResponse.json();
        state.summary = demoData.summary || emptySummary();
        state.health = demoData.health || { status: 'ok', poller: {} };
        state.failures = Array.isArray(demoData.failures) ? demoData.failures : [];
        state.suppressions = Array.isArray(demoData.suppressions) ? demoData.suppressions : [];
        state.suppressionTotals = normalizeSuppressionTotals(state.summary);
        state.delivery = buildDelivery(state.summary, state.preset, state.period);
        renderAll();
        return;
      }

      var responses = await Promise.all([
        fetch(state.basePath + '/api/summary' + query),
        fetch(state.basePath + '/api/health' + query),
        fetch(state.basePath + '/api/failures' + query + '&limit=80'),
        fetch(state.basePath + '/api/suppressions?limit=500&period=' + encodeURIComponent(state.period))
      ]);

      if (!responses[0].ok || !responses[1].ok || !responses[2].ok || !responses[3].ok) {
        throw new Error('Dashboard API request failed');
      }

      state.summary = await responses[0].json();
      state.health = await responses[1].json();

      var failurePayload = await responses[2].json();
      state.failures = failurePayload.items || [];

      var suppressionPayload = await responses[3].json();
      state.suppressionTotals = normalizeSuppressionTotals(state.summary);
      state.suppressions = suppressionPayload.items || [];
      state.delivery = buildDelivery(state.summary, state.preset, state.period);

      renderAll();
    } catch (err) {
      overviewCardsEl.innerHTML = metric('Error', 'Failed');
      failureRowsEl.innerHTML = '<tr><td colspan="5">Failed to load</td></tr>';
      suppressionRowsEl.innerHTML = '<tr><td colspan="4">Failed to load</td></tr>';
      healthMetaEl.textContent = 'error';
      healthStatusPillEl.className = 'status-pill danger';
      healthStatusPillEl.textContent = 'error';
      if (healthNavBadgeEl) {
        healthNavBadgeEl.className = 'menu-badge danger';
        healthNavBadgeEl.textContent = 'ERROR';
      }
      healthRowsEl.innerHTML = '<tr><td colspan="2">Failed to load health signals</td></tr>';
      healthCheckRowsEl.innerHTML = '<tr><td colspan="3">Failed to load checks</td></tr>';
    }
  }

  failureFilterEl.addEventListener('change', renderFailures);
  suppressionFilterEl.addEventListener('change', renderSuppressions);
  if (periodSelectEl) {
    periodSelectEl.addEventListener('change', function () {
      state.period = String(periodSelectEl.value || '30d');
      if (!state.summary) return;
      state.delivery = buildDelivery(state.summary, state.preset, state.period);
      renderAll();
    });
  }

  overviewCardsEl.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;

    var actionBtn = target.closest('.metric-action[data-view-target]');
    if (!actionBtn) return;

    event.preventDefault();
    setActiveTab(actionBtn.getAttribute('data-view-target'), true);
  });

  if (deliveryInsightsEl) {
    deliveryInsightsEl.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== 'function') return;

      var metricTab = target.closest('.delivery-insights-tab[data-delivery-metric]');
      if (!metricTab) return;

      event.preventDefault();
      var nextMetric = metricTab.getAttribute('data-delivery-metric') || 'delivery';
      if (nextMetric === state.deliveryMetric) return;
      state.deliveryMetric = nextMetric;
      renderDelivery();
    });
  }

  if (failureInsightsEl) {
    failureInsightsEl.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== 'function') return;

      var metricTab = target.closest('.delivery-insights-tab[data-failure-metric]');
      if (!metricTab) return;

      event.preventDefault();
      var nextMetric = metricTab.getAttribute('data-failure-metric') || 'failure';
      if (nextMetric === state.failureMetric) return;
      state.failureMetric = nextMetric;
      renderFailures();
    });
  }

  if (suppressionInsightsEl) {
    suppressionInsightsEl.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== 'function') return;

      var metricTab = target.closest('.delivery-insights-tab[data-suppression-metric]');
      if (!metricTab) return;

      event.preventDefault();
      var nextMetric = metricTab.getAttribute('data-suppression-metric') || 'bounces';
      if (nextMetric === state.suppressionMetric) return;
      state.suppressionMetric = nextMetric;
      renderSuppressions();
    });
  }

  tabControls.forEach(function (control) {
    control.addEventListener('click', function (event) {
      event.preventDefault();
      setActiveTab(control.getAttribute('data-tab-target'), true);
    });
  });

  window.addEventListener('hashchange', function () {
    setActiveTab(window.location.hash, false);
  });

  window.addEventListener('resize', function () {
    if (!state.summary) return;
    if (state.activeTab === 'delivery') {
      renderDelivery();
    } else if (state.activeTab === 'failures') {
      renderFailures();
    } else if (state.activeTab === 'suppressions') {
      renderSuppressions();
    }
  });

  (async function bootstrap() {
    state.basePath = getBasePath();
    if (periodSelectEl) {
      state.period = String(periodSelectEl.value || state.period || '30d');
    }
    applyRuntimeSiteDomain();
    applyRuntimeSiteLinks();
    setActiveTab(window.location.hash || 'overview', false);
    await load();
    if (autoRefreshEnabled) {
      timer = setInterval(load, REFRESH_MS);
    }
  })();
})();
