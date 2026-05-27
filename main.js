const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const DATA_PATH = path.join(app.getPath('userData'), 'todos.json');

// ── Data helpers ──────────────────────────────────────────────
const DEFAULT_DATA = {
  todos: [],
  completed: [],
  preferences: {
    isCollapsed: true,
    isCompletedExpanded: false,
    autoLaunch: true,
    windowBounds: null,
  },
};

function loadData() {
  try {
    if (fs.existsSync(DATA_PATH)) {
      const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
      // deep-merge with defaults so new fields always exist
      return {
        todos: raw.todos || [],
        completed: raw.completed || [],
        preferences: { ...DEFAULT_DATA.preferences, ...(raw.preferences || {}) },
      };
    }
  } catch (_) { /* corrupt file — fall through */ }
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}

function saveData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// ── Window management ─────────────────────────────────────────
let mainWindow = null;
let tray = null;
let isQuitting = false;

const COLLAPSED_SIZE = { width: 440, height: 130 };
const EXPANDED_SIZE = { width: 540, height: 520 };
const SNAPPED_SIZE = { width: 200, height: 36 };

// ── Snap-to-top ─────────────────────────────────────────────────
const SNAPPED_VISIBLE = 36;
const SNAP_THRESHOLD = 25;
const UNSNAP_THRESHOLD = 55;
let isSnapped = false;
let isSnapping = false;
let isHoverExpanded = false;
let preHoverBounds = null;
let hoverLeavePoll = null;

function startHoverLeavePoll() {
  stopHoverLeavePoll();
  hoverLeavePoll = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed() || !isHoverExpanded) {
      stopHoverLeavePoll();
      return;
    }
    const mousePos = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();
    const isInside =
      mousePos.x >= bounds.x && mousePos.x < bounds.x + bounds.width &&
      mousePos.y >= bounds.y && mousePos.y < bounds.y + bounds.height;
    if (!isInside) {
      isHoverExpanded = false;
      stopHoverLeavePoll();
      if (isSnapped) {
        mainWindow.webContents.send('hover-state', 'snapped');
      } else {
        mainWindow.webContents.send('hover-state', 'collapsed');
      }
    }
  }, 250);
}

function stopHoverLeavePoll() {
  if (hoverLeavePoll) {
    clearInterval(hoverLeavePoll);
    hoverLeavePoll = null;
  }
}

function getStoredBounds() {
  const data = loadData();
  const stored = data.preferences?.windowBounds;
  if (stored && stored.x != null && stored.y != null) {
    const displays = screen.getAllDisplays();
    const visible = displays.some(d => {
      const { x, y, width, height } = d.bounds;
      return stored.x >= x - 200 && stored.x <= x + width - 100 &&
             stored.y >= y - 200 && stored.y <= y + height - 100;
    });
    if (visible) return stored;
  }
  return null;
}

function createWindow() {
  const data = loadData();
  const stored = getStoredBounds();

  const winOpts = {
    width: stored ? stored.width : COLLAPSED_SIZE.width,
    height: stored ? stored.height : COLLAPSED_SIZE.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (stored) {
    winOpts.x = stored.x;
    winOpts.y = stored.y;
  } else {
    // center on primary
    const primary = screen.getPrimaryDisplay();
    const { width: sw, height: sh } = primary.workAreaSize;
    winOpts.x = Math.round((sw - COLLAPSED_SIZE.width) / 2);
    winOpts.y = Math.round((sh - COLLAPSED_SIZE.height) / 2);
  }

  mainWindow = new BrowserWindow(winOpts);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Save window bounds on move/resize
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || isSnapped) return;
    const bounds = mainWindow.getBounds();
    const d = loadData();
    d.preferences.windowBounds = bounds;
    saveData(d);
  };

  // ── Snap-to-top detection ───────────────────────────────────
  const checkSnap = () => {
    if (!mainWindow || mainWindow.isDestroyed() || isSnapping || isHoverExpanded) return;
    const bounds = mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
    const topEdge = display.bounds.y;

    if (!isSnapped && bounds.y <= topEdge + SNAP_THRESHOLD) {
      // Snap: shrink to mini pill at top
      isSnapping = true;
      isSnapped = true;
      mainWindow.setBounds({
        x: bounds.x + Math.round((bounds.width - SNAPPED_SIZE.width) / 2),
        y: topEdge,
        width: SNAPPED_SIZE.width,
        height: SNAPPED_SIZE.height,
      }, true);
      mainWindow.webContents.send('snap-changed', true);
      isSnapping = false;
    } else if (isSnapped && bounds.y > topEdge + UNSNAP_THRESHOLD) {
      // Unsnap by drag: restore collapsed size
      isSnapping = true;
      isSnapped = false;
      mainWindow.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: COLLAPSED_SIZE.width,
        height: COLLAPSED_SIZE.height,
      }, true);
      mainWindow.webContents.send('snap-changed', false);
      isSnapping = false;
    }
  };

  mainWindow.on('move', () => {
    saveBounds();
    checkSnap();
  });
  mainWindow.on('resize', saveBounds);

  mainWindow.on('close', (e) => {
    saveBounds();
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Tray ──────────────────────────────────────────────────────
function createTrayIcon() {
  // 16x16 PNG base64 – simple rounded icon
  const ico = nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAA' +
    'BHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAbwAAAG8B8aLcQwAAABl0RVh0U29mdHdhcmUA' +
    'd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAEoSURBVFiF7ZYxbsIwFIb/5yWVGNgYeoOwseYM' +
    'HIEzcAaOwMqFeoaycoMeoRJDJQYmhJQQO8F2HCd5sUMlhv5vsf38/PZrgqIoTdO/MAJY' +
    'AI6GYQd4AboiB6UUWmu01mit0VojhPiKEMJ7JqUEWZahqiqUZQkRQghUVYU8z5EkCYQQ' +
    'SNMUZVnyXJ7nAmOM3yshRA4AFxcX2O/3WC6XmEwmAIDNZoPtdivH4zH2+72UUpJlMplg' +
    't9tht9tJRBHwBa7rGpPJBKvVCpvNBkopLJdL9Pt9xHEMpRS01tjtdhC2fP+E3W6HYRiQ' +
    'JAm01pjP55RS4rou2u02+v0+wjDE/f39rwHEca8QAmVZQggBKSXCMESn08FgMMB0OsX5' +
    '+Tkmkwm01lBKodlsQvwJQBz3uq4LKSV6vR7CMESv10On08FgMECapri8vMTFxf/cwqL4' +
    'BPtrY8EuIt1OAAAAAElFTkSuQmCC'
  );
  tray = new Tray(ico.resize({ width: 16, height: 16 }));
  updateTrayMenu();
  tray.setToolTip('桌面待办');
  tray.on('double-click', () => {
    if (mainWindow) mainWindow.show();
  });
}

function updateTrayMenu() {
  const data = loadData();
  const autoLaunch = data.preferences?.autoLaunch ?? true;
  const contextMenu = Menu.buildFromTemplate([
    { label: '显示', click: () => { if (mainWindow) mainWindow.show(); } },
    { label: '隐藏', click: () => { if (mainWindow) mainWindow.hide(); } },
    { type: 'separator' },
    {
      label: '开机自启', type: 'checkbox', checked: autoLaunch, click: (mi) => {
        const d = loadData();
        d.preferences.autoLaunch = mi.checked;
        app.setLoginItemSettings({ openAtLogin: mi.checked });
        saveData(d);
      },
    },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
}

// ── Window resize helper ──────────────────────────────────────
function resizeWindow(collapsed) {
  if (!mainWindow) return;
  const size = collapsed ? COLLAPSED_SIZE : EXPANDED_SIZE;
  const current = mainWindow.getBounds();
  const cx = current.x + Math.round(current.width / 2);
  const newX = cx - Math.round(size.width / 2);
  mainWindow.setBounds({ x: newX, y: current.y, width: size.width, height: size.height }, true);
}

// ── IPC handlers ──────────────────────────────────────────────
function setupIPC() {
  ipcMain.handle('get-data', () => loadData());

  ipcMain.handle('save-data', (_event, data) => {
    // merge with existing preferences to avoid losing them
    const existing = loadData();
    const merged = {
      todos: data.todos ?? existing.todos,
      completed: data.completed ?? existing.completed,
      preferences: {
        ...existing.preferences,
        ...(data.preferences || {}),
      },
    };
    saveData(merged);
    return true;
  });

  ipcMain.handle('resize-window', (_event, collapsed) => {
    // Cancel any hover-expand state — user clicked for persistent toggle
    isHoverExpanded = false;
    preHoverBounds = null;
    stopHoverLeavePoll();
    resizeWindow(collapsed);
    return true;
  });

  ipcMain.handle('minimize-window', () => { if (mainWindow) mainWindow.hide(); });

  ipcMain.handle('get-app-version', () => app.getVersion());

  ipcMain.handle('get-auto-launch', () => {
    return loadData().preferences?.autoLaunch ?? true;
  });

  ipcMain.handle('set-auto-launch', (_event, enabled) => {
    const data = loadData();
    data.preferences.autoLaunch = enabled;
    app.setLoginItemSettings({ openAtLogin: enabled });
    saveData(data);
    updateTrayMenu();
    return true;
  });

  ipcMain.handle('get-snap-state', () => isSnapped);

  ipcMain.handle('hover-expand', () => {
    if (!mainWindow || mainWindow.isDestroyed() || isHoverExpanded) return false;
    isHoverExpanded = true;
    const bounds = mainWindow.getBounds();
    preHoverBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });

    if (isSnapped) {
      // Expand from snapped mini pill → full panel
      const cx = bounds.x + Math.round(bounds.width / 2);
      mainWindow.setBounds({
        x: cx - Math.round(EXPANDED_SIZE.width / 2),
        y: display.bounds.y,
        width: EXPANDED_SIZE.width,
        height: EXPANDED_SIZE.height,
      }, true);
      mainWindow.webContents.send('hover-state', 'expanded-from-snap');
    } else {
      const data = loadData();
      if (data.preferences?.isCollapsed !== false) {
        const cx = bounds.x + Math.round(bounds.width / 2);
        mainWindow.setBounds({
          x: cx - Math.round(EXPANDED_SIZE.width / 2),
          y: bounds.y,
          width: EXPANDED_SIZE.width,
          height: EXPANDED_SIZE.height,
        }, true);
        mainWindow.webContents.send('hover-state', 'expanded-from-collapse');
      } else {
        isHoverExpanded = false;
        return false;
      }
    }
    startHoverLeavePoll();
    return true;
  });

  ipcMain.handle('hover-collapse', () => {
    if (!mainWindow || mainWindow.isDestroyed() || !isHoverExpanded) return false;
    isHoverExpanded = false;
    const restore = preHoverBounds;
    preHoverBounds = null;
    stopHoverLeavePoll();

    if (isSnapped) {
      mainWindow.setBounds({
        x: restore ? restore.x : mainWindow.getBounds().x,
        y: 0,
        width: SNAPPED_SIZE.width,
        height: SNAPPED_SIZE.height,
      }, true);
      mainWindow.webContents.send('hover-state', 'snapped');
    } else {
      mainWindow.setBounds({
        x: restore ? restore.x : mainWindow.getBounds().x,
        y: restore ? restore.y : mainWindow.getBounds().y,
        width: COLLAPSED_SIZE.width,
        height: COLLAPSED_SIZE.height,
      }, true);
      mainWindow.webContents.send('hover-state', 'collapsed');
    }
    return true;
  });

  ipcMain.handle('unsnap-window', () => {
    if (!isSnapped || !mainWindow) return false;
    const bounds = mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
    isSnapped = false;
    isHoverExpanded = false;
    stopHoverLeavePoll();
    mainWindow.setBounds({
      x: bounds.x,
      y: Math.max(display.bounds.y + 40, bounds.y),
      width: COLLAPSED_SIZE.width,
      height: COLLAPSED_SIZE.height,
    }, true);
    mainWindow.webContents.send('snap-changed', false);
    return true;
  });
}

// ── App lifecycle ─────────────────────────────────────────────
app.whenReady().then(() => {
  setupIPC();
  createWindow();
  createTrayIcon();
  const data = loadData();
  app.setLoginItemSettings({ openAtLogin: data.preferences?.autoLaunch ?? true });
});

app.on('window-all-closed', () => { /* keep alive in tray */ });

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});

app.on('before-quit', () => { isQuitting = true; });
