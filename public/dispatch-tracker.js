// dispatch-tracker.js — Sticky collapsible dispatch header for multi-agent broadcasts
// Option A: 90s soft timeout, amber warning, manual retry. Standalone, no app.v2.js changes.
(function() {
  'use strict';

  var SOFT_TIMEOUT_MS = 90000; // 90s → amber warning
  var DISMISS_DELAY_MS = 4000; // auto-dismiss 4s after all done

  // Active dispatch state
  var dispatch = null;
  /*
  dispatch = {
    convId: string,
    targets: string[],       // agent ids/names
    responded: Set<string>,  // agent ids that have replied
    timedOut: Set<string>,   // agent ids that hit soft timeout
    timers: { [agentId]: timeoutHandle },
    collapsed: bool,
    sentAt: number,
    dismissTimer: handle,
  }
  */

  // ── Banner DOM ──
  var banner = null;

  function getBanner() {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'dt-banner';
      // Insert between chat-header and messages-container
      var mc = document.getElementById('messages-container');
      if (mc && mc.parentNode) mc.parentNode.insertBefore(banner, mc);
    }
    return banner;
  }

  function hideBanner() {
    if (banner) {
      banner.classList.add('dt-hide');
      setTimeout(function() {
        if (banner) { banner.innerHTML = ''; banner.classList.remove('dt-hide'); }
      }, 300);
    }
  }

  // ── Render banner ──
  function render() {
    if (!dispatch) { hideBanner(); return; }
    var b = getBanner();

    var total = dispatch.targets.length;
    var doneCount = dispatch.responded.size;
    var pct = total ? Math.round((doneCount / total) * 100) : 0;
    var allDone = (doneCount >= total);

    var statusText = allDone
      ? '\u2705 All ' + total + ' responded'
      : doneCount + ' / ' + total + ' responded';

    // Agent pills
    var pills = '';
    dispatch.targets.forEach(function(agentId) {
      var agent = (typeof AGENT_MAP !== 'undefined') ? AGENT_MAP[agentId] : null;
      var name = agent ? agent.name : agentId;
      var color = agent ? agent.color : '#5b7fff';
      var isDone = dispatch.responded.has(agentId);
      var isTimeout = dispatch.timedOut.has(agentId);
      var cls = isDone ? 'dt-pill dt-done' : isTimeout ? 'dt-pill dt-timeout' : 'dt-pill dt-waiting';
      var icon = isDone ? '\u2705' : isTimeout ? '\u26a0\ufe0f' : '\u23f3';
      var retryBtn = isTimeout && !isDone
        ? ' <button class="dt-retry" data-agent="' + agentId + '" title="Retry">&#x21BA;</button>'
        : '';
      pills += '<span class="' + cls + '" style="' + (isDone ? 'border-color:' + color : '') + '">'
        + icon + ' ' + name + retryBtn + '</span>';
    });

    // Elapsed
    var elapsed = Math.round((Date.now() - dispatch.sentAt) / 1000);
    var elapsedStr = elapsed < 60 ? elapsed + 's' : Math.floor(elapsed/60) + 'm ' + (elapsed%60) + 's';

    b.className = 'dt-banner' + (allDone ? ' dt-all-done' : '');
    b.innerHTML =
      '<div class="dt-top" id="dt-top">' +
        '<div class="dt-left">' +
          '<span class="dt-icon">\u26a1</span>' +
          '<span class="dt-status">' + statusText + '</span>' +
          '<span class="dt-elapsed">' + elapsedStr + '</span>' +
        '</div>' +
        '<button class="dt-toggle" id="dt-toggle" title="' + (dispatch.collapsed ? 'Expand' : 'Collapse') + '">' +
          (dispatch.collapsed ? '\u25B8' : '\u25BE') +
        '</button>' +
      '</div>' +
      '<div class="dt-bar"><div class="dt-bar-fill" style="width:' + pct + '%;' +
        (allDone ? 'background:linear-gradient(90deg,#10b981,#4ade80)' : '') + '"></div></div>' +
      '<div class="dt-agents" id="dt-agents" style="' + (dispatch.collapsed ? 'display:none' : '') + '">' +
        pills +
      '</div>';

    // Wire toggle
    var tog = b.querySelector('#dt-toggle');
    if (tog) tog.addEventListener('click', function(e) {
      e.stopPropagation();
      dispatch.collapsed = !dispatch.collapsed;
      render();
    });

    // Wire top row click = toggle too
    var top = b.querySelector('#dt-top');
    if (top) top.addEventListener('click', function() {
      dispatch.collapsed = !dispatch.collapsed;
      render();
    });

    // Wire retry buttons
    b.querySelectorAll('.dt-retry').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var agentId = btn.getAttribute('data-agent');
        retryAgent(agentId);
      });
    });
  }

  // ── Retry single agent ──
  function retryAgent(agentId) {
    if (!dispatch || !dispatch.lastBody) return;
    if (typeof currentConvId === 'undefined' || !currentConvId) return;
    if (typeof apiFetch !== 'function') return;
    // Clear timeout state so it shows as waiting again
    dispatch.timedOut.delete(agentId);
    // Reset timer
    clearTimeout(dispatch.timers[agentId]);
    dispatch.timers[agentId] = setTimeout(function() {
      if (dispatch && !dispatch.responded.has(agentId)) {
        dispatch.timedOut.add(agentId);
        render();
      }
    }, SOFT_TIMEOUT_MS);
    render();
    // Resend to just this agent
    apiFetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: 'Richard',
        senderType: 'human',
        body: dispatch.lastBody,
        conversationId: currentConvId,
        targets: [agentId],
      })
    }).catch(function(e) { console.warn('[dt] retry failed', e); });
  }

  // ── Start dispatch tracking ──
  function startDispatch(convId, targets, bodyText) {
    // Clear any previous
    endDispatch(true);

    if (!targets || targets.length < 2) return; // only track multi-agent

    dispatch = {
      convId: convId,
      targets: targets.map(function(t) { return t.toLowerCase(); }),
      responded: new Set(),
      timedOut: new Set(),
      timers: {},
      collapsed: false,
      sentAt: Date.now(),
      dismissTimer: null,
      lastBody: bodyText,
    };

    // Set soft timeout per agent
    dispatch.targets.forEach(function(agentId) {
      dispatch.timers[agentId] = setTimeout(function() {
        if (dispatch && !dispatch.responded.has(agentId)) {
          dispatch.timedOut.add(agentId);
          render();
        }
      }, SOFT_TIMEOUT_MS);
    });

    render();

    // Tick elapsed every second
    dispatch._tick = setInterval(function() {
      if (!dispatch) return;
      render();
    }, 5000); // refresh every 5s for elapsed counter
  }

  // ── Mark agent as responded ──
  function markResponded(agentId) {
    if (!dispatch) return;
    var id = agentId.toLowerCase();
    if (!dispatch.targets.includes(id)) return;
    clearTimeout(dispatch.timers[id]);
    dispatch.responded.add(id);
    dispatch.timedOut.delete(id); // responded late — clear amber

    render();

    // All done?
    if (dispatch.responded.size >= dispatch.targets.length) {
      clearInterval(dispatch._tick);
      dispatch.collapsed = true; // auto-collapse when complete
      render();
      dispatch.dismissTimer = setTimeout(function() {
        endDispatch(false);
      }, DISMISS_DELAY_MS);
    }
  }

  // ── End and clear ──
  function endDispatch(immediate) {
    if (!dispatch) return;
    Object.values(dispatch.timers).forEach(clearTimeout);
    clearInterval(dispatch._tick);
    clearTimeout(dispatch.dismissTimer);
    dispatch = null;
    if (immediate) {
      hideBanner();
    } else {
      hideBanner();
    }
  }

  // ── Patch sendMessage to intercept targets ──
  function patchSend() {
    // We can't easily wrap apiFetch without knowing which call is a message send.
    // Instead: listen for the optimistic message add + watch for the targets
    // by overriding the sendBtn click handler — too fragile.
    //
    // Better: dispatch a custom event from the send handler.
    // We patch apiFetch to intercept POST /api/messages calls.
    if (typeof apiFetch !== 'function') return;
    var origFetch = apiFetch;
    window.apiFetch = function(input, init) {
      try {
        if (init && init.method === 'POST' && typeof input === 'string' && input.includes('/api/messages')) {
          var body = init.body ? JSON.parse(init.body) : {};
          var targets = body.targets || [];
          var convId = body.conversationId || body.conversation_id;
          var bodyText = body.body || '';
          if (targets.length >= 2 && convId) {
            startDispatch(convId, targets, bodyText);
          }
        }
      } catch(e) {}
      return origFetch.apply(this, arguments);
    };
  }

  // ── Patch handleIncomingMessage to detect agent replies ──
  function patchIncoming() {
    if (typeof handleIncomingMessage !== 'function') return;
    var orig = handleIncomingMessage;
    window.handleIncomingMessage = function(msg) {
      if (dispatch && msg && msg.sender_type === 'agent' && msg.conversation_id === dispatch.convId) {
        markResponded((msg.sender || '').toLowerCase());
      }
      return orig.apply(this, arguments);
    };
  }

  // ── Hide pipeline-progress (existing in-thread one) when we have the banner ──
  function suppressOldPipeline() {
    // Override the pipeline_progress SSE handler to be a no-op when we're tracking
    // We do this by watching for the pipeline-progress element and hiding it
    var observer = new MutationObserver(function(mutations) {
      mutations.forEach(function(m) {
        m.addedNodes.forEach(function(node) {
          if (node.id === 'pipeline-progress') {
            node.style.display = 'none';
          }
        });
      });
    });
    var msgs = document.getElementById('messages');
    if (msgs) observer.observe(msgs, { childList: true });
  }

  // ── Init ──
  function init() {
    patchSend();
    patchIncoming();
    suppressOldPipeline();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 300); // after app.v2.js finishes init
  }
})();
