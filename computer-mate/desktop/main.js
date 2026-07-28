'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, screen, nativeImage } = require('electron');
const path = require('path');

let win = null;
let tray = null;

const WIN_W = 220;
const WIN_H = 240;

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    // Start near the bottom-right corner of the screen.
    x: width - WIN_W - 40,
    y: height - WIN_H - 40,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Float above full-screen apps too.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

/* ---- Move the whole window when the pigeon is dragged ---- */
ipcMain.on('mate:drag', (_e, { dx, dy }) => {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});

/* ---- Renderer asks to quit / actions via right-click menu ---- */
ipcMain.on('mate:quit', () => app.quit());

function buildTray() {
  // A tiny transparent-friendly icon; falls back gracefully if missing.
  let img = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png'));
  if (img.isEmpty()) img = nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('Computer Mate · 마테');
  const menu = Menu.buildFromTemplate([
    { label: '한마디 건네기', click: () => win && win.webContents.send('mate:talk') },
    { label: '집중 타이머 켜기/끄기', click: () => win && win.webContents.send('mate:focus') },
    { label: '현재 상태', click: () => win && win.webContents.send('mate:status') },
    { type: 'separator' },
    {
      label: '항상 위에 표시',
      type: 'checkbox',
      checked: true,
      click: (item) => win && win.setAlwaysOnTop(item.checked, 'screen-saver')
    },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => win && win.webContents.send('mate:talk'));
}

app.whenReady().then(() => {
  createWindow();
  buildTray();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Keep running in the tray even if the window is closed.
app.on('window-all-closed', () => {});
