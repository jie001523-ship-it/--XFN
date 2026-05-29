const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');

const DATA_PATH = path.join(app.getPath('userData'), 'todos.json');
const DEBUG_LOG_PATH = path.join(__dirname, 'startup-debug.log');

function debugLog(message) {
  try {
    fs.appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${message}\n`, 'utf-8');
  } catch (_) {}
}

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
const SNAPPED_SIZE = { width: 120, height: 36 };

// ── Snap-to-top ─────────────────────────────────────────────────
const SNAPPED_VISIBLE = 36;
const SNAP_THRESHOLD = 25;
const UNSNAP_THRESHOLD = 55;
let isSnapped = false;
let isSnapping = false;
let isHoverExpanded = false;
let cameFromSnap = false;
let preHoverBounds = null;
let hoverLeavePoll = null;

function collapseHoverPreview() {
  if (!mainWindow || mainWindow.isDestroyed() || !isHoverExpanded) return false;

  isHoverExpanded = false;
  const restore = preHoverBounds;
  preHoverBounds = null;
  stopHoverLeavePoll();

  if (isSnapped) {
    mainWindow.setBounds({
      x: restore ? restore.x : mainWindow.getBounds().x,
      y: restore ? restore.y : 0,
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
}

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
      collapseHoverPreview();
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
      sandbox: false,
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
  const rendererPath = path.join(__dirname, 'renderer', 'index.html');
  mainWindow.loadFile(rendererPath);
  mainWindow.webContents.on('did-finish-load', () => debugLog('renderer loaded'));
  mainWindow.webContents.on('dom-ready', () => debugLog('renderer dom-ready'));
  mainWindow.webContents.on('render-process-gone', (_event, details) => debugLog(`renderer gone ${JSON.stringify(details)}`));
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => debugLog(`load failed ${code} ${description} ${url}`));
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => debugLog(`console ${level} ${message} ${sourceId}:${line}`));
  mainWindow.once('ready-to-show', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(true);
  });
  // Keep the window behavior conservative during development; some Windows
  // environments crash when transparent always-on-top windows also request
  // all-workspaces visibility.

  // Save window bounds on move/resize
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || isSnapped) return;
    const bounds = mainWindow.getBounds();
    // If user dragged the expanded-from-snap window away, cancel snap-back
    if (cameFromSnap && bounds.y > 60) {
      cameFromSnap = false;
    }
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

    if (!isSnapped && bounds.y <= topEdge + SNAP_THRESHOLD && !cameFromSnap) {
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
      cameFromSnap = false;
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

  mainWindow.on('closed', () => { debugLog('window closed'); mainWindow = null; });
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
    isHoverExpanded = false;
    preHoverBounds = null;
    stopHoverLeavePoll();

    if (collapsed && cameFromSnap) {
      // Snap back instead of collapsing
      cameFromSnap = false;
      isSnapped = true;
      const bounds = mainWindow.getBounds();
      const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
      const cx = bounds.x + Math.round(bounds.width / 2);
      mainWindow.setBounds({
        x: cx - Math.round(SNAPPED_SIZE.width / 2),
        y: display.bounds.y,
        width: SNAPPED_SIZE.width,
        height: SNAPPED_SIZE.height,
      }, true);
      mainWindow.webContents.send('snap-changed', true);
      return true;
    }

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

  ipcMain.handle('expand-from-snap', () => {
    if (!isSnapped || !mainWindow) return false;
    isHoverExpanded = false;
    stopHoverLeavePoll();
    cameFromSnap = true;
    isSnapped = false;
    isSnapping = true; // prevent checkSnap from re-snapping
    const bounds = mainWindow.getBounds();
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
    const cx = bounds.x + Math.round(bounds.width / 2);
    mainWindow.setBounds({
      x: cx - Math.round(EXPANDED_SIZE.width / 2),
      y: display.bounds.y,
      width: EXPANDED_SIZE.width,
      height: EXPANDED_SIZE.height,
    }, true);
    isSnapping = false;
    mainWindow.webContents.send('snap-changed', false);
    return true;
  });

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
    return collapseHoverPreview();
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
  // createTrayIcon();
  const data = loadData();
  // app.setLoginItemSettings({ openAtLogin: data.preferences?.autoLaunch ?? true });
});

app.on('window-all-closed', () => { debugLog('window-all-closed'); /* keep alive in tray */ });

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});

app.on('before-quit', () => { debugLog('before-quit'); isQuitting = true; });
app.on('quit', (_event, code) => { debugLog(`quit ${code}`); });
process.on('uncaughtException', (err) => debugLog(`uncaught ${err.stack || err.message}`));
process.on('unhandledRejection', (reason) => debugLog(`unhandled ${reason && reason.stack ? reason.stack : reason}`));
