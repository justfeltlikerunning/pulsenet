'use strict';

// ─── Agent Registry ───────────────────────────────────────────────────────────
// Agents are loaded from the server at startup (see init() → loadAgentPresence)
// This array is populated dynamically from /api/agents
let AGENTS = [];

// Sidebar group presets
const FILTER_GROUPS = [
  { id: 'all',      label: 'All',      agents: [] },
  { id: 'work',     label: 'Work',     agents: ['bayou','wesley','greenbow','danwatch','sully'] },
  { id: 'personal', label: 'Personal', agents: ['feather'] },
  { id: 'security', label: 'Security', agents: ['bubbawatch'] },
  { id: 'brain',    label: 'Brain',    agents: ['jenny','ltdan'] },
];

const AGENT_MAP = {};
for (const a of AGENTS) AGENT_MAP[a.id] = a;

function agentByName(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  return AGENTS.find(a => a.id === lower || a.name.toLowerCase() === lower) || null;
}

// ─── User config ─────────────────────────────────────────────────────────────
let USER_NAME = 'User'; // Loaded from /api/config at startup

// ─── State ────────────────────────────────────────────────────────────────────
let conversations = [];
let currentConvId = null;
let currentMessages = [];
let selectedAgents = new Set();
let agentPresence = {};
let lastViewedAt = {};
let typingAgents = {};       // convId -> Set of agentNames
let filterAgents = new Set(); // sidebar filter: selected agent IDs
let activeGroupFilter = 'all';
let expandedGroups = new Set(); // Set of groupKey strings that are expanded
let agentHistoryCache = {};  // agentId -> { count, recentTitles }

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const dom = {
  sidebar:          $('sidebar'),
  sidebarToggle:    $('sidebar-toggle'),
  overlay:          $('overlay'),
  newChatBtn:       $('new-chat-btn'),
  convList:         $('conversation-list'),
  emptyState:       $('empty-state'),
  emptyNewChatBtn:  $('empty-new-chat-btn'),
  newChatView:      $('new-chat-view'),
  agentGrid:        $('agent-grid'),
  selectedPills:    $('selected-pills'),
  newChatInput:     $('new-chat-input'),
  newChatSendBtn:   $('new-chat-send-btn'),
  chatView:         $('chat-view'),
  chatParticipants: $('chat-participants'),
  addAgentBtn:      $('add-agent-btn'),
  addAgentDropdown: $('add-agent-dropdown'),
  messages:         $('messages'),
  messageInput:     $('message-input'),
  sendBtn:          $('send-btn'),
  notifBtn:         $('notif-btn'),
  filterBar:        $('filter-bar'),
  filterGroups:     $('filter-groups'),
  filterAgents:     $('filter-agents'),
  filterCount:      $('filter-count'),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function relativeTime(isoStr) {
  if (!isoStr) return '';
  const diff = Date.now() - new Date(isoStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)  return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function formatTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatFullTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  return d.toLocaleString([], {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderMarkdown(text) {
  if (!text) return '';
  try {
    if (typeof marked !== 'undefined') {
      return marked.parse(text, { breaks: true, gfm: true });
    }
  } catch(e) {}
  return `<p>${escHtml(text).replace(/\n/g,'<br>')}</p>`;
}

function showView(viewName) {
  dom.emptyState.classList.add('hidden');
  dom.newChatView.classList.add('hidden');
  dom.chatView.classList.add('hidden');
  if (viewName === 'empty') dom.emptyState.classList.remove('hidden');
  else if (viewName === 'new-chat') dom.newChatView.classList.remove('hidden');
  else if (viewName === 'chat') dom.chatView.classList.remove('hidden');
}

function closeSidebar() {
  dom.sidebar.classList.remove('open');
  dom.overlay.classList.remove('active');
}

function openSidebar() {
  dom.sidebar.classList.add('open');
  dom.overlay.classList.add('active');
}

// ─── Sidebar toggle ───────────────────────────────────────────────────────────
dom.sidebarToggle.addEventListener('click', () => {
  if (dom.sidebar.classList.contains('open')) closeSidebar();
  else openSidebar();
});
dom.overlay.addEventListener('click', closeSidebar);

// Mobile menu button (in chat header)
const mobileMenuBtn = document.getElementById('mobile-menu-btn');
if (mobileMenuBtn) {
  mobileMenuBtn.addEventListener('click', () => {
    if (dom.sidebar.classList.contains('open')) closeSidebar();
    else openSidebar();
  });
}

// ─── Sidebar Filter Bar ───────────────────────────────────────────────────────
function renderFilterBar() {
  // Group preset pills
  dom.filterGroups.innerHTML = '';
  for (const group of FILTER_GROUPS) {
    const btn = document.createElement('button');
    btn.className = `filter-group-btn${activeGroupFilter === group.id ? ' active' : ''}`;
    btn.textContent = group.label;
    btn.addEventListener('click', () => {
      activeGroupFilter = group.id;
      if (group.id === 'all') {
        filterAgents.clear();
      } else {
        filterAgents.clear();
        for (const a of group.agents) filterAgents.add(a);
      }
      renderFilterBar();
      renderConversationList();
    });
    dom.filterGroups.appendChild(btn);
  }

  // Agent avatar circles
  dom.filterAgents.innerHTML = '';
  for (const agent of AGENTS) {
    const btn = document.createElement('button');
    const isActive = filterAgents.has(agent.id);
    btn.className = `filter-agent-btn${isActive ? ' active' : ''}`;
    btn.title = `${agent.name} (${agent.role})`;
    btn.style.setProperty('--agent-color', agent.color);
    if (isActive) btn.style.setProperty('--agent-color-glow', agent.color);
    const presStatus = agentPresence[agent.id] || 'unknown';
    btn.innerHTML = `
      <span class="filter-agent-letter">${agent.name[0]}</span>
      <span class="filter-agent-dot ${presStatus}"></span>
    `;
    btn.addEventListener('click', () => {
      // Toggle individual agent; clear group preset
      if (filterAgents.has(agent.id)) {
        filterAgents.delete(agent.id);
      } else {
        filterAgents.add(agent.id);
      }
      // Set group to 'all' if we manually picked agents
      activeGroupFilter = 'custom';
      // Check if matches a group
      for (const grp of FILTER_GROUPS) {
        if (grp.id === 'all') continue;
        if (grp.agents.length === filterAgents.size && grp.agents.every(a => filterAgents.has(a))) {
          activeGroupFilter = grp.id;
          break;
        }
      }
      if (filterAgents.size === 0) activeGroupFilter = 'all';
      renderFilterBar();
      renderConversationList();
    });
    dom.filterAgents.appendChild(btn);
  }
}

// ─── Conversation list ────────────────────────────────────────────────────────
function buildConvTitle(conv) {
  if (conv.title && conv.title !== conv.id && !conv.title.startsWith('conv_')) {
    return conv.title;
  }
  const parts = conv.participants || [];
  if (parts.length === 0) return 'Chat';
  return parts.map(p => {
    const a = agentByName(p);
    return a ? a.name : p;
  }).join(', ');
}

function getFilteredConversations() {
  if (filterAgents.size === 0) return conversations;
  return conversations.filter(conv => {
    const parts = (conv.participants || []).map(p => p.toLowerCase());
    for (const agentId of filterAgents) {
      if (parts.includes(agentId)) return true;
    }
    return false;
  });
}

// ─── Conversation grouping helpers ───────────────────────────────────────────

function getGroupKey(conv) {
  const parts = (conv.participants || []).map(p => p.toLowerCase());
  if (parts.length === 0) return '__none__';
  if (parts.length > 1) return '__multi__:' + parts.slice().sort().join(',');
  return parts[0]; // single agent = group by that agent
}

function getPrimaryAgent(conv) {
  const parts = (conv.participants || []);
  if (parts.length === 0) return null;
  return agentByName(parts[0]);
}

function buildGroupedView(filtered) {
  // Separate pinned
  const pinned = filtered.filter(c => c.pinned === 1 || c.pinned === true);
  const unpinned = filtered.filter(c => !(c.pinned === 1 || c.pinned === true));

  // Group unpinned by groupKey
  const groupMap = new Map(); // groupKey -> { convs[], primaryAgent, isMulti }
  for (const conv of unpinned) {
    const key = getGroupKey(conv);
    if (!groupMap.has(key)) {
      const isMulti = key.startsWith('__multi__:');
      const agent = isMulti ? null : agentByName(key);
      groupMap.set(key, { key, convs: [], agent, isMulti });
    }
    groupMap.get(key).convs.push(conv);
  }

  // Sort groups: multi-agent first, then by most recent message
  const groups = [...groupMap.values()].sort((a, b) => {
    const aTime = Math.max(...a.convs.map(c => c.last_message_at ? new Date(c.last_message_at).getTime() : 0));
    const bTime = Math.max(...b.convs.map(c => c.last_message_at ? new Date(c.last_message_at).getTime() : 0));
    if (a.isMulti && !b.isMulti) return -1;
    if (!a.isMulti && b.isMulti) return 1;
    return bTime - aTime;
  });

  return { pinned, groups };
}

function renderConvItem(conv, indented = false) {
  const title = buildConvTitle(conv);
  const lastSender = conv.last_sender || '';
  const lastBody = conv.last_body || '';
  const isUnread = conv.last_message_at && lastViewedAt[conv.id] &&
                   new Date(conv.last_message_at) > new Date(lastViewedAt[conv.id]);
  const firstAgent = (conv.participants || [])[0];
  const presStatus = firstAgent ? (agentPresence[firstAgent] || 'unknown') : 'unknown';
  const isPinned = conv.pinned === 1 || conv.pinned === true;

  const div = document.createElement('div');
  div.className = `conv-item${indented ? ' conv-item-grouped' : ''}${conv.id === currentConvId ? ' active' : ''}${isUnread ? ' unread' : ''}${isPinned ? ' pinned' : ''}`;
  div.dataset.convId = conv.id;
  div.innerHTML = `
    <div class="conv-item-header">
      <div class="presence-dot ${presStatus}"></div>
      <div class="conv-title">${isPinned ? '📌 ' : ''}${escHtml(title)}</div>
      <div class="conv-time">${relativeTime(conv.last_message_at)}</div>
    </div>
    <div class="conv-preview">${escHtml(lastBody ? (lastSender ? lastSender + ': ' : '') + lastBody : '')}</div>
  `;

  div.addEventListener('click', (e) => {
    if (e.target.closest('.conv-context-menu')) return;
    closeSidebar();
    openConversation(conv.id);
  });
  div.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showConvContextMenu(e, conv);
  });
  return div;
}

function renderGroupHeader(group) {
  const { key, convs, agent, isMulti } = group;
  const count = convs.length;

  // Most recent message across the group
  const latestConv = convs.reduce((best, c) => {
    if (!best) return c;
    return (new Date(c.last_message_at || 0) > new Date(best.last_message_at || 0)) ? c : best;
  }, null);
  const latestTime = latestConv ? relativeTime(latestConv.last_message_at) : '';
  const latestSender = latestConv?.last_sender || '';
  const latestBody = latestConv?.last_body || '';
  const previewText = latestBody ? (latestSender ? latestSender + ': ' + latestBody : latestBody) : '';

  // Check if group contains active conv
  const hasActive = convs.some(c => c.id === currentConvId);
  const isExpanded = expandedGroups.has(key) || hasActive;

  // Dot color
  const dotColor = agent ? agent.color : '#888';
  const groupLabel = isMulti ? 'Group Chats' : (agent ? agent.name : key);

  // Presence status for the agent
  const presStatus = agent ? (agentPresence[agent.id] || 'unknown') : 'unknown';

  const wrapper = document.createElement('div');
  wrapper.className = 'conv-group';
  wrapper.dataset.groupKey = key;

  const header = document.createElement('div');
  header.className = `conv-group-header${hasActive ? ' has-active' : ''}`;
  header.innerHTML = `
    <div class="conv-group-dot" style="background:${dotColor}"></div>
    <div class="conv-group-dot-presence presence-dot ${presStatus}" style="display:none"></div>
    <div class="conv-group-name">${escHtml(groupLabel)}</div>
    <div class="conv-group-count">(${count})</div>
    <div class="conv-group-time">${escHtml(latestTime)}</div>
    <div class="conv-group-chevron">${isExpanded ? '▾' : '▸'}</div>
  `;

  // Preview line below header
  const preview = document.createElement('div');
  preview.className = 'conv-group-preview';
  preview.textContent = previewText ? '↳ ' + previewText : '';

  // Children container
  const children = document.createElement('div');
  children.className = `conv-group-children${isExpanded ? ' expanded' : ''}`;

  for (const conv of convs) {
    children.appendChild(renderConvItem(conv, true));
  }

  header.addEventListener('click', () => {
    if (expandedGroups.has(key)) {
      expandedGroups.delete(key);
    } else {
      expandedGroups.add(key);
    }
    renderConversationList();
  });

  wrapper.appendChild(header);
  wrapper.appendChild(preview);
  wrapper.appendChild(children);
  return wrapper;
}

function renderConversationList() {
  dom.convList.innerHTML = '';

  const filtered = getFilteredConversations();
  const total = conversations.length;

  // Show filter count if filtered
  if (filterAgents.size > 0) {
    dom.filterCount.textContent = `Showing ${filtered.length} of ${total}`;
    dom.filterCount.classList.remove('hidden');
  } else {
    dom.filterCount.classList.add('hidden');
  }

  if (!filtered.length) {
    const msg = filterAgents.size > 0 ? 'No matching conversations' : 'No conversations yet';
    dom.convList.innerHTML = `<div style="padding:16px;color:var(--text-muted);font-size:12px;text-align:center;">${msg}</div>`;
    return;
  }

  const { pinned, groups } = buildGroupedView(filtered);

  // ── Pinned section ──────────────────────────────────────────────────────
  if (pinned.length > 0) {
    const pinnedSection = document.createElement('div');
    pinnedSection.className = 'conv-section';
    const pinnedLabel = document.createElement('div');
    pinnedLabel.className = 'conv-section-label';
    pinnedLabel.textContent = 'Pinned';
    pinnedSection.appendChild(pinnedLabel);
    for (const conv of pinned) {
      pinnedSection.appendChild(renderConvItem(conv, false));
    }
    dom.convList.appendChild(pinnedSection);
  }

  // ── Grouped sections ────────────────────────────────────────────────────
  for (const group of groups) {
    if (group.convs.length === 1) {
      // Single conversation — render flat (no group overhead)
      dom.convList.appendChild(renderConvItem(group.convs[0], false));
    } else {
      // Multiple conversations — render grouped
      dom.convList.appendChild(renderGroupHeader(group));
    }
  }
}

// ─── Conversation context menu ────────────────────────────────────────────────
let activeContextMenu = null;

function showConvContextMenu(e, conv) {
  closeContextMenu();

  const menu = document.createElement('div');
  menu.className = 'conv-context-menu';

  const isPinned = conv.pinned === 1 || conv.pinned === true;
  const title = buildConvTitle(conv);

  menu.innerHTML = `
    <div class="ctx-item" data-action="rename">✏️ Rename</div>
    <div class="ctx-item" data-action="pin">${isPinned ? '📌 Unpin' : '📌 Pin'}</div>
    <div class="ctx-item danger" data-action="delete">🗑️ Delete</div>
  `;

  // Position near click, keep in viewport
  const x = Math.min(e.clientX, window.innerWidth - 160);
  const y = Math.min(e.clientY, window.innerHeight - 120);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  menu.addEventListener('click', async (ev) => {
    const action = ev.target.closest('.ctx-item')?.dataset.action;
    if (!action) return;
    closeContextMenu();

    if (action === 'rename') {
      startInlineRename(conv);
    } else if (action === 'pin') {
      const newPinned = !isPinned;
      await fetch(`/api/conversations/${encodeURIComponent(conv.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned: newPinned }),
      });
      conv.pinned = newPinned ? 1 : 0;
      // Re-sort with pinned at top
      conversations.sort((a, b) => {
        const ap = a.pinned || 0, bp = b.pinned || 0;
        if (bp !== ap) return bp - ap;
        return new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0);
      });
      renderConversationList();
    } else if (action === 'delete') {
      if (!confirm(`Delete conversation "${title}"? This cannot be undone.`)) return;
      await fetch(`/api/conversations/${encodeURIComponent(conv.id)}`, { method: 'DELETE' });
      conversations = conversations.filter(c => c.id !== conv.id);
      if (currentConvId === conv.id) {
        currentConvId = null;
        showView('empty');
      }
      renderConversationList();
    }
  });

  document.body.appendChild(menu);
  activeContextMenu = menu;

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', closeContextMenu, { once: true });
  }, 0);
}

function closeContextMenu() {
  if (activeContextMenu) {
    activeContextMenu.remove();
    activeContextMenu = null;
  }
}

// ─── Inline rename ────────────────────────────────────────────────────────────
function startInlineRename(conv) {
  const convItem = dom.convList.querySelector(`[data-conv-id="${conv.id}"]`);
  if (!convItem) return;

  const titleEl = convItem.querySelector('.conv-title');
  if (!titleEl) return;

  const currentTitle = buildConvTitle(conv);
  titleEl.innerHTML = '';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'conv-rename-input';
  input.value = currentTitle;
  titleEl.appendChild(input);
  input.focus();
  input.select();

  const finish = async (save) => {
    const newTitle = input.value.trim();
    if (save && newTitle && newTitle !== currentTitle) {
      await fetch(`/api/conversations/${encodeURIComponent(conv.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle }),
      });
      conv.title = newTitle;
    }
    renderConversationList();
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', e => e.stopPropagation());
}

// ─── Open a conversation ──────────────────────────────────────────────────────
async function openConversation(convId) {
  currentConvId = convId;
  lastViewedAt[convId] = new Date().toISOString();

  const conv = conversations.find(c => c.id === convId);
  showView('chat');
  renderChatHeader(conv);
  dom.messages.innerHTML = '';
  ensureMessageSpacer();

  // Clear typing for this conv
  if (typingAgents[convId]) {
    removeTypingIndicator(convId);
  }

  try {
    const resp = await fetch(`/api/messages/${encodeURIComponent(convId)}`);
    currentMessages = await resp.json();
    renderMessages(currentMessages);
  } catch(e) {
    console.error('Failed to load messages', e);
  }

  // Re-show any active typing indicators
  if (typingAgents[convId] && typingAgents[convId].size > 0) {
    showTypingIndicator(convId, [...typingAgents[convId]]);
  }

  renderConversationList();
  dom.messageInput.focus();
}

function renderChatHeader(conv) {
  if (!conv) { dom.chatParticipants.innerHTML = ''; return; }
  const parts = conv.participants || [];
  dom.chatParticipants.innerHTML = parts.map(p => {
    const agent = agentByName(p);
    if (!agent) return '';
    const presStatus = agentPresence[agent.id] || 'unknown';
    return `
      <div class="participant-chip" data-agent-id="${agent.id}" title="Click to remove ${agent.name}">
        <div class="participant-avatar" style="background:${agent.color}">${agent.name[0]}</div>
        <span>${agent.name}</span>
        <div class="presence-dot ${presStatus}" style="width:7px;height:7px;"></div>
        <span class="chip-remove" data-remove="${agent.id}">&times;</span>
      </div>
    `;
  }).join('');

  // Wire up remove buttons
  dom.chatParticipants.querySelectorAll('.chip-remove').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const agentId = btn.dataset.remove;
      const agent = AGENT_MAP[agentId];
      if (!confirm(`Remove ${agent?.name || agentId} from this conversation?`)) return;
      try {
        await fetch(`/api/conversations/${encodeURIComponent(currentConvId)}/participants/${encodeURIComponent(agentId)}`, {
          method: 'DELETE',
        });
        if (conv.participants) {
          conv.participants = conv.participants.filter(p => p !== agentId);
        }
        renderChatHeader(conv);
      } catch(e) { console.error('Failed to remove participant', e); }
    });
  });
}

// ─── Typing indicator ─────────────────────────────────────────────────────────
function showTypingIndicator(convId, agentNames) {
  if (!typingAgents[convId]) typingAgents[convId] = new Set();
  for (const n of agentNames) typingAgents[convId].add(n);

  if (convId !== currentConvId) return;

  removeTypingIndicator(convId); // Remove old one first

  const names = [...typingAgents[convId]];
  if (names.length === 0) return;

  const indicator = document.createElement('div');
  indicator.id = 'typing-indicator';
  indicator.className = 'msg-wrapper agent';
  const agentList = names.map(n => {
    const a = agentByName(n);
    return a ? a.name : n;
  }).join(', ');

  indicator.innerHTML = `
    <div class="msg-label">
      <div class="typing-dots">
        <span></span><span></span><span></span>
      </div>
      <span class="typing-label">${escHtml(agentList)} ${names.length === 1 ? 'is' : 'are'} thinking…</span>
    </div>
  `;
  dom.messages.appendChild(indicator);
  scrollToBottom();
}

function removeTypingIndicator(convId) {
  const el = document.getElementById('typing-indicator');
  if (el) el.remove();
}

function stopTyping(agentName, convId) {
  if (typingAgents[convId]) {
    typingAgents[convId].delete(agentName);
    if (typingAgents[convId].size === 0) {
      delete typingAgents[convId];
      removeTypingIndicator(convId);
    } else if (convId === currentConvId) {
      // Redraw with remaining agents
      removeTypingIndicator(convId);
      showTypingIndicator(convId, []);
    }
  }
}

// ─── Render messages ──────────────────────────────────────────────────────────
function renderMessages(msgs) {
  dom.messages.innerHTML = '';
  ensureMessageSpacer();
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];
    const prev = msgs[i - 1];
    const isConsecutive = prev &&
      prev.sender === msg.sender &&
      (new Date(msg.timestamp) - new Date(prev.timestamp)) < 2 * 60 * 1000;
    appendMessage(msg, isConsecutive);
  }
  scrollToBottom();
}

function appendMessage(msg, consecutive = false) {
  const isHuman = msg.sender_type === 'human' || msg.sender === USER_NAME;
  const isSystem = msg.sender_type === 'system' || msg.sender === 'system';

  const wrapper = document.createElement('div');

  if (isSystem) {
    wrapper.className = 'msg-wrapper system';
    wrapper.innerHTML = `<div class="msg-system">${escHtml(msg.body || '')}</div>`;
    dom.messages.appendChild(wrapper);
    return;
  }

  const agent = isHuman ? null : agentByName(msg.sender);
  const agentColor = agent ? agent.color : '#888';
  const senderLabel = isHuman ? USER_NAME : (agent ? agent.name : msg.sender);
  const fullTime = formatFullTime(msg.timestamp);

  wrapper.className = `msg-wrapper ${isHuman ? 'human' : 'agent'}${consecutive ? ' consecutive' : ''}`;
  wrapper.dataset.msgId = msg.id;
  if (!isHuman && !isSystem) wrapper.dataset.sender = (msg.sender || "").toLowerCase();

  const avatarHtml = !isHuman ? `
    <div class="msg-avatar" style="background:${agentColor}">${senderLabel[0].toUpperCase()}</div>
  ` : '';

  wrapper.innerHTML = `
    <div class="msg-label">
      ${avatarHtml}
      <span>${escHtml(senderLabel)}</span>
    </div>
    <div class="msg-bubble-row">
      <div class="msg-bubble" data-raw="${escHtml(msg.body || '')}">${renderMarkdown(msg.body || '')}</div>
      <div class="msg-time" title="${escHtml(fullTime)}">${formatTime(msg.timestamp)}</div>
    </div>
    <div class="msg-actions">
      <button class="msg-action-btn copy-btn" title="Copy message" data-msg-id="${escHtml(msg.id)}">⎘</button>
    </div>
  `;

  // Copy button
  wrapper.querySelector('.copy-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const raw = msg.body || '';
    navigator.clipboard.writeText(raw).then(() => {
      const btn = wrapper.querySelector('.copy-btn');
      btn.textContent = '✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = '⎘'; btn.classList.remove('copied'); }, 1500);
    }).catch(() => {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = raw;
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    });
  });

  dom.messages.appendChild(wrapper);
}

function scrollToBottom() {
  const container = dom.messages.parentElement;
  container.scrollTop = container.scrollHeight;
}

// ─── New chat flow ────────────────────────────────────────────────────────────
dom.newChatBtn.addEventListener('click', showNewChat);
dom.emptyNewChatBtn.addEventListener('click', showNewChat);

function showNewChat() {
  currentConvId = null;
  selectedAgents.clear();
  showView('new-chat');
  renderAgentGrid();
  renderSelectedPills();
  dom.newChatInput.value = '';
  dom.newChatInput.focus();
  renderConversationList();
}

function renderAgentGrid() {
  dom.agentGrid.innerHTML = '';
  for (const agent of AGENTS) {
    const card = document.createElement('div');
    card.className = `agent-card${selectedAgents.has(agent.id) ? ' selected' : ''}`;
    card.style.setProperty('--agent-color', agent.color);
    const presStatus = agentPresence[agent.id] || 'unknown';

    // Show previous conversation count if cached
    const hist = agentHistoryCache[agent.id];
    const histNote = hist && hist.count > 0
      ? `<div class="agent-card-history">${hist.count} previous conversation${hist.count !== 1 ? 's' : ''}</div>`
      : '';

    card.innerHTML = `
      <div class="agent-card-name">
        <div class="presence-dot ${presStatus}"></div>
        <span>${escHtml(agent.name)}</span>
      </div>
      <div class="agent-card-role">${escHtml(agent.role)}</div>
      ${histNote}
    `;
    card.addEventListener('click', () => {
      if (selectedAgents.has(agent.id)) selectedAgents.delete(agent.id);
      else selectedAgents.add(agent.id);
      card.classList.toggle('selected', selectedAgents.has(agent.id));
      renderSelectedPills();
    });
    dom.agentGrid.appendChild(card);
  }
}

function renderSelectedPills() {
  dom.selectedPills.innerHTML = '';
  for (const id of selectedAgents) {
    const agent = AGENT_MAP[id];
    if (!agent) continue;
    const pill = document.createElement('div');
    pill.className = 'agent-pill';
    pill.style.background = agent.color;
    pill.innerHTML = `
      <span>${escHtml(agent.name)}</span>
      <span class="pill-remove" data-id="${id}">×</span>
    `;
    pill.querySelector('.pill-remove').addEventListener('click', () => {
      selectedAgents.delete(id);
      const cards = dom.agentGrid.querySelectorAll('.agent-card');
      cards.forEach(c => {
        if (c.textContent.includes(agent.name)) c.classList.remove('selected');
      });
      renderSelectedPills();
    });
    dom.selectedPills.appendChild(pill);
  }
}

// ─── Agent history loading ────────────────────────────────────────────────────
async function loadAgentHistory(agentId) {
  try {
    const resp = await fetch(`/api/agents/${agentId}/history`);
    const data = await resp.json();
    agentHistoryCache[agentId] = data;
  } catch(e) {}
}

async function loadAllAgentHistory() {
  await Promise.all(AGENTS.map(a => loadAgentHistory(a.id)));
}

// Send new chat
dom.newChatSendBtn.addEventListener('click', sendNewChat);
dom.newChatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendNewChat(); }
});

async function sendNewChat() {
  const body = dom.newChatInput.value.trim();
  if (!body) { dom.newChatInput.focus(); return; }
  if (selectedAgents.size === 0) { alert('Please select at least one agent.'); return; }

  dom.newChatSendBtn.disabled = true;

  const participants = [...selectedAgents];
  const title = participants.map(id => AGENT_MAP[id]?.name || id).join(', ');

  try {
    const resp = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participants,
        title,
        sender: USER_NAME,
        firstMessage: body,
      }),
    });
    const data = await resp.json();
    if (data.id) {
      await loadConversations();
      await openConversation(data.id);
      // Refresh history cache
      for (const id of participants) loadAgentHistory(id);
    }
  } catch(e) {
    console.error('Failed to create conversation', e);
  } finally {
    dom.newChatSendBtn.disabled = false;
  }
}

// ─── Send message in existing chat ───────────────────────────────────────────
dom.sendBtn.addEventListener('click', sendMessage);
dom.messageInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    // Close autocomplete if open, otherwise send
    if (mention.dropdown && !mention.dropdown.classList.contains('hidden')) {
      mention.select();
    } else {
      sendMessage();
    }
  }
  if (e.key === 'Tab' && mention.dropdown && !mention.dropdown.classList.contains('hidden')) {
    e.preventDefault();
    mention.moveSelection(1);
  }
  if (e.key === 'Escape') {
    mention.hide();
  }
  if (e.key === 'ArrowUp' && mention.dropdown && !mention.dropdown.classList.contains('hidden')) {
    e.preventDefault();
    mention.moveSelection(-1);
  }
  if (e.key === 'ArrowDown' && mention.dropdown && !mention.dropdown.classList.contains('hidden')) {
    e.preventDefault();
    mention.moveSelection(1);
  }
});

// Auto-resize textarea
dom.messageInput.addEventListener('input', () => {
  dom.messageInput.style.height = 'auto';
  dom.messageInput.style.height = Math.min(dom.messageInput.scrollHeight, 160) + 'px';
  mention.onInput();
});

// Also handle new-chat-input auto-resize + mention
dom.newChatInput.addEventListener('input', () => {
  mention.onInput();
});
dom.newChatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !(mention.dropdown && !mention.dropdown.classList.contains('hidden'))) {
    e.preventDefault();
    sendNewChat();
  }
  if (e.key === 'Tab' && mention.dropdown && !mention.dropdown.classList.contains('hidden')) {
    e.preventDefault();
    mention.moveSelection(1);
  }
  if (e.key === 'Escape') mention.hide();
  if (e.key === 'ArrowUp' && mention.dropdown && !mention.dropdown.classList.contains('hidden')) {
    e.preventDefault();
    mention.moveSelection(-1);
  }
  if (e.key === 'ArrowDown' && mention.dropdown && !mention.dropdown.classList.contains('hidden')) {
    e.preventDefault();
    mention.moveSelection(1);
  }
  if (e.key === 'Enter' && mention.dropdown && !mention.dropdown.classList.contains('hidden')) {
    e.preventDefault();
    mention.select();
  }
});

async function sendMessage() {
  if (!currentConvId) return;
  const body = dom.messageInput.value.trim();
  if (!body) return;

  mention.hide();
  dom.messageInput.value = '';
  dom.messageInput.style.height = 'auto';
  dom.sendBtn.disabled = true;

  // Smart routing: @mentions target specific agents, no @mention targets all participants
  const mentionRegex = /@(\w+)/g;
  let match;
  const conv = conversations.find(c => c.id === currentConvId);
  const currentParticipants = new Set((conv?.participants || []).map(p => p.toLowerCase()));
  const mentionedAgents = [];

  while ((match = mentionRegex.exec(body)) !== null) {
    const mentioned = match[1].toLowerCase();
    const agent = agentByName(mentioned);
    if (agent) {
      mentionedAgents.push(agent.id);
      // If mentioned agent isn't a participant, add them as a guest (temporary)
      if (!currentParticipants.has(agent.id)) {
        try {
          await fetch(`/api/conversations/${encodeURIComponent(currentConvId)}/participants`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent_name: agent.id }),
          });
          if (conv) {
            conv.participants = conv.participants || [];
            if (!conv.participants.includes(agent.id)) conv.participants.push(agent.id);
          }
        } catch(e) { console.error('Failed to add participant', e); }
      }
    }
  }

  renderChatHeader(conv);

  // If @mentions present → route ONLY to mentioned agents
  // If no @mentions → route to all participants
  const allParticipants = conv?.participants || [];
  const targets = mentionedAgents.length > 0
    ? [...new Set(mentionedAgents)]  // dedupe
    : (allParticipants.length > 0 ? allParticipants : []);

  try {
    await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: USER_NAME,
        senderType: 'human',
        body,
        conversationId: currentConvId,
        targets,
      }),
    });
    // Message appears via SSE; typing indicators will fire via SSE too
  } catch(e) {
    console.error('Failed to send message', e);
  } finally {
    dom.sendBtn.disabled = false;
    dom.messageInput.focus();
  }
}

// ─── @mention Autocomplete ────────────────────────────────────────────────────
const mention = {
  dropdown: null,
  currentInput: null,
  atPos: -1,
  query: '',
  selectedIdx: 0,
  filtered: [],

  init() {
    // Create dropdown element
    this.dropdown = document.createElement('div');
    this.dropdown.id = 'mention-dropdown';
    this.dropdown.className = 'mention-dropdown hidden';
    document.body.appendChild(this.dropdown);
  },

  getActiveInput() {
    const focused = document.activeElement;
    if (focused === dom.messageInput || focused === dom.newChatInput) return focused;
    return null;
  },

  onInput() {
    const input = this.getActiveInput();
    if (!input) { this.hide(); return; }

    const val = input.value;
    const pos = input.selectionStart || 0;

    // Find last @ before cursor
    let atIdx = -1;
    for (let i = pos - 1; i >= 0; i--) {
      if (val[i] === '@') { atIdx = i; break; }
      if (/\s/.test(val[i])) break;
    }

    if (atIdx === -1) { this.hide(); return; }

    const query = val.slice(atIdx + 1, pos).toLowerCase();
    this.atPos = atIdx;
    this.query = query;
    this.currentInput = input;

    this.filtered = AGENTS.filter(a =>
      a.name.toLowerCase().startsWith(query) ||
      a.id.toLowerCase().startsWith(query)
    );

    if (this.filtered.length === 0) { this.hide(); return; }

    this.selectedIdx = 0;
    this.render(input);
  },

  render(input) {
    this.dropdown.innerHTML = '';
    this.dropdown.classList.remove('hidden');

    for (let i = 0; i < this.filtered.length; i++) {
      const agent = this.filtered[i];
      const presStatus = agentPresence[agent.id] || 'unknown';
      const item = document.createElement('div');
      item.className = `mention-item${i === this.selectedIdx ? ' selected' : ''}`;
      item.innerHTML = `
        <div class="mention-avatar" style="background:${agent.color}">${agent.name[0]}</div>
        <div class="mention-info">
          <span class="mention-name">${escHtml(agent.name)}</span>
          <span class="mention-role">${escHtml(agent.role)}</span>
        </div>
        <div class="presence-dot ${presStatus}" style="margin-left:auto;flex-shrink:0"></div>
      `;
      item.addEventListener('mousedown', (e) => {
        e.preventDefault(); // Don't blur input
        this.selectedIdx = i;
        this.select();
      });
      this.dropdown.appendChild(item);
    }

    // Position above the input
    this.position(input);
  },

  position(input) {
    const rect = input.getBoundingClientRect();
    const ddHeight = Math.min(this.filtered.length * 48, 240);
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;

    let top, left;
    left = rect.left;

    if (spaceAbove > ddHeight + 8 || spaceAbove > spaceBelow) {
      // Show above
      top = rect.top - ddHeight - 6;
    } else {
      // Show below
      top = rect.bottom + 6;
    }

    // Keep in viewport
    const ddWidth = 220;
    if (left + ddWidth > window.innerWidth) left = window.innerWidth - ddWidth - 8;

    this.dropdown.style.top = `${Math.max(4, top)}px`;
    this.dropdown.style.left = `${Math.max(4, left)}px`;
    this.dropdown.style.width = `${ddWidth}px`;
  },

  hide() {
    if (this.dropdown) this.dropdown.classList.add('hidden');
    this.atPos = -1;
    this.query = '';
    this.filtered = [];
  },

  select() {
    if (!this.currentInput || this.filtered.length === 0) { this.hide(); return; }
    const agent = this.filtered[this.selectedIdx];
    if (!agent) return;

    const val = this.currentInput.value;
    const before = val.slice(0, this.atPos);
    const after = val.slice(this.atPos + 1 + this.query.length);
    const newVal = before + '@' + agent.name + ' ' + after;
    this.currentInput.value = newVal;
    const newPos = this.atPos + agent.name.length + 2;
    this.currentInput.setSelectionRange(newPos, newPos);
    this.currentInput.dispatchEvent(new Event('input'));
    this.hide();
    this.currentInput.focus();
  },

  moveSelection(dir) {
    if (this.filtered.length === 0) return;
    this.selectedIdx = (this.selectedIdx + dir + this.filtered.length) % this.filtered.length;
    const items = this.dropdown.querySelectorAll('.mention-item');
    items.forEach((el, i) => el.classList.toggle('selected', i === this.selectedIdx));
    // Scroll into view
    if (items[this.selectedIdx]) {
      items[this.selectedIdx].scrollIntoView({ block: 'nearest' });
    }
  },
};

// ─── Add agent dropdown ───────────────────────────────────────────────────────
dom.addAgentBtn.addEventListener('click', e => {
  e.stopPropagation();
  const dropdown = dom.addAgentDropdown;
  if (!dropdown.classList.contains('hidden')) {
    dropdown.classList.add('hidden');
    return;
  }
  const conv = conversations.find(c => c.id === currentConvId);
  const current = new Set((conv?.participants || []).map(p => p.toLowerCase()));
  const available = AGENTS.filter(a => !current.has(a.id));

  if (!available.length) {
    dropdown.innerHTML = '<div class="add-agent-option" style="color:var(--text-muted)">All agents already in chat</div>';
  } else {
    dropdown.innerHTML = available.map(a => `
      <div class="add-agent-option" data-agent-id="${a.id}">
        <div class="msg-avatar" style="background:${a.color};width:22px;height:22px;font-size:11px">${a.name[0]}</div>
        <span>${escHtml(a.name)}</span>
        <div class="presence-dot ${agentPresence[a.id] || 'unknown'}" style="margin-left:auto"></div>
      </div>
    `).join('');

    dropdown.querySelectorAll('.add-agent-option[data-agent-id]').forEach(opt => {
      opt.addEventListener('click', async () => {
        const agentId = opt.dataset.agentId;
        dropdown.classList.add('hidden');
        await addAgentToConversation(agentId);
      });
    });
  }

  dropdown.classList.remove('hidden');
});

document.addEventListener('click', e => {
  if (!dom.addAgentDropdown.contains(e.target) && e.target !== dom.addAgentBtn) {
    dom.addAgentDropdown.classList.add('hidden');
  }
  // Also close mention dropdown on outside click
  if (mention.dropdown && !mention.dropdown.contains(e.target)) {
    const focused = document.activeElement;
    if (focused !== dom.messageInput && focused !== dom.newChatInput) {
      mention.hide();
    }
  }
});

async function addAgentToConversation(agentId) {
  if (!currentConvId) return;
  const conv = conversations.find(c => c.id === currentConvId);

  try {
    await fetch(`/api/conversations/${encodeURIComponent(currentConvId)}/participants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_name: agentId }),
    });

    if (conv) {
      if (!conv.participants) conv.participants = [];
      if (!conv.participants.includes(agentId)) conv.participants.push(agentId);
    }

    renderChatHeader(conv);

    const agent = AGENT_MAP[agentId];
    const systemMsg = `${agent?.name || agentId} has been added to the conversation.`;
    await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: 'system',
        senderType: 'system',
        body: systemMsg,
        conversationId: currentConvId,
        targets: [agentId],
      }),
    });
  } catch(e) {
    console.error('Failed to add agent', e);
  }
}

// ─── Load conversations + participants ────────────────────────────────────────
async function loadConversations() {
  try {
    const resp = await fetch('/api/conversations');
    const raw = await resp.json();

    conversations = await Promise.all(raw.map(async conv => {
      try {
        const pResp = await fetch(`/api/conversations/${encodeURIComponent(conv.id)}/participants`);
        const parts = await pResp.json();
        conv.participants = parts.map(p => p.agent_name);
      } catch(e) {
        conv.participants = [];
      }
      return conv;
    }));

    renderConversationList();
  } catch(e) {
    console.error('Failed to load conversations', e);
  }
}

// ─── Load agent presence ──────────────────────────────────────────────────────
// ─── Load user config from server ────────────────────────────────────────────
async function loadConfig() {
  try {
    const resp = await fetch('/api/config');
    const data = await resp.json();
    if (data.userName) USER_NAME = data.userName;
  } catch(e) {}
}

async function loadAgentPresence() {
  try {
    const resp = await fetch('/api/agents');
    const data = await resp.json();

    // Populate AGENTS array from server on first load
    if (AGENTS.length === 0 && data.length > 0) {
      for (const agent of data) {
        // Server returns agents with name/label/color; normalise to id/name/color/role
        AGENTS.push({
          id:    agent.name,
          name:  agent.label || agent.name,
          color: agent.color || '#888',
          role:  agent.role  || '',
        });
        AGENT_MAP[agent.name] = AGENTS[AGENTS.length - 1];
      }
    }

    for (const agent of data) {
      agentPresence[agent.name] = agent.status;
      const a = agentByName(agent.name);
      if (a) agentPresence[a.id] = agent.status;
    }
    renderConversationList();
    renderFilterBar();
    if (currentConvId) {
      const conv = conversations.find(c => c.id === currentConvId);
      renderChatHeader(conv);
    }
  } catch(e) {}
}

// ─── SSE ─────────────────────────────────────────────────────────────────────
let sse = null;

function connectSSE() {
  if (sse) sse.close();
  sse = new EventSource('/events');

  sse.addEventListener('message', e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch(_) { return; }
    handleIncomingMessage(msg);
  });

  sse.addEventListener('agent_presence', e => {
    try {
      const data = JSON.parse(e.data);
      if (data.agent && data.status) {
        agentPresence[data.agent] = data.status;
        const a = agentByName(data.agent);
        if (a) agentPresence[a.id] = data.status;
      }
      if (data.peers) {
        for (const peer of data.peers) {
          const name = typeof peer === 'string' ? peer : (peer.agent || peer.name);
          if (name) {
            const a = agentByName(name);
            if (a) agentPresence[a.id] = 'online';
          }
        }
      }
      renderConversationList();
      renderFilterBar();
      if (currentConvId) {
        const conv = conversations.find(c => c.id === currentConvId);
        renderChatHeader(conv);
      }
    } catch(_) {}
  });

  sse.addEventListener('presence_update', e => {
    try {
      const data = JSON.parse(e.data);
      if (Array.isArray(data)) {
        for (const p of data) {
          const a = agentByName(p.agent_name);
          if (a) agentPresence[a.id] = p.status;
        }
      }
      renderFilterBar();
    } catch(_) {}
  });

  sse.addEventListener('pulse_status', e => {
    try {
      const data = JSON.parse(e.data);
      console.log('[Pulse]', data.connected ? 'connected' : 'disconnected');
    } catch(_) {}
  });

  sse.addEventListener('typing_start', e => {
    try {
      const data = JSON.parse(e.data);
      const { agentName, conversationId } = data;
      if (!typingAgents[conversationId]) typingAgents[conversationId] = new Set();
      typingAgents[conversationId].add(agentName);
      if (conversationId === currentConvId) {
        showTypingIndicator(conversationId, [agentName]);
      }
    } catch(_) {}
  });

  sse.addEventListener('typing_stop', e => {
    try {
      const data = JSON.parse(e.data);
      stopTyping(data.agentName, data.conversationId);
    } catch(_) {}
  });

  sse.addEventListener('conversation_updated', e => {
    try {
      const data = JSON.parse(e.data);
      const conv = conversations.find(c => c.id === data.id);
      if (conv) {
        if (typeof data.title === 'string') conv.title = data.title;
        if (typeof data.pinned !== 'undefined') conv.pinned = data.pinned ? 1 : 0;
        // Re-sort if pinned changed
        conversations.sort((a, b) => {
          const ap = a.pinned || 0, bp = b.pinned || 0;
          if (bp !== ap) return bp - ap;
          return new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0);
        });
        renderConversationList();
      }
    } catch(_) {}
  });

  sse.addEventListener('conversation_deleted', e => {
    try {
      const data = JSON.parse(e.data);
      conversations = conversations.filter(c => c.id !== data.id);
      if (currentConvId === data.id) {
        currentConvId = null;
        showView('empty');
      }
      renderConversationList();
    } catch(_) {}
  });

  sse.onerror = () => {
    sse.close();
    setTimeout(connectSSE, 3000);
  };
}

function handleIncomingMessage(msg) {
  if (!msg || !msg.id) return;

  // Stop typing for this sender/conv
  if (msg.sender && msg.conversation_id) {
    stopTyping(msg.sender, msg.conversation_id);
  }

  const convIdx = conversations.findIndex(c => c.id === msg.conversation_id);
  if (convIdx >= 0) {
    conversations[convIdx].last_message_at = msg.timestamp;
    conversations[convIdx].last_sender = msg.sender;
    conversations[convIdx].last_body = msg.body;
    // Move to top, preserving pinned order
    const conv = conversations.splice(convIdx, 1)[0];
    // Insert after pinned items
    const firstUnpinned = conversations.findIndex(c => !(c.pinned));
    if (firstUnpinned === -1 || conv.pinned) {
      conversations.unshift(conv);
    } else {
      conversations.splice(firstUnpinned, 0, conv);
    }
  } else if (msg.conversation_id) {
    loadConversations();
    return;
  }

  renderConversationList();

  if (msg.conversation_id === currentConvId) {
    const prev = currentMessages[currentMessages.length - 1];
    const isConsecutive = prev &&
      prev.sender === msg.sender &&
      (new Date(msg.timestamp) - new Date(prev.timestamp)) < 2 * 60 * 1000;

    if (!currentMessages.find(m => m.id === msg.id)) {
      currentMessages.push(msg);
      appendMessage(msg, isConsecutive);
      scrollToBottom();
    }
  } else {
    const conv = conversations.find(c => c.id === msg.conversation_id);
    if (conv) {
      lastViewedAt[conv.id] = lastViewedAt[conv.id] || null;
      renderConversationList();
    }
  }
}

// ─── Push Notifications ──────────────────────────────────────────────────────
let pushSubscription = null;
let pushEnabled = false;

async function getPushVapidKey() {
  try {
    const r = await fetch('/api/push/vapid-public-key');
    const d = await r.json();
    return d.publicKey || null;
  } catch(_) { return null; }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

async function subscribePush(registration) {
  const publicKey = await getPushVapidKey();
  if (!publicKey) return null;
  try {
    const sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub),
    });
    pushSubscription = sub;
    pushEnabled = true;
    updateNotifBtn();
    console.log('[Push] Subscribed');
    return sub;
  } catch(e) {
    console.warn('[Push] Subscribe failed:', e.message);
    return null;
  }
}

async function unsubscribePush() {
  if (!pushSubscription) return;
  try {
    await fetch('/api/push/unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: pushSubscription.endpoint }),
    });
    await pushSubscription.unsubscribe();
    pushSubscription = null;
    pushEnabled = false;
    updateNotifBtn();
    console.log('[Push] Unsubscribed');
  } catch(e) {
    console.warn('[Push] Unsubscribe failed:', e.message);
  }
}

function updateNotifBtn() {
  if (!dom.notifBtn) return;
  dom.notifBtn.textContent = pushEnabled ? '🔔' : '🔕';
  dom.notifBtn.title = pushEnabled ? 'Notifications ON — tap to disable' : 'Notifications OFF — tap to enable';
  dom.notifBtn.classList.toggle('notif-active', pushEnabled);
}

async function initPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.log('[Push] Not supported in this browser');
    if (dom.notifBtn) dom.notifBtn.style.display = 'none';
    return;
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    console.log('[SW] Registered');

    // Listen for messages from SW (notification click → open conv)
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'notification_click' && e.data.conversationId) {
        const conv = conversations.find(c => c.id === e.data.conversationId);
        if (conv) openConversation(conv.id);
      }
    });

    // Check if already subscribed
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      pushSubscription = existing;
      pushEnabled = true;
      updateNotifBtn();
      console.log('[Push] Already subscribed');
    } else {
      updateNotifBtn();
    }

    // Wire up the 🔔 button
    if (dom.notifBtn) {
      dom.notifBtn.addEventListener('click', async () => {
        if (pushEnabled) {
          await unsubscribePush();
        } else {
          const permission = await Notification.requestPermission();
          if (permission === 'granted') {
            await subscribePush(registration);
          } else {
            alert('Notification permission denied. Enable it in your browser settings.');
          }
        }
      });
    }

    // Auto-prompt on first visit if no decision made yet
    if (Notification.permission === 'default' && !existing) {
      // Don't auto-prompt — let user tap the bell
    }

  } catch(e) {
    console.warn('[SW] Registration failed:', e.message);
    if (dom.notifBtn) dom.notifBtn.style.display = 'none';
  }
}

// ─── Swipe to open/close sidebar (mobile) ────────────────────────────────────
(function initSwipe() {
  let touchStartX = 0;
  let touchStartY = 0;
  const SWIPE_THRESHOLD = 60;
  const EDGE_ZONE = 30; // px from left edge to start open gesture

  document.addEventListener('touchstart', e => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;

    // Ignore if mostly vertical
    if (Math.abs(dy) > Math.abs(dx) * 1.5) return;
    if (Math.abs(dx) < SWIPE_THRESHOLD) return;

    const isMobile = window.innerWidth <= 768;
    if (!isMobile) return;

    if (dx > 0 && touchStartX < EDGE_ZONE) {
      // Swipe right from left edge → open sidebar
      openSidebar();
    } else if (dx < 0 && dom.sidebar.classList.contains('open')) {
      // Swipe left while open → close sidebar
      closeSidebar();
    }
  }, { passive: true });
})();

// ─── Keyboard / visualViewport handling (mobile) ─────────────────────────────
(function initViewportHandler() {
  if (!window.visualViewport) return;

  let lastHeight = window.visualViewport.height;

  window.visualViewport.addEventListener('resize', () => {
    const currentHeight = window.visualViewport.height;
    const diff = lastHeight - currentHeight;
    lastHeight = currentHeight;

    // Keyboard opened (height shrunk significantly)
    if (diff > 100) {
      // Scroll compose area into view
      const compose = document.getElementById('compose-area');
      if (compose) {
        setTimeout(() => {
          compose.scrollIntoView({ block: 'end', behavior: 'smooth' });
          scrollToBottom();
        }, 100);
      }
    }
  });
})();

// ─── Long-press copy on mobile (tap-hold on bubble) ──────────────────────────
(function initLongPress() {
  let longPressTimer = null;
  const LONG_PRESS_MS = 500;

  document.addEventListener('touchstart', e => {
    const bubble = e.target.closest('.msg-bubble');
    if (!bubble) return;
    longPressTimer = setTimeout(() => {
      const wrapper = bubble.closest('.msg-wrapper');
      if (!wrapper) return;
      // Show actions momentarily
      const actions = wrapper.querySelector('.msg-actions');
      if (actions) {
        actions.style.opacity = '1';
        actions.style.transition = 'none';
        setTimeout(() => {
          actions.style.opacity = '';
          actions.style.transition = '';
        }, 2500);
      }
      // Copy to clipboard
      const raw = bubble.dataset.raw || bubble.textContent || '';
      if (navigator.clipboard) {
        navigator.clipboard.writeText(raw).then(() => {
          const copyBtn = wrapper.querySelector('.copy-btn');
          if (copyBtn) {
            const orig = copyBtn.textContent;
            copyBtn.textContent = '✓';
            copyBtn.classList.add('copied');
            setTimeout(() => { copyBtn.textContent = orig; copyBtn.classList.remove('copied'); }, 1500);
          }
        }).catch(() => {});
      }
    }, LONG_PRESS_MS);
  }, { passive: true });

  document.addEventListener('touchend', () => {
    clearTimeout(longPressTimer);
  }, { passive: true });

  document.addEventListener('touchmove', () => {
    clearTimeout(longPressTimer);
  }, { passive: true });
})();

// ─── Spacer for messages-push-to-bottom ──────────────────────────────────────
function ensureMessageSpacer() {
  const existing = dom.messages.querySelector('.msg-spacer');
  if (!existing) {
    const spacer = document.createElement('div');
    spacer.className = 'msg-spacer';
    dom.messages.insertBefore(spacer, dom.messages.firstChild);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  mention.init();
  // Load user config and agent list from server first
  await loadConfig();
  await loadAgentPresence();
  renderFilterBar();
  showView('empty');
  await loadConversations();
  await loadAllAgentHistory();
  connectSSE();
  updateNotifBtn();
  initPush();

  setInterval(loadAgentPresence, 30000);
}

init();
