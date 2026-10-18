import { app, BrowserWindow, screen, shell, session, desktopCapturer, type BrowserWindowConstructorOptions, type WebContents } from "electron"
import path from "path"
import fs from "fs"
import { initializeIpcHandlers } from "./ipcHandlers"
import { ProcessingHelper } from "./ProcessingHelper"
import { PROCESSING_EVENTS, type AppView, type IProcessingHelperDeps, type IShortcutsHelperDeps, type ProblemInfo } from "./contracts"
import { ScreenshotHelper } from "./ScreenshotHelper"
import { ShortcutsHelper } from "./shortcuts"
import { initAutoUpdater } from "./autoUpdater"
import { configHelper } from "./ConfigHelper"
import { ensureInterviewContextFile } from "./InterviewContextHelper"
import { VoiceRecognitionHelper } from "./VoiceRecognitionHelper"
import { MouseShakeDetector } from "./MouseShakeDetector"
import { ChatService } from "./ChatService"
import { CompanionServer } from "./CompanionServer"
import { installCrashRecovery, requestAppRestart } from "./CrashRecovery"
import { describeApiUsageTotals } from "./ApiTelemetry"
import {
  initializeMainLogging,
  logFromRendererConsole,
  logShutdown,
  mainLog
} from "./logger"
import * as dotenv from "dotenv"

// Constants
const isDev = process.env.NODE_ENV === "development"
const appIconPath = path.join(app.getAppPath(), "assets", "icons", "steam.svg")

app.setName("steamgamecode")
if (process.platform === "win32") {
  app.setAppUserModelId("com.pandoraq.steamgamecode")
}

// 启动日志：越早初始化越好，之后主进程所有 console.* 也会写入日志文件
initializeMainLogging()
installCrashRecovery()

const allowedExternalHosts = ["google.com"]

function configureWebContents(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const hostname = new URL(url).hostname.toLowerCase()
      if (
        allowedExternalHosts.includes(hostname) ||
        hostname.endsWith(".google.com")
      ) {
        void shell.openExternal(url)
      }
    } catch {
      console.warn("Blocked malformed window URL")
    }

    // Never create an unprotected Electron child window for remote content.
    return { action: "deny" }
  })

  contents.on("will-attach-webview", (event) => {
    event.preventDefault()
  })
}

app.on("web-contents-created", (_event, contents) => {
  configureWebContents(contents)
})

app.on("browser-window-created", (_event, window) => {
  window.setContentProtection(true)
  window.on("show", () => window.setContentProtection(true))
})
// Application State

const state = {
  // Window management properties
  mainWindow: null as BrowserWindow | null,
  isWindowVisible: false,
  windowPosition: null as { x: number; y: number } | null,
  windowSize: null as { width: number; height: number } | null,
  screenWidth: 0,
  screenHeight: 0,
  step: 0,
  currentX: 0,
  currentY: 0,

  // Application helpers
  screenshotHelper: null as ScreenshotHelper | null,
  shortcutsHelper: null as ShortcutsHelper | null,
  processingHelper: null as ProcessingHelper | null,
  voiceRecognitionHelper: null as VoiceRecognitionHelper | null,
  mouseShakeDetector: null as MouseShakeDetector | null,
  chatService: null as ChatService | null,
  companionServer: null as CompanionServer | null,

  // View and state management
  view: "queue" as AppView,
  problemInfo: null as ProblemInfo | null,
  hasDebugged: false,

  // Processing events
  PROCESSING_EVENTS
}

// Initialize helpers
function initializeHelpers() {
  state.screenshotHelper = new ScreenshotHelper(state.view)
  state.voiceRecognitionHelper = new VoiceRecognitionHelper(
    getMainWindow,
    (channel, payload) => state.companionServer?.publish(channel, payload)
  )
  state.processingHelper = new ProcessingHelper({
    getScreenshotHelper,
    getMainWindow,
    getView,
    setView,
    getProblemInfo,
    setProblemInfo,
    getScreenshotQueue,
    getExtraScreenshotQueue,
    clearQueues,
    takeScreenshot,
    getImagePreview,
    deleteScreenshot,
    setHasDebugged,
    getHasDebugged,
    PROCESSING_EVENTS: state.PROCESSING_EVENTS
  } as IProcessingHelperDeps)

  state.chatService = new ChatService({
    getMainWindow,
    onEvent: (channel, payload) => state.companionServer?.publish(channel, payload),
    onMessageAccepted: ({ acceptedImagePaths, persistedImagePaths }) => {
      state.screenshotHelper?.consumeScreenshots(
        acceptedImagePaths,
        persistedImagePaths
      )
    }
  })

  state.shortcutsHelper = new ShortcutsHelper({
    getMainWindow,
    takeScreenshot,
    getImagePreview,
    processingHelper: state.processingHelper,
    chatService: state.chatService,
    voiceRecognitionHelper: state.voiceRecognitionHelper,
    getScreenshotQueue,
    getExtraScreenshotQueue,
    getView,
    clearQueues,
    setView,
    isVisible: () => state.isWindowVisible,
    toggleMainWindow,
    moveWindowLeft: () =>
      moveWindowHorizontal((x) =>
        Math.max(-(state.windowSize?.width || 0) / 2, x - state.step)
      ),
    moveWindowRight: () =>
      moveWindowHorizontal((x) =>
        Math.min(
          state.screenWidth - (state.windowSize?.width || 0) / 2,
          x + state.step
        )
      ),
    moveWindowUp: () => moveWindowVertical((y) => y - state.step),
    moveWindowDown: () => moveWindowVertical((y) => y + state.step),
    resetWindowPosition
  } as IShortcutsHelperDeps)

  state.mouseShakeDetector = new MouseShakeDetector({
    onTrigger: () => {
      console.log("Rapid mouse shake detected. Toggling window visibility.")
      toggleMainWindow()
    }
  })
  state.companionServer = new CompanionServer({
    getChatService: () => state.chatService,
    getVoiceRecognitionHelper: () => state.voiceRecognitionHelper,
    getScreenshotPaths: () => state.view === "queue" ? getScreenshotQueue() : getExtraScreenshotQueue(),
    takeScreenshot,
    getImagePreview,
    deleteScreenshot,
    notifyScreenshotTaken: (filepath, preview) => {
      const mainWindow = getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("screenshot-taken", { path: filepath, preview })
      }
    },
    notifySessionSelected: (session) => {
      const mainWindow = getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("companion-session-selected", session)
      }
    },
    getStaticDirectory: () => path.resolve(__dirname, "../dist/mobile")
  })
  state.companionServer.onStatusChange((status) => {
    const mainWindow = getMainWindow()
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("companion-status", status)
  })
  app.once("will-quit", () => {
    state.mouseShakeDetector?.stop()
    void state.companionServer?.stop()
  })
}

// Auth callback handler

// Register the interview-coder protocol. Packaged Windows builds must use
// the executable itself without passing a script path as an argument.
if (process.platform === "darwin") {
  app.setAsDefaultProtocolClient("interview-coder")
} else if (process.defaultApp && process.argv[1]) {
  app.setAsDefaultProtocolClient("interview-coder", process.execPath, [
    path.resolve(process.argv[1])
  ])
} else {
  app.setAsDefaultProtocolClient("interview-coder")
}

// Auth callback removed as we no longer use Supabase authentication

// Window management functions
async function createWindow(): Promise<void> {
  if (state.mainWindow) {
    if (state.mainWindow.isMinimized()) state.mainWindow.restore()
    state.mainWindow.focus()
    return
  }

  const primaryDisplay = screen.getPrimaryDisplay()

  session.defaultSession.setPermissionCheckHandler((_webContents, permission) =>
    permission === "media"
  )
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      const mediaTypes = details.mediaTypes || []
      callback(permission === "media" && (mediaTypes.length === 0 || mediaTypes.includes("audio")))
    }
  )
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 0, height: 0 }
      })
      const primarySource = sources.find((source) =>
        source.display_id === String(primaryDisplay.id)
      ) || sources[0]
      if (!primarySource) {
        callback({})
        return
      }
      callback({ video: primarySource, audio: "loopback" })
    } catch (error) {
      console.error("Unable to grant system audio capture:", error)
      callback({})
    }
  })
  const workArea = primaryDisplay.workAreaSize
  state.screenWidth = workArea.width
  state.screenHeight = workArea.height
  state.step = 60
  state.currentY = 50

  const windowSettings: BrowserWindowConstructorOptions = {
    title: "steamgamecode",
    icon: appIconPath,
    width: 1200,
    height: 900,
    minWidth: 800,
    minHeight: 800,
    x: state.currentX,
    y: 50,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: isDev
        ? path.join(__dirname, "../dist-electron/preload.js")
        : path.join(__dirname, "preload.js"),
      scrollBounce: true
    },
    show: true,
    frame: false,
    transparent: true,
    fullscreenable: false,
    hasShadow: false,
    opacity: 1.0,  // Start with full opacity
    backgroundColor: "#00000000",
    focusable: true,
    skipTaskbar: process.platform === "darwin",
    type: process.platform === "darwin" ? "panel" : undefined,
    paintWhenInitiallyHidden: true,
    titleBarStyle: process.platform === "darwin" ? "hidden" : undefined,
    enableLargerThanScreen: process.platform === "darwin",
    movable: true
  }

  const mainWindow = new BrowserWindow(windowSettings)
  state.mainWindow = mainWindow
  mainWindow.setContentProtection(true)
  mainLog.info(
    `主窗口已创建 id=${mainWindow.id} size=${windowSettings.width}x${windowSettings.height}`
  )

  // Add more detailed logging for window events
  // 前端（渲染进程）控制台输出统一写入日志文件
  mainWindow.webContents.on(
    "console-message",
    (_event, level, message, line, sourceId) => {
      logFromRendererConsole(
        level,
        message,
        sourceId ? `${sourceId}:${line}` : undefined
      )
    }
  )

  mainWindow.webContents.on("did-finish-load", () => {
    console.log("Window finished loading")
    mainLog.info("渲染进程加载完成", mainWindow?.webContents.getURL())
    // Chromium persists per-host zoom levels across sessions. Reset zoom on
    // every successful load so the window always matches the rendered content.
    mainWindow?.webContents.setZoomFactor(1)
  })
  mainWindow.webContents.on(
    "did-fail-load",
    async (event, errorCode, errorDescription) => {
      console.error("Window failed to load:", errorCode, errorDescription)
      if (isDev) {
        // In development, retry loading after a short delay
        console.log("Retrying to load development server...")
        setTimeout(() => {
          mainWindow?.loadURL("http://localhost:54321").catch((error) => {
            console.error("Failed to load dev server on retry:", error)
          })
        }, 1000)
      }
    }
  )

  if (isDev) {
    // In development, load from the dev server
    console.log("Loading from development server: http://localhost:54321")
    mainWindow.loadURL("http://localhost:54321").catch((error) => {
      console.error("Failed to load dev server, falling back to local file:", error)
      // Fallback to local file if dev server is not available
      const indexPath = path.join(__dirname, "../dist/index.html")
      console.log("Falling back to:", indexPath)
      if (fs.existsSync(indexPath)) {
        mainWindow.loadFile(indexPath)
      } else {
        console.error("Could not find index.html in dist folder")
      }
    })
  } else {
    // In production, load from the built files
    const indexPath = path.join(__dirname, "../dist/index.html")
    console.log("Loading production build:", indexPath)
    
    if (fs.existsSync(indexPath)) {
      mainWindow.loadFile(indexPath)
    } else {
      console.error("Could not find index.html in dist folder")
    }
  }

  // Configure window behavior
  mainWindow.webContents.setZoomFactor(1)
  if (isDev && process.env.OPEN_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools()
  }
  configureWebContents(mainWindow.webContents)

  // Enhanced screen capture resistance

  if (process.platform !== "win32") {
    mainWindow.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true
    })
  }
  mainWindow.setAlwaysOnTop(
      true,
      process.platform === "darwin" ? "screen-saver" : "floating",
      1
    )

  // Additional screen capture resistance settings
  if (process.platform === "darwin") {
    // Prevent window from being captured in screenshots
    mainWindow.setHiddenInMissionControl(true)
    mainWindow.setWindowButtonVisibility(false)
    mainWindow.setBackgroundColor("#00000000")

    // Prevent window from being included in window switcher
    mainWindow.setSkipTaskbar(true)

    // Disable window shadow
    mainWindow.setHasShadow(false)
  }

  // Prevent the window from being captured by screen recording
  mainWindow.webContents.setBackgroundThrottling(false)
  mainWindow.webContents.setFrameRate(60)

  // Set up window listeners
  mainWindow.on("move", handleWindowMove)
  mainWindow.on("resize", handleWindowResize)
  mainWindow.on("closed", handleWindowClosed)

  // Initialize window state
  const bounds = mainWindow.getBounds()
  state.windowPosition = { x: bounds.x, y: bounds.y }
  state.windowSize = { width: bounds.width, height: bounds.height }
  state.currentX = bounds.x
  state.currentY = bounds.y
  state.isWindowVisible = true
  
  // Set opacity based on user preferences or hide initially
  // Ensure the window is visible for the first launch or if opacity >= 0.1
  const savedOpacity = configHelper.getOpacity();
  console.log(`Initial opacity from config: ${savedOpacity}`);
  
  // Always make sure window is shown first
  mainWindow.showInactive(); // Use showInactive for consistency
  
  if (savedOpacity < 0.1) {
    console.log('Initial opacity below minimum, setting to 0 and hiding window');
    mainWindow.setOpacity(0);
    state.isWindowVisible = false;
  } else {
    console.log(`Setting initial opacity to ${savedOpacity}`);
    mainWindow.setOpacity(savedOpacity);
    state.isWindowVisible = true;
  }
}

function handleWindowMove(): void {
  if (!state.mainWindow) return
  const bounds = state.mainWindow.getBounds()
  state.windowPosition = { x: bounds.x, y: bounds.y }
  state.currentX = bounds.x
  state.currentY = bounds.y
}

function handleWindowResize(): void {
  if (!state.mainWindow) return
  const bounds = state.mainWindow.getBounds()
  state.windowSize = { width: bounds.width, height: bounds.height }
}

function handleWindowClosed(): void {
  state.mainWindow = null
  state.isWindowVisible = false
  state.windowPosition = null
  state.windowSize = null
}

// Window visibility functions
function hideMainWindow(): void {
  const mainWindow = state.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return
  const bounds = mainWindow.getBounds();
    state.windowPosition = { x: bounds.x, y: bounds.y };
    state.windowSize = { width: bounds.width, height: bounds.height };
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
    mainWindow.setOpacity(0);
    state.isWindowVisible = false;
  console.log('Window hidden, opacity set to 0');
}

function showMainWindow(): void {
  const mainWindow = state.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (state.windowPosition && state.windowSize) {
      mainWindow.setBounds({
        ...state.windowPosition,
        ...state.windowSize
      });
    }
    mainWindow.setIgnoreMouseEvents(false);
    mainWindow.setAlwaysOnTop(
      true,
      process.platform === "darwin" ? "screen-saver" : "floating",
      1
    );
    if (process.platform !== "win32") {
      mainWindow.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true
      });
    }
    mainWindow.setContentProtection(true);
    mainWindow.setOpacity(0); // Set opacity to 0 before showing
    mainWindow.showInactive(); // Use showInactive instead of show+focus
    const savedOpacity = configHelper.getOpacity()
    mainWindow.setOpacity(savedOpacity); // Restore the user-configured opacity
    state.isWindowVisible = true;
  console.log(`Window shown with showInactive(), opacity set to ${savedOpacity}`);
}

function toggleMainWindow(): void {
  console.log(`Toggling window. Current state: ${state.isWindowVisible ? 'visible' : 'hidden'}`);
  if (state.isWindowVisible) {
    hideMainWindow();
  } else {
    showMainWindow();
  }
}

// Window movement functions
function moveWindowHorizontal(updateFn: (x: number) => number): void {
  if (!state.mainWindow) return
  state.currentX = updateFn(state.currentX)
  state.mainWindow.setPosition(
    Math.round(state.currentX),
    Math.round(state.currentY)
  )
}

function moveWindowVertical(updateFn: (y: number) => number): void {
  const mainWindow = state.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return

  const newY = updateFn(state.currentY)
  // Allow window to go 2/3 off screen in either direction
  const maxUpLimit = (-(state.windowSize?.height || 0) * 2) / 3
  const maxDownLimit =
    state.screenHeight + ((state.windowSize?.height || 0) * 2) / 3

  // Log the current state and limits
  console.log({
    newY,
    maxUpLimit,
    maxDownLimit,
    screenHeight: state.screenHeight,
    windowHeight: state.windowSize?.height,
    currentY: state.currentY
  })

  // Only update if within bounds
  if (newY >= maxUpLimit && newY <= maxDownLimit) {
    state.currentY = newY
    mainWindow.setPosition(
      Math.round(state.currentX),
      Math.round(state.currentY)
    )
  }
}

function resetWindowPosition(): void {
  const mainWindow = state.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return
  state.currentX = 0
    state.currentY = 50
    mainWindow.setPosition(state.currentX, state.currentY)
  console.log("Window position reset to default: x=0, y=50")
}

// Window dimension functions
function setWindowDimensions(width: number, height: number): void {
  const mainWindow = state.mainWindow
  if (!mainWindow || mainWindow.isDestroyed()) return
  const [currentX, currentY] = mainWindow.getPosition()
    const primaryDisplay = screen.getPrimaryDisplay()
    const workArea = primaryDisplay.workAreaSize
    const maxWidth = Math.floor(workArea.width * 0.5)

    mainWindow.setBounds({
      x: Math.min(currentX, workArea.width - maxWidth),
      y: currentY,
      width: Math.min(width, maxWidth),
    height: Math.ceil(height)
  })
}

// Environment setup
function loadEnvVariables() {
  if (isDev) {
    console.log("Loading env variables from:", path.join(process.cwd(), ".env"))
    dotenv.config({ path: path.join(process.cwd(), ".env") })
  } else {
    console.log(
      "Loading env variables from:",
      path.join(process.resourcesPath, ".env")
    )
    dotenv.config({ path: path.join(process.resourcesPath, ".env") })
  }
  console.log("Environment variables loaded for open-source version")
}

// Initialize application
async function initializeApp() {
  try {
    mainLog.info("应用就绪，开始初始化")

    // Set custom cache directory to prevent permission issues
    const appDataPath = path.join(app.getPath('appData'), 'interview-coder-v1')
    const sessionPath = path.join(appDataPath, 'session')
    const tempPath = path.join(appDataPath, 'temp')
    const cachePath = path.join(appDataPath, 'cache')
    
    // Create directories if they don't exist
    for (const dir of [appDataPath, sessionPath, tempPath, cachePath]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
    }
    
    app.setPath('userData', appDataPath)
    app.setPath('sessionData', sessionPath)      
    app.setPath('temp', tempPath)
    app.setPath('cache', cachePath)
    mainLog.info(`用户数据目录 ${appDataPath}`)
      
    loadEnvVariables()

    const startupConfig = configHelper.loadConfig()
    const interviewContextPath = ensureInterviewContextFile(startupConfig.interviewContextPath)
    if (startupConfig.interviewContextPath !== interviewContextPath) {
      configHelper.updateConfig({ interviewContextPath })
    }
    
    // Ensure a configuration file exists
    if (!configHelper.hasApiKey()) {
      console.log("No API key found in configuration. User will need to set up.")
    }
    
    mainLog.info("初始化功能模块")
    initializeHelpers()
    initializeIpcHandlers({
      getMainWindow,
      setWindowDimensions,
      getScreenshotQueue,
      getExtraScreenshotQueue,
      deleteScreenshot,
      getImagePreview,
      processingHelper: state.processingHelper,
      chatService: state.chatService,
      voiceRecognitionHelper: state.voiceRecognitionHelper,
      PROCESSING_EVENTS: state.PROCESSING_EVENTS,
      takeScreenshot,
      getView,
      toggleMainWindow,
      clearQueues,
      setView,
      setProblemInfo,
      moveWindowLeft: () =>
        moveWindowHorizontal((x) =>
          Math.max(-(state.windowSize?.width || 0) / 2, x - state.step)
        ),
      moveWindowRight: () =>
        moveWindowHorizontal((x) =>
          Math.min(
            state.screenWidth - (state.windowSize?.width || 0) / 2,
            x + state.step
          )
        ),
      moveWindowUp: () => moveWindowVertical((y) => y - state.step),
      moveWindowDown: () => moveWindowVertical((y) => y + state.step),
      companionServer: state.companionServer
    })
    state.shortcutsHelper?.registerGlobalShortcuts()
    await createWindow()
    mainLog.info("主窗口创建完成")
    state.mouseShakeDetector?.start()

    // Initialize auto-updater regardless of environment
    initAutoUpdater()
    console.log(
      "Auto-updater initialized in",
      isDev ? "development" : "production",
      "mode"
    )
  } catch (error) {
    mainLog.error("应用启动失败，准备重启:", error)
    requestAppRestart("startup-failure", error)
  }
}

// Auth callback handling removed - no longer needed
app.on("open-url", (event, url) => {
  console.log("open-url event received:", url)
  event.preventDefault()
})

// Prevent multiple instances and handle protocol/second-instance launches.
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on("second-instance", (_event, commandLine) => {
    const protocolUrl = commandLine.find((argument) =>
      argument.toLowerCase().startsWith("interview-coder://")
    )
    if (protocolUrl) console.log("Protocol URL received:", protocolUrl)
    mainLog.info("检测到第二个实例启动", commandLine)

    if (!state.mainWindow) {
      void createWindow()
      return
    }

    if (state.mainWindow.isMinimized()) state.mainWindow.restore()
    showMainWindow()
    if (process.platform === "win32") {
      state.mainWindow.show()
      state.mainWindow.focus()
    }
  })

  app.on("window-all-closed", () => {
    mainLog.info("所有窗口已关闭")
    if (process.platform !== "darwin") {
      app.quit()
      state.mainWindow = null
    }
  })
}

app.on("activate", () => {
  mainLog.info("应用被激活")
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

// State getter/setter functions
function getMainWindow(): BrowserWindow | null {
  return state.mainWindow
}

function getView(): AppView {
  return state.view
}

function setView(view: AppView): void {
  state.view = view
  state.screenshotHelper?.setView(view)
}

function getScreenshotHelper(): ScreenshotHelper | null {
  return state.screenshotHelper
}

function getProblemInfo(): ProblemInfo | null {
  return state.problemInfo
}

function setProblemInfo(problemInfo: ProblemInfo | null): void {
  state.problemInfo = problemInfo
}

function getScreenshotQueue(): string[] {
  return state.screenshotHelper?.getScreenshotQueue() || []
}

function getExtraScreenshotQueue(): string[] {
  return state.screenshotHelper?.getExtraScreenshotQueue() || []
}

function clearQueues(): void {
  state.screenshotHelper?.clearQueues()
  state.problemInfo = null
  setView("queue")
  state.companionServer?.publish("refresh")
}

async function takeScreenshot(): Promise<string> {
  if (!state.mainWindow) throw new Error("No main window available")
  const screenshotPath = await (
    state.screenshotHelper?.takeScreenshot(
      () => hideMainWindow(),
      () => showMainWindow()
    ) || ""
  )
  if (screenshotPath) state.companionServer?.publish("refresh")
  return screenshotPath
}

async function getImagePreview(filepath: string): Promise<string> {
  return state.screenshotHelper?.getImagePreview(filepath) || ""
}

async function deleteScreenshot(
  path: string
): Promise<{ success: boolean; error?: string }> {
  const result = await (
    state.screenshotHelper?.deleteScreenshot(path) || {
      success: false,
      error: "Screenshot helper not initialized"
    }
  )
  if (result.success) state.companionServer?.publish("refresh")
  return result
}

function setHasDebugged(value: boolean): void {
  state.hasDebugged = value
}

function getHasDebugged(): boolean {
  return state.hasDebugged
}

// Export state and functions for other modules
export {
  state,
  createWindow,
  hideMainWindow,
  showMainWindow,
  toggleMainWindow,
  setWindowDimensions,
  moveWindowHorizontal,
  moveWindowVertical,
  getMainWindow,
  getView,
  setView,
  getScreenshotHelper,
  getProblemInfo,
  setProblemInfo,
  getScreenshotQueue,
  getExtraScreenshotQueue,
  clearQueues,
  takeScreenshot,
  getImagePreview,
  deleteScreenshot,
  setHasDebugged,
  getHasDebugged
}

// 退出日志
app.on("before-quit", () => {
  logShutdown("before-quit")
})

app.on("quit", () => {
  // 退出前汇总本次运行的模型调用量，便于事后判断异常比例
  try {
    const summary = describeApiUsageTotals()
    if (summary) mainLog.info(`[api] == 本次运行调用统计 ${summary}`)
  } catch {
    /* 统计失败不影响退出 */
  }
  logShutdown("quit")
})

app.whenReady().then(initializeApp)
