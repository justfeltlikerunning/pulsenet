// model-picker.js — Model picker + Fleet tab + persistent model switching
// Loaded after app.v2.js, zero modifications to existing code
(function() {
  'use strict';

  var MODELS = [
    { id: 'sonnet', label: 'Sonnet 4.6', chip: 'S4.6',  short: 'S', color: '#5b7fff' },
    { id: 'opus',   label: 'Opus 4.6',   chip: 'O4.6',  short: 'O', color: '#a855f7' },
    { id: 'local',  label: 'Llama 3.3 70B',  chip: 'L70B',  short: 'L', color: '#10b981' },
    { id: 'codex',  label: 'Codex 5.4',  chip: 'C5.4',  short: 'C', color: '#f59e0b' }
  ];
  var MODEL_MAP = {};
  MODELS.forEach(function(m) { MODEL_MAP[m.id] = m; });

  var agentModels = {};
  var globalModel = 'sonnet';
  var pickerVisible = true;
  try { agentModels = JSON.parse(localStorage.getItem('pn_agent_models') || '{}'); } catch(e) {}
  // Sync from server state on load
  fetch('/api/fleet/model-state').then(function(r){return r.json()}).then(function(d){
    if(d.ok && d.models){
      Object.keys(d.models).forEach(function(a){agentModels[a]=d.models[a]});
      saveState(); renderGlobalRow(); renderFleetTab();
    }
  }).catch(function(){});
  try { globalModel = localStorage.getItem('pn_global_model') || 'sonnet'; } catch(e) {}
  try { pickerVisible = localStorage.getItem('pn_picker_visible') !== 'false'; } catch(e) {}

  var taggedMsgIds = new Set();

  function save() {
    localStorage.setItem('pn_agent_models', JSON.stringify(agentModels));
    localStorage.setItem('pn_global_model', globalModel);
  }

  function getModel(agentId) {
    return agentModels[agentId] || globalModel;
  }

  // ── Persistent model switch via fleet API ──
  function switchModel(modelId, agentId) {
    var body = { modelId: modelId };
    if (agentId) body.agentId = agentId;
    fetch('/api/fleet/model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function(r) { return r.json(); })
      .then(function(d) { console.log('[mp] model switch', d); })
      .catch(function(e) { console.warn('[mp] switch failed', e); });
  }

  // ── Global model picker row ──
  function renderPicker() {
    var row = document.getElementById('mp-row');
    if (!row) return;
    var hasOverrides = Object.keys(agentModels).length > 0;
    var active = MODEL_MAP[globalModel] || MODELS[0];

    var html = '<button id="mp-toggle" title="' + (pickerVisible ? 'Hide' : 'Show') + ' model picker">'
      + (pickerVisible ? '\u25BE' : '\u25B8') + ' Model</button>';

    if (pickerVisible) {
      MODELS.forEach(function(m) {
        var isActive = (globalModel === m.id && !hasOverrides);
        html += '<button class="mp-chip' + (isActive ? ' mp-on' : '') + '" data-mp="' + m.id + '" '
          + 'title="' + m.label + '" '
          + 'style="border-color:' + m.color + ';' + (isActive ? 'background:' + m.color + ';color:#fff' : 'color:' + m.color) + '">'
          + m.chip + '</button>';
      });
      if (hasOverrides) {
        html += '<button class="mp-chip mp-rst" title="Reset all to global">&#x21BA;</button>';
      }
    } else {
      html += '<span class="mp-collapsed-label" style="color:' + active.color + '">' + active.label + '</span>';
    }

    row.innerHTML = html;

    var tog = document.getElementById('mp-toggle');
    if (tog) tog.addEventListener('click', function(e) {
      e.stopPropagation();
      pickerVisible = !pickerVisible;
      localStorage.setItem('pn_picker_visible', pickerVisible);
      renderPicker();
    });

    row.querySelectorAll('[data-mp]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        globalModel = btn.getAttribute('data-mp');
        agentModels = {};
        save();
        renderPicker();
        addBadges();
        renderFleetView();
        switchModel(globalModel, null); // all agents
      });
    });

    var rst = row.querySelector('.mp-rst');
    if (rst) rst.addEventListener('click', function(e) {
      e.stopPropagation();
      agentModels = {};
      save();
      renderPicker();
      addBadges();
      renderFleetView();
      switchModel(globalModel, null);
    });
  }

  // ── Per-agent model badges on participant chips ──
  function addBadges() {
    var chips = document.querySelectorAll('.participant-chip[data-agent-id]');
    chips.forEach(function(chip) {
      var agentId = chip.getAttribute('data-agent-id');
      if (!agentId) return;
      var model = MODEL_MAP[getModel(agentId)] || MODELS[0];

      var badge = chip.querySelector('.mp-b');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'mp-b';
        var x = chip.querySelector('.chip-remove');
        if (x) chip.insertBefore(badge, x);
        else chip.appendChild(badge);
      }
      badge.textContent = model.short;
      badge.setAttribute('style',
        'background:' + model.color + ';display:inline-flex;align-items:center;justify-content:center;'
        + 'width:18px;height:18px;border-radius:4px;font-size:10px;font-weight:800;color:#fff;'
        + 'margin-left:4px;cursor:pointer;flex-shrink:0');
      badge.title = model.label + ' \u2014 click to change';

      if (!badge._mp) {
        badge._mp = true;
        badge.addEventListener('click', function(e) {
          e.stopPropagation();
          e.preventDefault();
          showDD(agentId, badge);
        });
      }
    });
  }

  // ── Model watermark on NEW agent messages only ──
  function tagNewMessages() {
    var wrappers = document.querySelectorAll('.msg-wrapper.agent');
    wrappers.forEach(function(w) {
      var msgId = w.dataset.msgId;
      if (!msgId || taggedMsgIds.has(msgId)) return;
      taggedMsgIds.add(msgId);
      if (w.querySelector('.mp-wm')) return;
      var sender = (w.dataset.sender || '').toLowerCase();
      if (!sender) return;
      var model = MODEL_MAP[getModel(sender)] || MODELS[0];
      var bubble = w.querySelector('.msg-bubble');
      if (!bubble) return;
      bubble.style.position = 'relative';
      var wm = document.createElement('span');
      wm.className = 'mp-wm';
      wm.dataset.model = model.id;
      wm.textContent = model.label;
      wm.style.cssText = 'position:absolute;bottom:4px;right:8px;'
        + 'font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;'
        + 'color:' + model.color + ';opacity:0.35;pointer-events:none;'
        + 'line-height:1;user-select:none';
      bubble.appendChild(wm);
    });
  }

  // ── Fleet view ──
  function renderFleetView() {
    var container = document.getElementById('fleet-view-content');
    if (!container) return;

    var agents = (typeof AGENTS !== 'undefined') ? AGENTS : [];
    var html = '<div class="fleet-grid">';

    agents.forEach(function(agent) {
      var curModel = getModel(agent.id);
      var model = MODEL_MAP[curModel] || MODELS[0];
      var presStatus = (typeof agentPresence !== 'undefined') ? (agentPresence[agent.id] || 'unknown') : 'unknown';

      html += '<div class="fleet-card" data-agent-id="' + agent.id + '">'
        + '<div class="fleet-card-header">'
        + '<div class="fleet-avatar" style="background:' + agent.color + '">' + agent.name[0] + '</div>'
        + '<div class="fleet-info">'
        + '<div class="fleet-name"><div class="presence-dot ' + presStatus + '" style="width:7px;height:7px;margin-right:5px;flex-shrink:0"></div>' + agent.name + '</div>'
        + '<div class="fleet-role">' + agent.role + '</div>'
        + '</div>'
        + '</div>'
        + '<div class="fleet-model-pills">'
        + MODELS.map(function(m) {
            var active = (curModel === m.id);
            return '<button class="fleet-mpill' + (active ? ' active' : '') + '" data-agent="' + agent.id + '" data-model="' + m.id + '" '
              + 'style="border-color:' + m.color + ';' + (active ? 'background:' + m.color + ';color:#fff' : 'color:' + m.color) + '">'
              + m.label + '</button>';
          }).join('')
        + '</div>'
        + '</div>';
    });

    html += '</div>';

    // Global switch row at top
    html = '<div class="fleet-global">'
      + '<span class="fleet-global-label">All agents:</span>'
      + MODELS.map(function(m) {
          var allMatch = agents.every(function(a) { return getModel(a.id) === m.id; });
          return '<button class="fleet-gpill' + (allMatch ? ' active' : '') + '" data-gmodel="' + m.id + '" '
            + 'style="border-color:' + m.color + ';' + (allMatch ? 'background:' + m.color + ';color:#fff' : 'color:' + m.color) + '">'
            + m.label + '</button>';
        }).join('')
      + '</div>' + html;

    container.innerHTML = html;

    // Wire global pills
    container.querySelectorAll('[data-gmodel]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        globalModel = btn.getAttribute('data-gmodel');
        agentModels = {};
        save();
        renderPicker();
        renderFleetView();
        addBadges();
        switchModel(globalModel, null);
      });
    });

    // Wire per-agent pills
    container.querySelectorAll('.fleet-mpill').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var aId = btn.getAttribute('data-agent');
        var mId = btn.getAttribute('data-model');
        if (mId === globalModel) { delete agentModels[aId]; }
        else { agentModels[aId] = mId; }
        save();
        renderPicker();
        renderFleetView();
        addBadges();
        switchModel(mId, aId);
      });
    });
  }

  // ── Per-agent dropdown ──
  function showDD(agentId, anchor) {
    closeDD();
    var cur = getModel(agentId);
    var agent = (typeof AGENT_MAP !== 'undefined') ? AGENT_MAP[agentId] : null;
    var rect = anchor.getBoundingClientRect();
    var dd = document.createElement('div');
    dd.id = 'mp-dd';
    dd.style.cssText = 'position:fixed;top:' + (rect.bottom + 5) + 'px;left:' + Math.max(4, rect.left - 40) + 'px;'
      + 'background:#1e293b;border:1px solid #334155;border-radius:10px;padding:6px 4px;'
      + 'box-shadow:0 8px 24px rgba(0,0,0,0.45);z-index:9999;min-width:148px';

    var inner = '<div style="font-size:10px;color:#64748b;padding:2px 10px 5px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px">'
      + (agent ? agent.name : agentId) + '</div>';
    MODELS.forEach(function(m) {
      var sel = (cur === m.id);
      inner += '<div class="mp-dd-o" data-mp="' + m.id + '" style="display:flex;align-items:center;gap:8px;padding:7px 10px;'
        + 'cursor:pointer;border-radius:6px;font-size:13px;color:#e2e8f0;' + (sel ? 'background:rgba(91,127,255,0.15)' : '') + '">'
        + '<span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;'
        + 'border-radius:5px;font-size:10px;font-weight:800;color:#fff;background:' + m.color + '">' + m.short + '</span>'
        + '<span>' + m.label + '</span>'
        + (sel ? '<span style="margin-left:auto;color:#5b7fff">\u2713</span>' : '')
        + '</div>';
    });
    dd.innerHTML = inner;
    dd.addEventListener('click', function(e) { e.stopPropagation(); });
    document.body.appendChild(dd);

    dd.querySelectorAll('.mp-dd-o').forEach(function(opt) {
      opt.addEventListener('mouseenter', function() {
        if (getModel(agentId) !== opt.getAttribute('data-mp')) opt.style.background = '#334155';
      });
      opt.addEventListener('mouseleave', function() {
        if (getModel(agentId) !== opt.getAttribute('data-mp')) opt.style.background = '';
      });
      opt.addEventListener('click', function(e) {
        e.stopPropagation();
        var mid = opt.getAttribute('data-mp');
        if (mid === globalModel) { delete agentModels[agentId]; }
        else { agentModels[agentId] = mid; }
        save(); renderPicker(); addBadges(); renderFleetView();
        switchModel(mid, agentId);
        closeDD();
      });
    });

    var closeHandler = function(e) {
      var ddEl = document.getElementById('mp-dd');
      if (!ddEl) { document.removeEventListener('click', closeHandler, true); return; }
      if (!ddEl.contains(e.target)) { closeDD(); document.removeEventListener('click', closeHandler, true); }
    };
    setTimeout(function() { document.addEventListener('click', closeHandler, true); }, 50);
  }

  function closeDD() {
    var d = document.getElementById('mp-dd');
    if (d) d.remove();
  }

  // ── Patch showView to hide fleet-view ──
  function patchShowView() {
    if (typeof showView !== 'function') return;
    var orig = showView;
    window.showView = function(viewName) {
      var fv = document.getElementById('fleet-view');
      if (fv) fv.classList.add('hidden');
      return orig.apply(this, arguments);
    };
  }

  // ── Inject Fleet tab into sidebar ──
  function injectFleetTab() {
    if (document.getElementById('fleet-btn')) return;

    // Button in sidebar
    var burnBtn = document.getElementById('burn-monitor-btn');
    if (!burnBtn) return;
    var fleetBtn = document.createElement('button');
    fleetBtn.id = 'fleet-btn';
    fleetBtn.innerHTML = '\uD83D\uDEF8 Fleet Models';
    fleetBtn.className = burnBtn.className;
    burnBtn.parentNode.insertBefore(fleetBtn, burnBtn.nextSibling);

    // Fleet view panel (same pattern as burn-view)
    var burnView = document.getElementById('burn-view');
    if (!burnView) return;
    var fleetView = document.createElement('div');
    fleetView.id = 'fleet-view';
    fleetView.className = 'hidden';
    fleetView.innerHTML = '<div id="new-chat-header">'
      + '<button class="mobile-menu-float" onclick="openSidebar()" aria-label="Open menu">\u2630</button>'
      + '<h2>Fleet Models</h2>'
      + '</div>'
      + '<div id="fleet-view-content" style="padding:14px;overflow-y:auto"></div>';
    burnView.parentNode.insertBefore(fleetView, burnView.nextSibling);

    // Wire button
    fleetBtn.addEventListener('click', function() {
      // Hide all views
      ['chat-view','burn-view','new-chat-view','empty-state','fleet-view'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.classList.add('hidden');
      });
      document.getElementById('fleet-view').classList.remove('hidden');
      renderFleetView();
    });
  }


  // ── Server sync: poll /api/agents/models every 60s ──
  // Gateway is always source of truth — UI reads, never clobbers
  function syncModelsFromServer() {
    fetch('/api/agents/models')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.ok || !data.models) return;
        var models = data.models;
        // Find most common model = global default
        var counts = {};
        Object.values(models).forEach(function(m) { if (m) counts[m] = (counts[m]||0)+1; });
        var topEntry = Object.entries(counts).sort(function(a,b){return b[1]-a[1];})[0];
        if (topEntry) {
          globalModel = topEntry[0];
          localStorage.setItem('pn_global_model', globalModel);
        }
        // Per-agent overrides (agents on a different model than global)
        agentModels = {};
        Object.entries(models).forEach(function(kv) {
          var agent = kv[0], model = kv[1];
          if (model && model !== globalModel) {
            agentModels[agent] = model;
          }
        });
        localStorage.setItem('pn_agent_models', JSON.stringify(agentModels));
        renderPicker();
        renderFleetView();
        addBadges();
      })
      .catch(function() {}); // silent — offline agents are normal
  }

  // ── Initialize ──
  function init() {
    // Model picker row
    var modeRow = document.getElementById('compose-mode-row');
    if (modeRow && !document.getElementById('mp-row')) {
      var row = document.createElement('div');
      row.id = 'mp-row';
      modeRow.parentNode.insertBefore(row, modeRow);
    }
    renderPicker();
    syncModelsFromServer();
    setInterval(syncModelsFromServer, 15000);
    patchShowView();
    injectFleetTab();

    setInterval(function() {
      var chips = document.querySelectorAll('.participant-chip[data-agent-id]');
      if (chips.length > 0) addBadges();
      tagNewMessages();
    }, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 200);
  }
})();
