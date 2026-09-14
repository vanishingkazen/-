import { globalShortcut, app } from "electron"
import { IShortcutsHelperDeps } from "./main"
import { configHelper } from "./ConfigHelper"
import {
  getMacCommandInterceptor,
  type NativeShortcutSpec
} from "./MacCommandInterceptor"

const NATIVE_KEY_CODES: Record<string, number> = {
  "0": 29,
  "-": 27,
  "=": 24,
  "[": 33,
  "]": 30,
  Enter: 36,
  H: 4,
  K: 40,
  L: 37,
  M: 46,
  N: 45,
  Q: 12,
  R: 15,
  Left: 123,
  Right: 124,
  Down: 125,
  Up: 126
}

export class ShortcutsHelper {
  private deps: IShortcutsHelperDeps
  private macInterceptor = getMacCommandInterceptor()
  private useNativeInterceptor = false
  private nativeActionTimer: ReturnType<typeof setInterval> | null = null
  private nativeShortcutSpecs: NativeShortcutSpec[] = []
  private nativeShortcutHandlers = new Map<string, () => void | Promise<void>>()

  constructor(deps: IShortcutsHelperDeps) {
    this.deps = deps
  }

  private invokeShortcut(
    accelerator: string,
    callback: () => void | Promise<void>
  ): void {
    try {
      const result = callback()
      if (result instanceof Promise) {
        void result.catch((error) => {
          console.error(`Shortcut ${accelerator} failed:`, error)
        })
      }
    } catch (error) {
      console.error(`Shortcut ${accelerator} failed:`, error)
    }
  }

  private buildNativeShortcut(accelerator: string): NativeShortcutSpec | null {
    if (process.platform !== "darwin") return null
    if (!accelerator.startsWith("CommandOrControl+") && !accelerator.startsWith("Command+")) {
      return null
    }

    const parts = accelerator.split("+")
    const key = parts[parts.length - 1]
    const keyCode = NATIVE_KEY_CODES[key]
    if (keyCode === undefined) return null

    return {
      action: accelerator,
      keyCode,
      shift: parts.includes("Shift"),
      option: parts.includes("Alt") || parts.includes("Option"),
      control: parts.includes("Control") || parts.includes("Ctrl")
    }
  }

  private initializeNativeInterceptor(): void {
    if (process.platform !== "darwin" || !this.macInterceptor) return

    if (!this.macInterceptor.isTrusted()) {
      console.warn(
        "macOS Command interception needs Accessibility/Input Monitoring permission. Falling back to globalShortcut."
      )
      this.macInterceptor.requestPermission()
      return
    }

    if (!this.macInterceptor.start()) {
      console.warn("Failed to start macOS Command intercept event tap. Falling back to globalShortcut.")
      return
    }

    this.macInterceptor.setEnabled(true)
    this.useNativeInterceptor = true
    this.nativeActionTimer = setInterval(() => this.flushNativeActions(), 15)
    console.log("macOS Command interception enabled")
  }

  private flushNativeActions(): void {
    if (!this.macInterceptor) return
    for (const action of this.macInterceptor.pollActions()) {
      const handler = this.nativeShortcutHandlers.get(action)
      if (handler) this.invokeShortcut(action, handler)
    }
  }

  private finalizeNativeInterceptor(): void {
    if (!this.useNativeInterceptor || !this.macInterceptor) return
    this.macInterceptor.setShortcuts(this.nativeShortcutSpecs)
  }

  private stopNativeInterceptor(): void {
    if (this.nativeActionTimer) {
      clearInterval(this.nativeActionTimer)
      this.nativeActionTimer = null
    }
    this.macInterceptor?.setEnabled(false)
    this.macInterceptor?.stop()
    this.useNativeInterceptor = false
  }

  private registerShortcut(
    accelerator: string,
    callback: () => void | Promise<void>
  ): boolean {
    if (this.useNativeInterceptor) {
      const nativeShortcut = this.buildNativeShortcut(accelerator)
      if (nativeShortcut) {
        this.nativeShortcutHandlers.set(accelerator, callback)
        this.nativeShortcutSpecs.push(nativeShortcut)
        return true
      }
    }

    try {
      const registered = globalShortcut.register(accelerator, () => {
        this.invokeShortcut(accelerator, callback)
      })

      if (!registered) {
        console.warn(`Shortcut ${accelerator} was not registered because it is already in use.`)
      }

      return registered
    } catch (error) {
      console.error(`Shortcut ${accelerator} could not be registered:`, error)
      return false
    }
  }

  private adjustOpacity(delta: number): void {
    const mainWindow = this.deps.getMainWindow();
    if (!mainWindow) return;
    
    let currentOpacity = mainWindow.getOpacity();
    let newOpacity = Math.max(0.1, Math.min(1.0, currentOpacity + delta));
    console.log(`Adjusting opacity from ${currentOpacity} to ${newOpacity}`);
    
    mainWindow.setOpacity(newOpacity);
    
    // Save the opacity setting to config without re-initializing the client
    try {
      const config = configHelper.loadConfig();
      config.opacity = newOpacity;
      configHelper.saveConfig(config);
    } catch (error) {
      console.error('Error saving opacity to config:', error);
    }
    
    // If we're making the window visible, also make sure it's shown and interaction is enabled
    if (newOpacity > 0.1 && !this.deps.isVisible()) {
      this.deps.toggleMainWindow();
    }
  }

  public registerGlobalShortcuts(): void {
    this.nativeShortcutHandlers.clear()
    this.nativeShortcutSpecs = []
    this.initializeNativeInterceptor()

    this.registerShortcut("CommandOrControl+H", async () => {
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        console.log("Taking screenshot...")
        try {
          const screenshotPath = await this.deps.takeScreenshot()
          const preview = await this.deps.getImagePreview(screenshotPath)
          mainWindow.webContents.send("screenshot-taken", {
            path: screenshotPath,
            preview
          })
        } catch (error) {
          console.error("Error capturing screenshot:", error)
        }
      }
    })

    this.registerShortcut("CommandOrControl+Enter", async () => {
      const rawConversation = this.deps.voiceRecognitionHelper?.getConversationTranscript()
      const conversation = rawConversation
        ? await this.deps.processingHelper?.correctVoiceConversation(rawConversation) || rawConversation
        : undefined
      const voiceText = [
        conversation?.systemTranscript ? `用户A（扬声器）：${conversation.systemTranscript}` : "",
        conversation?.microphoneTranscript ? `用户B（麦克风）：${conversation.microphoneTranscript}` : ""
      ].filter(Boolean).join("\n")
      const hasScreenshots = this.deps.getView() === "queue"
        ? this.deps.getScreenshotQueue().length > 0
        : this.deps.getExtraScreenshotQueue().length > 0

      // Ctrl+Enter is a submit shortcut, not an instruction to create an
      // empty screenshot job. With no voice text and no queued image it is a
      // deliberate no-op.
      if (!voiceText && !hasScreenshots) return

      if (voiceText && !hasScreenshots) {
        const requestId = `voice-${Date.now()}`
        this.deps.getMainWindow()?.webContents.send("voice-submit", {
          requestId,
          text: voiceText
        })
        this.deps.voiceRecognitionHelper?.clearTranscript()
        await this.deps.processingHelper?.processChatMessage(requestId, voiceText)
        return
      }

      await this.deps.processingHelper?.processScreenshots(voiceText)
      if (voiceText) this.deps.voiceRecognitionHelper?.clearTranscript()
    })

    this.registerShortcut("CommandOrControl+R", () => {
      console.log(
        "Command + R pressed. Canceling requests and resetting queues..."
      )

      // Cancel ongoing API requests
      this.deps.processingHelper?.cancelOngoingRequests()
      void this.deps.voiceRecognitionHelper?.stop("system")
      void this.deps.voiceRecognitionHelper?.stop("microphone")
      this.deps.voiceRecognitionHelper?.clearTranscript()

      // Clear both screenshot queues
      this.deps.clearQueues()

      console.log("Cleared queues.")

      // Update the view state to 'queue'
      this.deps.setView("queue")

      // Notify renderer process to switch view to 'queue'
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("reset-view")
        mainWindow.webContents.send("reset")
      }
    })

    // New shortcuts for moving the window
    this.registerShortcut("CommandOrControl+Left", () => {
      console.log("Command/Ctrl + Left pressed. Moving window left.")
      this.deps.moveWindowLeft()
    })

    this.registerShortcut("CommandOrControl+Right", () => {
      console.log("Command/Ctrl + Right pressed. Moving window right.")
      this.deps.moveWindowRight()
    })

    this.registerShortcut("CommandOrControl+Down", () => {
      console.log("Command/Ctrl + down pressed. Moving window down.")
      this.deps.moveWindowDown()
    })

    this.registerShortcut("CommandOrControl+Up", () => {
      console.log("Command/Ctrl + Up pressed. Moving window Up.")
      this.deps.moveWindowUp()
    })

    this.registerShortcut("CommandOrControl+Shift+0", () => {
      console.log("Command/Ctrl + Shift + 0 pressed. Resetting window position.")
      this.deps.resetWindowPosition()
    })

    if (process.platform === "darwin") {
      this.registerShortcut("Command+N", () => {
        console.log("Cmd + N pressed. Creating a new chat session.")
        const mainWindow = this.deps.getMainWindow()
        if (!mainWindow || mainWindow.isDestroyed()) return

        // Show without activation; never steal focus from the foreground app.
        if (!this.deps.isVisible()) this.deps.toggleMainWindow()
        mainWindow.webContents.send("new-chat-session")
      })
    }

    this.registerShortcut("/", () => {
      console.log("/ pressed. Toggling window visibility.")
      this.deps.toggleMainWindow()
    })

    this.registerShortcut("CommandOrControl+K", () => {
      console.log("Command/Ctrl + K pressed. Focusing chat input.")
      const mainWindow = this.deps.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) return

      if (!this.deps.isVisible()) this.deps.toggleMainWindow()
      mainWindow.show()
      mainWindow.focus()
      mainWindow.webContents.focus()
      mainWindow.webContents.send("focus-chat-input")
    })

    this.registerShortcut("CommandOrControl+Shift+M", () => {
      console.log("Command/Ctrl + Shift + M pressed. Toggling voice input.")
      const mainWindow = this.deps.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send("toggle-voice-input")
    })

    this.registerShortcut("CommandOrControl+Alt+Up", () => {
      console.log("Command/Ctrl + Alt + Up pressed. Scrolling chat up.")
      const mainWindow = this.deps.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send("scroll-chat", { direction: "up" })
    })

    this.registerShortcut("CommandOrControl+Alt+Down", () => {
      console.log("Command/Ctrl + Alt + Down pressed. Scrolling chat down.")
      const mainWindow = this.deps.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) return
      mainWindow.webContents.send("scroll-chat", { direction: "down" })
    })

    this.registerShortcut("CommandOrControl+Q", () => {
      console.log("Command/Ctrl + Q pressed. Quitting application.")
      app.quit()
    })

    // Adjust opacity shortcuts
    this.registerShortcut("CommandOrControl+[", () => {
      console.log("Command/Ctrl + [ pressed. Decreasing opacity.")
      this.adjustOpacity(-0.1)
    })

    this.registerShortcut("CommandOrControl+]", () => {
      console.log("Command/Ctrl + ] pressed. Increasing opacity.")
      this.adjustOpacity(0.1)
    })
    
    // Zoom controls
    this.registerShortcut("CommandOrControl+-", () => {
      console.log("Command/Ctrl + - pressed. Zooming out.")
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        const currentZoom = mainWindow.webContents.getZoomLevel()
        mainWindow.webContents.setZoomLevel(currentZoom - 0.5)
      }
    })
    
    this.registerShortcut("CommandOrControl+0", () => {
      console.log("Command/Ctrl + 0 pressed. Resetting zoom.")
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        mainWindow.webContents.setZoomLevel(0)
      }
    })
    
    this.registerShortcut("CommandOrControl+=", () => {
      console.log("Command/Ctrl + = pressed. Zooming in.")
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        const currentZoom = mainWindow.webContents.getZoomLevel()
        mainWindow.webContents.setZoomLevel(currentZoom + 0.5)
      }
    })
    
    // Delete last screenshot shortcut
    this.registerShortcut("CommandOrControl+L", () => {
      console.log("Command/Ctrl + L pressed. Deleting last screenshot.")
      const mainWindow = this.deps.getMainWindow()
      if (mainWindow) {
        // Send an event to the renderer to delete the last screenshot
        mainWindow.webContents.send("delete-last-screenshot")
      }
    })
    
    this.finalizeNativeInterceptor()

    // Unregister shortcuts when quitting
    app.on("will-quit", () => {
      this.stopNativeInterceptor()
      globalShortcut.unregisterAll()
    })
  }
}
