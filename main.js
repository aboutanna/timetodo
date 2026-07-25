'use strict';

const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage, nativeTheme, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

/* ── Config (persist pinned state + theme across launches) ── */
const CONFIG_PATH = path.join(app.getPath('userData'), 'sidebar-config.json');
function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw);
    const theme = ['light', 'dark', 'system'].includes(cfg.theme) ? cfg.theme : 'system';
    return { pinned: !!cfg.pinned, theme };
  } catch {
    return { pinned: false, theme: 'system' };
  }
}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify({ pinned, theme })); } catch { /* ignore */ }
}

/* ── Tunables ── */
const SIDEBAR_WIDTH   = 560;   // wide enough that the time-column/card layout
                                // and the 2–4 col todo grid don't get squeezed
                                // or fall into the mobile-narrow CSS breakpoint
const EDGE_WIDTH       = 6;    // invisible hover-trigger strip at the screen edge
const ANIM_MS          = 220;  // slide duration
const ANIM_FPS         = 60;
const AUTO_HIDE_DELAY  = 260;  // ms after the cursor leaves before auto-hiding (unpinned only)

let sidebarWin = null;
let edgeWin    = null;
let tray       = null;

let pinned  = false;
let theme   = 'system'; // 'light' | 'dark' | 'system'
let visible = false;
let hideTimer   = null;
let animTimer   = null;
let appQuitting = false;

function workArea() {
  return screen.getPrimaryDisplay().workArea; // { x, y, width, height }
}

/* ── Window creation ── */
function createSidebarWindow() {
  const wa = workArea();
  sidebarWin = new BrowserWindow({
    title: '',
    width: SIDEBAR_WIDTH,
    height: wa.height,
    x: wa.x - SIDEBAR_WIDTH, // always start off-screen; shown explicitly below
    y: wa.y,
    frame: true,              // real OS window chrome — no frameless/borderless look
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,               // collapsed = window isn't shown at all, not just moved off-canvas
    backgroundColor: '#faf9f5',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  sidebarWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  sidebarWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  sidebarWin.setAlwaysOnTop(true, 'floating');

  // Clicking the window's own close button hides it (like the tray/auto-hide
  // behaviour) instead of quitting the whole app — quitting only happens via
  // the tray menu's "退出".
  sidebarWin.on('close', (e) => {
    if (!appQuitting) {
      e.preventDefault();
      pinned = false;
      saveConfig();
      updateEdgeVisibility();
      updateTrayMenu();
      hideSidebarNow();
    }
  });
  sidebarWin.on('closed', () => { sidebarWin = null; });

  if (pinned) showSidebar(); else visible = false;
}

function createEdgeWindow() {
  const wa = workArea();
  edgeWin = new BrowserWindow({
    width: EDGE_WIDTH,
    height: wa.height,
    x: wa.x,
    y: wa.y,
    frame: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  edgeWin.loadFile(path.join(__dirname, 'edge', 'edge.html'));
  edgeWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  edgeWin.setIgnoreMouseEvents(false);
  edgeWin.on('closed', () => { edgeWin = null; });
  updateEdgeVisibility();
}

function updateEdgeVisibility() {
  if (!edgeWin) return;
  // The trigger strip is only needed while auto-hide is active (unpinned).
  if (pinned) edgeWin.hide(); else edgeWin.showInactive();
}

/* ── Slide animation (cross-platform; BrowserWindow.setBounds has no native
   animation on Windows/Linux, so we step it manually with an ease-out). ── */
function animateTo(targetX, onDone) {
  if (!sidebarWin) return;
  clearInterval(animTimer);
  const wa = workArea();
  const start = sidebarWin.getBounds().x;
  const dist = targetX - start;
  if (dist === 0) { onDone && onDone(); return; }
  const steps = Math.max(1, Math.round(ANIM_MS / (1000 / ANIM_FPS)));
  let i = 0;
  animTimer = setInterval(() => {
    i += 1;
    const t = Math.min(1, i / steps);
    const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
    const x = Math.round(start + dist * eased);
    if (sidebarWin) sidebarWin.setBounds({ x, y: wa.y, width: SIDEBAR_WIDTH, height: wa.height });
    if (t >= 1) {
      clearInterval(animTimer);
      if (sidebarWin) sidebarWin.setBounds({ x: targetX, y: wa.y, width: SIDEBAR_WIDTH, height: wa.height });
      onDone && onDone();
    }
  }, 1000 / ANIM_FPS);
}

function showSidebar() {
  if (!sidebarWin || visible) return;
  clearTimeout(hideTimer);
  visible = true;
  const wa = workArea();
  // Make sure it's positioned just off-screen before revealing, then slide in.
  sidebarWin.setBounds({ x: wa.x - SIDEBAR_WIDTH, y: wa.y, width: SIDEBAR_WIDTH, height: wa.height });
  sidebarWin.showInactive();
  animateTo(wa.x);
}

function hideSidebarNow() {
  // Immediately collapse — used for the close-button / pin-off shortcut path.
  clearInterval(animTimer);
  visible = false;
  if (sidebarWin) sidebarWin.hide();
}

function hideSidebar() {
  if (!sidebarWin || pinned || !visible) return;
  visible = false;
  const wa = workArea();
  animateTo(wa.x - SIDEBAR_WIDTH, () => {
    // Fully collapse — hide the window instead of merely leaving it parked
    // off-canvas, so nothing (chrome, shadow, etc.) lingers on screen.
    if (sidebarWin && !visible) sidebarWin.hide();
  });
}

function scheduleHide() {
  if (pinned) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideSidebar, AUTO_HIDE_DELAY);
}
function cancelHide() {
  clearTimeout(hideTimer);
}

/* ── IPC ── */
ipcMain.on('edge:enter', () => showSidebar());
ipcMain.on('sidebar:enter', () => cancelHide());
ipcMain.on('sidebar:leave', () => scheduleHide());
ipcMain.handle('sidebar:get-pinned', () => pinned);
ipcMain.on('sidebar:toggle-pin', () => setPinned(!pinned));

function setTheme(next) {
  if (!['light', 'dark', 'system'].includes(next)) return;
  theme = next;
  // nativeTheme.themeSource drives the CSS `prefers-color-scheme` match in
  // every renderer automatically — the existing @media(prefers-color-scheme)
  // rules in renderer/index.html just work, no per-window messaging needed.
  nativeTheme.themeSource = theme;
  saveConfig();
  updateTrayMenu();
}

function setPinned(next) {
  pinned = next;
  saveConfig();
  updateEdgeVisibility();
  updateTrayMenu();
  if (pinned) {
    showSidebar();
  } else {
    scheduleHide();
  }
  if (sidebarWin) sidebarWin.webContents.send('sidebar:pinned-changed', pinned);
}

/* ── Data import/export (menu-triggered) ──
   The in-window button was removed since the sidebar is a small hover
   panel; export/import now live in the tray menu instead. Reveal the
   sidebar first so the user sees the result (save dialog / confirm
   alert / success message) land somewhere visible.

   Import specifically has to open its file picker from HERE (the main
   process), not by asking the renderer to synthesize a click on an
   <input type="file">. Chromium requires a "user activation" that's
   still in effect on the *page* for that trick to work, and a click on
   a native OS tray menu never touches the page at all — so the old
   approach just silently did nothing when triggered from the tray.
   dialog.showOpenDialog is a native call from main, unaffected by that
   restriction, which is exactly the right tool for a menu-triggered
   action like this. */
function triggerDataAction(channel) {
  showSidebar();
  if (sidebarWin) sidebarWin.webContents.send(channel);
}

async function triggerImportAction(mode) {
  showSidebar();
  if (!sidebarWin) return;
  const result = await dialog.showOpenDialog(sidebarWin, {
    title: '选择要导入的备份文件',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return;
  let content;
  try {
    content = fs.readFileSync(result.filePaths[0], 'utf-8');
  } catch (err) {
    dialog.showErrorBox('导入失败', `无法读取文件：${err.message || err}`);
    return;
  }
  sidebarWin.webContents.send('data:import-file', { mode, content });
}

/* ── Tray (since the window has no taskbar entry / dock icon) ── */
function trayIconImage() {
  const p = path.join(__dirname, 'assets', 'icon.png');
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 18, height: 18 });
}

function updateTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: pinned ? '取消固定' : '固定侧栏', click: () => setPinned(!pinned) },
    { label: visible ? '隐藏侧栏' : '显示侧栏', click: () => (visible ? hideSidebar() : showSidebar()) },
    { type: 'separator' },
    {
      label: '外观',
      submenu: [
        { label: '浅色模式', type: 'radio', checked: theme === 'light', click: () => setTheme('light') },
        { label: '深色模式', type: 'radio', checked: theme === 'dark', click: () => setTheme('dark') },
        { label: '跟随系统', type: 'radio', checked: theme === 'system', click: () => setTheme('system') },
      ],
    },
    {
      label: '数据',
      submenu: [
        { label: '数据导出', click: () => triggerDataAction('data:export') },
        { label: '导入（全覆盖）', click: () => triggerImportAction('overwrite') },
        { label: '导入（仅增加不重复）', click: () => triggerImportAction('merge') },
      ],
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  tray = new Tray(trayIconImage());
  tray.setToolTip('时间线侧栏');
  tray.on('click', () => (visible ? hideSidebar() : showSidebar()));
  updateTrayMenu();
}

/* ── App lifecycle ── */
app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  const cfg = loadConfig();
  pinned = cfg.pinned;
  theme = cfg.theme;
  nativeTheme.themeSource = theme;

  createSidebarWindow();
  createEdgeWindow();
  createTray();

  // Re-layout on display changes (resolution change, monitor added/removed).
  screen.on('display-metrics-changed', relayout);
  screen.on('display-added', relayout);
  screen.on('display-removed', relayout);
});

function relayout() {
  const wa = workArea();
  if (sidebarWin) {
    const x = (pinned || visible) ? wa.x : wa.x - SIDEBAR_WIDTH;
    sidebarWin.setBounds({ x, y: wa.y, width: SIDEBAR_WIDTH, height: wa.height });
  }
  if (edgeWin) {
    edgeWin.setBounds({ x: wa.x, y: wa.y, width: EDGE_WIDTH, height: wa.height });
  }
}

app.on('window-all-closed', () => {
  // This is a persistent sidebar utility — keep running in the tray instead
  // of quitting when its windows close (mirrors dock/taskbar-utility apps).
  if (process.platform !== 'darwin') {
    // no-op: windows are only closed via explicit app.quit()
  }
});

app.on('before-quit', () => {
  appQuitting = true;
  clearInterval(animTimer);
  clearTimeout(hideTimer);
});
