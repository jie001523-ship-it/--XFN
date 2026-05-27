/* ══════════════════════════════════════════════════════════════
   Windows 桌面悬浮待办 — 渲染层逻辑
   ══════════════════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────────────────
let state = {
  todos: [],
  completed: [],
  isCollapsed: true,
  isCompletedExpanded: false,
  isInputVisible: false,
  editingId: null,
  selectedPriority: 'medium',
};

// ── DOM refs ──────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const capsule = $('#capsule');
const badge = $('#badge');
const snapBadge = $('#snap-badge');
const expandArrow = $('#expand-arrow');
const addBtn = $('#add-btn');
const inputPanel = $('#input-panel');
const todoInput = $('#todo-input');
const submitBtn = $('#submit-btn');
const cancelBtn = $('#cancel-btn');
const limitHint = $('#limit-hint');
const todoList = $('#todo-list');
const emptyState = $('#empty-state');
const completedSection = $('#completed-section');
const completedHeader = $('#completed-header');
const completedList = $('#completed-list');
const completedCount = $('#completed-count');
const clearCompletedBtn = $('#clear-completed');
const snapIndicator = $('#snap-indicator');

// ── Priority helpers ──────────────────────────────────────────
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const PRIORITY_CLASS = { high: 'high', medium: 'medium', low: 'low' };

function sortTodos(todos) {
  return [...todos].sort((a, b) => {
    const po = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (po !== 0) return po;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });
}

// ── Relative time ─────────────────────────────────────────────
function relativeTime(dateStr) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return '刚刚';
  if (sec < 60) return `过去 ${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `过去 ${min} 分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `过去 ${hr} 小时`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `过去 ${day} 天`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `过去 ${mon} 个月`;
  const yr = Math.floor(mon / 12);
  return `过去 ${yr} 年`;
}

// ── Data loading ──────────────────────────────────────────────
async function loadFromDisk() {
  const data = await window.todoAPI.getData();
  state.todos = data.todos || [];
  state.completed = data.completed || [];
  state.isCollapsed = data.preferences?.isCollapsed ?? true;
  state.isCompletedExpanded = data.preferences?.isCompletedExpanded ?? false;
}

async function saveToDisk() {
  await window.todoAPI.saveData({
    todos: state.todos,
    completed: state.completed,
    preferences: {
      isCollapsed: state.isCollapsed,
      isCompletedExpanded: state.isCompletedExpanded,
    },
  });
}

async function resizeWindow(collapsed) {
  await window.todoAPI.resizeWindow(collapsed);
}

// ── Render ────────────────────────────────────────────────────
function renderBadge() {
  const count = state.todos.filter(t => t.priority === 'high').length;
  if (count > 0) {
    badge.style.display = 'inline-flex';
    badge.textContent = count;
    snapBadge.style.display = 'inline-flex';
    snapBadge.textContent = count;
  } else {
    badge.style.display = 'none';
    snapBadge.style.display = 'none';
  }
}

function renderTodoList() {
  todoList.innerHTML = '';
  const sorted = sortTodos(state.todos);

  if (sorted.length === 0) {
    emptyState.classList.add('visible');
    todoList.style.display = 'none';
  } else {
    emptyState.classList.remove('visible');
    todoList.style.display = 'flex';
  }

  sorted.forEach((todo) => {
    const card = document.createElement('div');
    card.className = 'todo-card';
    card.dataset.id = todo.id;
    card.innerHTML = `
      <div class="card-inner">
        <div class="priority-stripe ${PRIORITY_CLASS[todo.priority]}"></div>
        <div class="card-content">
          <span class="card-title">${escapeHTML(todo.title)}</span>
          <span class="card-time" data-time="${todo.createdAt}">${relativeTime(todo.createdAt)}</span>
        </div>
        <button class="check-btn" title="完成">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </button>
      </div>
      <div class="card-actions">
        <button class="card-action-btn card-action-edit">修改</button>
        <button class="card-action-btn card-action-delete">删除</button>
      </div>
    `;

    card.querySelector('.check-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      completeTodo(todo.id);
    });

    card.querySelector('.card-action-edit').addEventListener('click', (e) => {
      e.stopPropagation();
      openEdit(todo);
    });

    card.querySelector('.card-action-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteTodo(todo.id);
    });

    setupCardDrag(card);
    todoList.appendChild(card);
  });
}

function renderCompletedList() {
  completedList.innerHTML = '';
  const sorted = [...state.completed].sort(
    (a, b) => new Date(b.completedAt) - new Date(a.completedAt)
  );

  sorted.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'completed-item';
    div.innerHTML = `
      <div class="priority-stripe ${PRIORITY_CLASS[item.priority]}" style="height:28px"></div>
      <div class="card-content">
        <span class="card-title">${escapeHTML(item.title)}</span>
        <span class="card-time">${relativeTime(item.completedAt)}</span>
      </div>
      <button class="completed-delete" title="删除">&times;</button>
    `;
    div.querySelector('.completed-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteCompleted(item.id);
    });
    completedList.appendChild(div);
  });

  completedCount.textContent = state.completed.length;

  if (state.completed.length > 0) {
    completedSection.classList.add('has-items');
  } else {
    completedSection.classList.remove('has-items');
  }

  if (state.isCompletedExpanded) {
    completedSection.classList.add('expanded');
  } else {
    completedSection.classList.remove('expanded');
  }
}

function updateUIMode() {
  // Clear any lingering hover classes — explicit toggle always wins
  app.classList.remove('hover-expanded-snap', 'hover-expanded-collapse');
  if (state.isCollapsed) {
    app.classList.remove('expanded');
    app.classList.add('collapsed');
  } else {
    app.classList.remove('collapsed');
    app.classList.add('expanded');
  }
}

function updateInputMode() {
  if (state.isInputVisible) {
    inputPanel.classList.add('visible');
    submitBtn.textContent = state.editingId ? '保存' : '添加';
    cancelBtn.style.display = (state.editingId || state.todos.length > 0) ? '' : 'none';
  } else {
    inputPanel.classList.remove('visible');
    todoInput.value = '';
    state.editingId = null;
    state.selectedPriority = 'medium';
    updatePriorityButtons();
  }
  updateLimitHint();
}

function updatePriorityButtons() {
  document.querySelectorAll('.priority-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.priority === state.selectedPriority);
  });
}

function updateLimitHint() {
  if (state.todos.length >= 30 && !state.editingId) {
    limitHint.style.display = 'block';
    submitBtn.disabled = true;
  } else {
    limitHint.style.display = 'none';
    submitBtn.disabled = false;
  }
}

function renderAll() {
  renderBadge();
  renderTodoList();
  renderCompletedList();
  updateUIMode();
  updateInputMode();
}

// ── Time refresh ──────────────────────────────────────────────
function refreshTimes() {
  document.querySelectorAll('.card-time').forEach(el => {
    const t = el.dataset.time;
    if (t) el.textContent = relativeTime(t);
  });
}
setInterval(refreshTimes, 30000);

// ── Actions ───────────────────────────────────────────────────
async function addTodo() {
  const title = todoInput.value.trim();
  if (!title) return;

  if (state.todos.length >= 30) {
    updateLimitHint();
    return;
  }

  const todo = {
    id: generateId(),
    title,
    priority: state.selectedPriority,
    createdAt: new Date().toISOString(),
  };

  state.todos.push(todo);
  state.todos = sortTodos(state.todos);
  closeInput();
  await saveToDisk();
  renderAll();
}

async function completeTodo(id) {
  const idx = state.todos.findIndex(t => t.id === id);
  if (idx === -1) return;

  const [completed] = state.todos.splice(idx, 1);
  completed.completedAt = new Date().toISOString();
  state.completed.push(completed);

  await saveToDisk();
  renderAll();
}

async function deleteTodo(id) {
  state.todos = state.todos.filter(t => t.id !== id);
  await saveToDisk();
  renderAll();
}

async function deleteCompleted(id) {
  state.completed = state.completed.filter(c => c.id !== id);
  await saveToDisk();
  renderAll();
}

async function clearCompleted() {
  if (state.completed.length === 0) return;
  state.completed = [];
  await saveToDisk();
  renderAll();
}

function openAdd() {
  if (state.todos.length >= 30) {
    updateLimitHint();
    return;
  }
  state.editingId = null;
  state.selectedPriority = 'medium';
  todoInput.value = '';
  updatePriorityButtons();
  state.isInputVisible = true;
  if (state.isCollapsed) {
    expandWindow();
  }
  updateUIMode();
  updateInputMode();
  todoInput.focus();
}

function openEdit(todo) {
  state.editingId = todo.id;
  state.selectedPriority = todo.priority;
  todoInput.value = todo.title;
  updatePriorityButtons();
  state.isInputVisible = true;
  if (state.isCollapsed) {
    expandWindow();
  }
  updateUIMode();
  updateInputMode();
  todoInput.focus();
}

async function saveEdit() {
  const title = todoInput.value.trim();
  if (!title) return;

  const idx = state.todos.findIndex(t => t.id === state.editingId);
  if (idx !== -1) {
    state.todos[idx].title = title;
    state.todos[idx].priority = state.selectedPriority;
    state.todos = sortTodos(state.todos);
  }
  closeInput();
  await saveToDisk();
  renderAll();
}

function closeInput() {
  state.isInputVisible = false;
  state.editingId = null;
  todoInput.value = '';
  state.selectedPriority = 'medium';
  updatePriorityButtons();
  updateUIMode();
  updateInputMode();
}

async function expandWindow() {
  state.isCollapsed = false;
  await resizeWindow(false);
  await saveToDisk();
}

async function collapseWindow() {
  state.isCollapsed = true;
  state.isInputVisible = false;
  state.editingId = null;
  updateInputMode();
  await resizeWindow(true);
  await saveToDisk();
  renderAll();
}

async function toggleCollapse() {
  if (state.isCollapsed) {
    await expandWindow();
  } else {
    await collapseWindow();
  }
  renderAll();
}

async function toggleCompleted() {
  state.isCompletedExpanded = !state.isCompletedExpanded;
  await saveToDisk();
  renderAll();
}

// ── Card drag ─────────────────────────────────────────────────
function setupCardDrag(card) {
  const inner = card.querySelector('.card-inner');
  if (!inner) return;

  let startX = 0, currentX = 0, hasMoved = false;
  const threshold = 15;

  card.addEventListener('mousedown', (e) => {
    if (e.target.closest('button') || e.target.closest('.card-actions')) return;
    startX = e.clientX;
    hasMoved = false;
    inner.style.transition = 'none';

    const onMove = (ev) => {
      currentX = ev.clientX;
      const dx = currentX - startX;
      if (dx < -5) {
        hasMoved = true;
        inner.style.transform = `translateX(${Math.max(dx, -110)}px)`;
      } else if (!hasMoved && dx > 5) {
        inner.style.transform = 'translateX(0)';
      }
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      inner.style.transition = 'transform 0.28s cubic-bezier(0.22, 0.61, 0.36, 1)';

      if (hasMoved && currentX - startX < -threshold) {
        card.classList.add('swiped');
        inner.style.transform = 'translateX(-110px)';
      } else if (hasMoved) {
        card.classList.remove('swiped');
        inner.style.transform = 'translateX(0)';
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  card.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('.card-actions')) return;
    if (card.classList.contains('swiped') && !hasMoved) {
      card.classList.remove('swiped');
      inner.style.transform = 'translateX(0)';
    }
  });
}

function resetAllSwipes() {
  document.querySelectorAll('.todo-card.swiped').forEach(c => {
    c.classList.remove('swiped');
    const inner = c.querySelector('.card-inner');
    if (inner) inner.style.transform = 'translateX(0)';
  });
}

// ── Helpers ───────────────────────────────────────────────────
function generateId() {
  return 'id_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function escapeHTML(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Event bindings ────────────────────────────────────────────

// Capsule double-click → toggle expand/collapse
capsule.addEventListener('dblclick', (e) => {
  if (e.target.closest('button')) return;
  toggleCollapse();
});

// Expand arrow click → toggle (separate because capsule is a drag region)
expandArrow.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleCollapse();
});

// + button → open add or close input
addBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (state.isInputVisible) {
    closeInput();
  } else {
    openAdd();
  }
});

// Submit button
submitBtn.addEventListener('click', () => {
  if (state.editingId) {
    saveEdit();
  } else {
    addTodo();
  }
});

// Cancel button
cancelBtn.addEventListener('click', () => {
  closeInput();
});

// Keyboard shortcuts
todoInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    state.editingId ? saveEdit() : addTodo();
  } else if (e.key === 'Escape') {
    closeInput();
  }
});

// Priority selector
document.querySelectorAll('.priority-btn').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.selectedPriority = btn.dataset.priority;
    updatePriorityButtons();
  });
});

// Completed section toggle
completedHeader.addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  toggleCompleted();
});

// Clear completed
clearCompletedBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  clearCompleted();
});

// Click panel background to reset swipes
panel.addEventListener('click', (e) => {
  if (e.target === panel || e.target === todoList) {
    resetAllSwipes();
  }
});

// Prevent text selection during drag across the app
app.addEventListener('mousedown', (e) => {
  if (e.target === app || e.target === panel || e.target === todoList) {
    resetAllSwipes();
  }
});

// ── Snap-to-top ────────────────────────────────────────────────
window.todoAPI.onSnapChanged((snapped) => {
  if (snapped) {
    app.classList.add('snapped');
    app.classList.remove('expanded', 'collapsed');
  } else {
    app.classList.remove('snapped');
  }
});

window.todoAPI.onHoverState((state) => {
  app.classList.remove('hover-expanded-snap', 'hover-expanded-collapse');
  if (state === 'expanded-from-snap') {
    app.classList.add('hover-expanded-snap');
  } else if (state === 'expanded-from-collapse') {
    app.classList.add('hover-expanded-collapse');
  }
});

let hoverExpandTimer = null;
let hoverCollapseTimer = null;

function clearAllHoverTimers() {
  if (hoverExpandTimer) { clearTimeout(hoverExpandTimer); hoverExpandTimer = null; }
  if (hoverCollapseTimer) { clearTimeout(hoverCollapseTimer); hoverCollapseTimer = null; }
}

function scheduleHoverExpand() {
  clearAllHoverTimers();
  hoverExpandTimer = setTimeout(() => {
    window.todoAPI.hoverExpand();
    hoverExpandTimer = null;
  }, 500);
}

function scheduleHoverCollapse() {
  clearAllHoverTimers();
  hoverCollapseTimer = setTimeout(() => {
    window.todoAPI.hoverCollapse();
    hoverCollapseTimer = null;
  }, 300);
}

// Hover peek triggers via body mouseover (bubbles from child elements)
document.body.addEventListener('mouseover', (e) => {
  if (snapIndicator.contains(e.target)) {
    scheduleHoverExpand();
  } else if (expandArrow.contains(e.target) && !app.classList.contains('snapped')) {
    scheduleHoverExpand();
  }
});

// Click to persist expand/collapse (cancel hover behavior)
expandArrow.addEventListener('click', () => {
  clearAllHoverTimers();
});

snapIndicator.addEventListener('click', (e) => {
  e.stopPropagation();
  clearAllHoverTimers();
  window.todoAPI.unsnapWindow();
});

// ── Init ──────────────────────────────────────────────────────
async function init() {
  await loadFromDisk();
  renderAll();
}

init();
