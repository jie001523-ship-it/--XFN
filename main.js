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
const EXPANDED_SIZE = { width: 540, height: 700 };

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
  const isCollapsed = data.preferences?.isCollapsed ?? true;
  const size = isCollapsed ? COLLAPSED_SIZE : EXPANDED_SIZE;
  const stored = getStoredBounds();

  const winOpts = {
    width: stored ? stored.width : size.width,
    height: stored ? stored.height : size.height,
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
    winOpts.x = Math.round((sw - size.width) / 2);
    winOpts.y = Math.round((sh - size.height) / 2);
  }

  mainWindow = new BrowserWindow(winOpts);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Save window bounds on move/resize
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const bounds = mainWindow.getBounds();
    const d = loadData();
    d.preferences.windowBounds = bounds;
    saveData(d);
  };
  mainWindow.on('move', saveBounds);
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
  // keep top-center anchored: capsule stays in place, panel grows downward
  const cx = current.x + Math.round(current.width / 2);
  const newX = cx - Math.round(size.width / 2);
  const newY = current.y; // top edge stays put
  mainWindow.setBounds({ x: newX, y: newY, width: size.width, height: size.height }, true);
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
